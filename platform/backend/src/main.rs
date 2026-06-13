//! GeoQuest backend (Rust + Axum).
//!
//! Event-sourced facts over immutable published snapshots. The chain is
//! grant -> attempt -> facts: attempts are created only for grant holders and
//! bind the latest published snapshot forever; facts append idempotently to
//! known attempts. Balance is a plain fold and may be negative (SPEC); there
//! are no server-side correction facts — clients derive sync notices from
//! projection diffs.
//!
//! Storage: PostgreSQL when DATABASE_URL is set (sqlx migrations run at
//! startup), in-memory otherwise (non-durable; dev/tests). Behavior is
//! identical across backends — the same integration scenarios run on both.

use std::time::Duration;

use anyhow::Context;
use axum::{
    Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Json},
    routing::{get, post},
};
use dotenvy::dotenv;

use tokio::net::TcpListener;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod auth;
mod config;
mod errors;
mod facts;
mod grants;
mod payments;
mod pg_store;
mod store;

use std::sync::{Arc, Mutex};

use config::AppConfig;
use errors::AppError;
use facts::{Fact, MigrationResult, ProjectedState};
use grants::{AccessGrant, GrantSource};
use payments::{MockPaymentProvider, PaymentOutcome, PaymentProvider};
use store::{
    AttemptMeta, AuthStores, FactStores, GrantStores, InMemoryAuthStore, InMemoryFactStore,
    InMemoryGrantStore, PublishedMeta,
};

/// Shared application state.
#[derive(Clone)]
struct AppState {
    config: AppConfig,
    store: FactStores,
    grants: GrantStores,
    auth: AuthStores,
    payments: Arc<dyn PaymentProvider>,
}

fn in_memory_state(config: AppConfig) -> AppState {
    AppState {
        config,
        store: FactStores::InMemory(Arc::new(Mutex::new(InMemoryFactStore::new()))),
        grants: GrantStores::InMemory(Arc::new(Mutex::new(InMemoryGrantStore::new()))),
        auth: AuthStores::InMemory(Arc::new(Mutex::new(InMemoryAuthStore::new()))),
        payments: Arc::new(MockPaymentProvider),
    }
}

/// Resolve the acting player for a player-scoped request (player-identity spec).
///
/// A valid `Authorization: Bearer <token>` wins and must match a non-empty
/// claimed id (mismatch = 403, catches client bugs). Without a token, the
/// claimed id is accepted ONLY while unregistered — once an account exists for
/// it, device possession is no longer a sufficient credential (401).
async fn resolve_player(
    state: &AppState,
    headers: &HeaderMap,
    claimed: &str,
) -> Result<String, AppError> {
    if let Some(value) = headers.get(header::AUTHORIZATION) {
        let raw = value
            .to_str()
            .map_err(|_| AppError::Unauthorized("malformed authorization header".into()))?;
        let token = raw
            .strip_prefix("Bearer ")
            .ok_or_else(|| AppError::Unauthorized("expected a bearer token".into()))?;
        let player = state
            .auth
            .get_session(token)
            .await?
            .ok_or_else(|| AppError::Unauthorized("invalid session".into()))?;
        if !claimed.is_empty() && claimed != player {
            return Err(AppError::Forbidden(
                "session does not match the claimed player".into(),
            ));
        }
        return Ok(player);
    }
    if claimed.is_empty() {
        return Err(AppError::Unauthorized("missing identity".into()));
    }
    if state.auth.get_player(claimed).await?.is_some() {
        return Err(AppError::Unauthorized(
            "registered account requires login (bearer token)".into(),
        ));
    }
    Ok(claimed.to_string())
}

/// Claimed identity for GET endpoints without a body: the `X-Player-Id` header
/// (anonymous devices) — ignored when a Bearer token is present.
fn claimed_from_headers(headers: &HeaderMap) -> String {
    headers
        .get("x-player-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

/// Gate admin-only endpoints (per-version stats/feedbacks, legacy migration)
/// behind the shared `ADMIN_TOKEN` secret carried in `X-Admin-Token`. These
/// surfaces expose aggregate telemetry, raw feedback notes and device ids, so
/// they fail closed: when no secret is configured the endpoints are disabled.
fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expected = state.config.admin_token.as_deref().ok_or_else(|| {
        AppError::Forbidden("admin endpoints are disabled (ADMIN_TOKEN not set)".into())
    })?;
    let provided = headers
        .get("x-admin-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if provided.is_empty() || provided != expected {
        return Err(AppError::Unauthorized("invalid admin token".into()));
    }
    Ok(())
}

/// Health check response for probes and tests.
#[derive(serde::Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

/// Build the application router (extracted for oneshot testing).
fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/api/attempts", post(create_attempt_handler))
        .route(
            "/api/attempts/{attempt_id}/facts",
            post(append_facts_handler),
        )
        .route("/api/attempts/{attempt_id}/state", get(get_state_handler))
        .route("/api/quests", get(list_quests_handler))
        .route("/api/quests/publish", post(publish_quest_handler))
        .route("/api/quests/{quest_id}/bundle", get(get_bundle_handler))
        .route("/api/checkout", post(checkout_handler))
        .route("/api/grants", get(list_grants_handler))
        .route(
            "/api/admin/versions/{snapshot_id}/stats",
            get(get_version_stats_handler),
        )
        .route(
            "/api/admin/versions/{snapshot_id}/feedbacks",
            get(get_version_feedbacks_handler),
        )
        .route("/api/migrate/legacy", post(run_migration_handler))
        .route("/api/measure/rates", get(get_measure_rates_handler))
        .route("/api/auth/register", post(register_handler))
        .route("/api/auth/login", post(login_handler))
        .route("/api/players/me", get(get_me_handler))
        .route("/api/players/me/stats", get(get_my_stats_handler))
        .layer(TraceLayer::new_for_http())
        .layer(build_cors_layer(&state.config.cors_allowed_origins))
        .with_state(state)
}

/// True if `origin` is permitted by the allowlist. Each pattern is either an
/// exact match or a single-`*` wildcard split into (prefix, suffix); the origin
/// must start with the prefix and end with the suffix. Scheme is part of the
/// match, so `http://` never satisfies an `https://` pattern. Pure + total so it
/// can be unit-tested without a server.
fn origin_allowed(allowed: &[String], origin: &str) -> bool {
    allowed.iter().any(|pat| match pat.split_once('*') {
        None => pat == origin,
        Some((prefix, suffix)) => {
            origin.len() >= prefix.len() + suffix.len()
                && origin.starts_with(prefix)
                && origin.ends_with(suffix)
        }
    })
}

/// CORS layer driven by the configured allowlist.
///
/// - Empty allowlist (env unset) → reflect any origin (dev convenience) + warn.
/// - Non-empty → only origins matching [`origin_allowed`] are reflected.
///
/// Allowed methods/headers cover the client surface (JSON + identity headers).
/// Credentials are NOT enabled: the client authenticates via `Authorization`/
/// `X-Player-Id` headers, not cookies, so there is no ambient credential to ride.
fn build_cors_layer(allowed: &[String]) -> CorsLayer {
    use axum::http::{HeaderName, Method};
    use tower_http::cors::AllowOrigin;

    let methods = [Method::GET, Method::POST, Method::OPTIONS];
    let headers = [
        header::CONTENT_TYPE,
        header::AUTHORIZATION,
        HeaderName::from_static("x-player-id"),
        HeaderName::from_static("x-admin-token"),
    ];

    let allow_origin = if allowed.is_empty() {
        tracing::warn!(
            "CORS_ALLOWED_ORIGINS is unset — reflecting ANY origin (dev mode). \
             Set it in production (e.g. https://app.your-domain,https://*.vercel.app)."
        );
        AllowOrigin::mirror_request()
    } else {
        let patterns = allowed.to_vec();
        AllowOrigin::predicate(move |origin, _parts| {
            origin
                .to_str()
                .map(|o| origin_allowed(&patterns, o))
                .unwrap_or(false)
        })
    };

    CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_methods(methods)
        .allow_headers(headers)
}

async fn health_handler(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    Ok((
        StatusCode::OK,
        Json(HealthResponse {
            status: "ok",
            version: state.config.version,
        }),
    ))
}

/// Body for POST /api/attempts.
#[derive(serde::Deserialize, serde::Serialize)]
struct CreateAttemptRequest {
    player_id: String,
    quest_id: String,
}

/// Creates an attempt for a grant holder, bound to the quest's latest published
/// snapshot (the binding never changes — version freeze). 401 for a registered
/// identity without a session, 403 without a grant, 404 for unpublished quests.
async fn create_attempt_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateAttemptRequest>,
) -> Result<Json<AttemptMeta>, AppError> {
    let player_id = resolve_player(&state, &headers, &req.player_id).await?;
    if !state.grants.has_grant(&player_id, &req.quest_id).await? {
        return Err(AppError::Forbidden(format!(
            "no access grant for quest '{}'",
            req.quest_id
        )));
    }
    let snapshot_id = state
        .grants
        .get_published(&req.quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("quest '{}' is not published", req.quest_id)))?
        .snapshot_id;
    let meta = state
        .store
        .create_attempt(&player_id, &req.quest_id, &snapshot_id)
        .await?;
    Ok(Json(meta))
}

/// Body for POST /api/attempts/{id}/facts: a batch of player facts.
#[derive(serde::Deserialize, serde::Serialize)]
struct AppendRequest {
    facts: Vec<Fact>,
}

/// Sync response: newly accepted facts + the authoritative projection. No
/// corrections — clients diff their pre-sync projection against `projected`.
#[derive(serde::Serialize, serde::Deserialize)]
struct SyncResponse {
    accepted: Vec<Fact>,
    projected: ProjectedState,
    snapshot_id: String,
    fact_count: usize,
}

async fn append_facts_handler(
    State(state): State<AppState>,
    Path(attempt_id): Path<String>,
    Json(req): Json<AppendRequest>,
) -> Result<Json<SyncResponse>, AppError> {
    let accepted = state
        .store
        .append_idempotent(&attempt_id, req.facts)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("unknown attempt '{attempt_id}'")))?;
    let (projected, snapshot_id, fact_count) = state
        .store
        .get_projected(&attempt_id)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("attempt vanished mid-request")))?;
    Ok(Json(SyncResponse {
        accepted,
        projected,
        snapshot_id,
        fact_count,
    }))
}

async fn get_state_handler(
    State(state): State<AppState>,
    Path(attempt_id): Path<String>,
) -> Result<Json<SyncResponse>, AppError> {
    let (projected, snapshot_id, fact_count) = state
        .store
        .get_projected(&attempt_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("unknown attempt '{attempt_id}'")))?;
    Ok(Json(SyncResponse {
        accepted: vec![],
        projected,
        snapshot_id,
        fact_count,
    }))
}

#[derive(serde::Deserialize)]
struct CheckoutRequest {
    player_id: String,
    quest_id: String,
    coupon_percent: Option<u8>,
}

#[derive(serde::Serialize)]
struct CheckoutResponse {
    grant: AccessGrant,
    created: bool,
}

/// Checkout behind the PaymentProvider seam (mock approves everything). 100%
/// coupon redeems as CouponRedemption and bypasses the provider; everything
/// else charges the provider and grants as Payment with the payment_ref
/// recorded for audit. Idempotent (first grant + first audit ref win).
async fn checkout_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CheckoutRequest>,
) -> Result<Json<CheckoutResponse>, AppError> {
    let player_id = resolve_player(&state, &headers, &req.player_id).await?;
    let (source, source_ref) = if req.coupon_percent == Some(100) {
        (GrantSource::CouponRedemption, None)
    } else {
        let PaymentOutcome::Approved { payment_ref } =
            state.payments.charge(&player_id, &req.quest_id);
        (GrantSource::Payment, Some(payment_ref))
    };
    let (grant, created) = state
        .grants
        .create_grant_idemp(&player_id, &req.quest_id, source, source_ref)
        .await?;
    Ok(Json(CheckoutResponse { grant, created }))
}

#[derive(serde::Deserialize)]
struct PublishRequest {
    quest_id: String,
    name: String,
    primary_comic: Option<String>,
    template_summary: String,
    snapshot_version: Option<u32>,
    /// Frozen snapshot id new attempts bind to; defaults to "{quest_id}-v{version}".
    snapshot_id: Option<String>,
    /// Full frozen snapshot JSON (stored per version, immutable once set).
    snapshot: Option<serde_json::Value>,
}

async fn publish_quest_handler(
    State(state): State<AppState>,
    Json(req): Json<PublishRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // NOTE: publish is intentionally open to any caller for now (constructor
    // authoring). Author binding + auth is a tracked follow-up; admin telemetry
    // and per-player grants are the gated/scoped surfaces in this change.
    let version = req.snapshot_version.unwrap_or(1);
    let snapshot_id = req
        .snapshot_id
        .unwrap_or_else(|| format!("{}-v{}", req.quest_id, version));
    let meta = PublishedMeta {
        quest_id: req.quest_id.clone(),
        name: req.name,
        primary_comic: req.primary_comic,
        template_summary: req.template_summary,
        snapshot_version: version,
        snapshot_id,
    };
    state
        .grants
        .register_published(&req.quest_id, meta, req.snapshot)
        .await?;
    Ok(Json(
        serde_json::json!({ "status": "published", "quest_id": req.quest_id }),
    ))
}

#[derive(serde::Deserialize)]
struct BundleQuery {
    player_id: String,
}

/// Bundle download primitive: latest frozen snapshot JSON, gated by grant
/// (SPEC: "Grant before attempt/bundle"). Asset packing comes with the media
/// store phase.
async fn get_bundle_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
    Query(q): Query<BundleQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let player_id = resolve_player(&state, &headers, &q.player_id).await?;
    let (meta, snapshot) = state
        .grants
        .get_bundle(&quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("quest '{quest_id}' is not published")))?;
    if !state.grants.has_grant(&player_id, &quest_id).await? {
        return Err(AppError::Forbidden(format!(
            "no access grant for quest '{quest_id}'"
        )));
    }
    Ok(Json(serde_json::json!({
        "quest_id": meta.quest_id,
        "snapshot_id": meta.snapshot_id,
        "snapshot_version": meta.snapshot_version,
        "snapshot": snapshot,
    })))
}

async fn list_quests_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<PublishedMeta>>, AppError> {
    Ok(Json(state.grants.list_published().await?))
}

/// Grants for the resolved caller ONLY. Previously returned every player's
/// grants (incl. payment refs) to anyone — a cross-player data leak. The
/// marketplace/cabinet only ever need the caller's own ownership set.
async fn list_grants_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AccessGrant>>, AppError> {
    let claimed = claimed_from_headers(&headers);
    let player_id = resolve_player(&state, &headers, &claimed).await?;
    Ok(Json(state.grants.grants_for_player(&player_id).await?))
}

async fn get_version_stats_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(snapshot_id): Path<String>,
) -> Result<Json<facts::PerVersionStats>, AppError> {
    require_admin(&state, &headers)?;
    let grants_count = state.grants.list_all_grants().await?.len();
    Ok(Json(
        state
            .store
            .get_version_stats(&snapshot_id, grants_count)
            .await?,
    ))
}

async fn get_version_feedbacks_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(snapshot_id): Path<String>,
) -> Result<Json<Vec<facts::Fact>>, AppError> {
    require_admin(&state, &headers)?;
    Ok(Json(
        state.store.list_feedbacks_for_version(&snapshot_id).await?,
    ))
}

#[derive(serde::Deserialize)]
struct MigrateRequest {
    historical_grants: Option<Vec<serde_json::Value>>,
    answer_cards: Option<Vec<serde_json::Value>>,
    key: Option<String>,
}

async fn run_migration_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<MigrateRequest>,
) -> Result<Json<MigrationResult>, AppError> {
    require_admin(&state, &headers)?;
    let res = state
        .store
        .run_legacy_migration(
            req.historical_grants.unwrap_or_default(),
            req.answer_cards.unwrap_or_default(),
            &req.key.unwrap_or_else(|| "phase4-legacy:default".into()),
        )
        .await?;
    Ok(Json(res))
}

async fn get_measure_rates_handler(
    State(_state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Sync corrections are client-derived (no stored correction facts), so there is
    // no server-side correction rate; bundle measurement comes with the real packer.
    Ok(Json(serde_json::json!({
        "note": "post-MVP measurement: bundle sizes with real assets, ctor velocity, hint/navigator UX feedback",
        "bundle_est_note": "real ~4-5MB with 4-role comics + audio (measure with packer)"
    })))
}

/// Body for POST /api/auth/register: attaches credentials to the caller's
/// existing anonymous player id (the id never changes — zero migration).
#[derive(serde::Deserialize)]
struct RegisterRequest {
    player_id: String,
    email: String,
    password: String,
    display_name: Option<String>,
}

/// Body for POST /api/auth/login.
#[derive(serde::Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

/// Successful register/login: the account identity + a fresh session token.
#[derive(serde::Serialize)]
struct AuthResponse {
    player_id: String,
    email: String,
    display_name: Option<String>,
    token: String,
}

async fn register_handler(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    auth::validate_credentials(&req.email, &req.password)?;
    if req.player_id.is_empty() {
        return Err(AppError::BadRequest("player_id is required".into()));
    }
    let password_hash = auth::hash_password(&req.password)?;
    let account = state
        .auth
        .register_player(&req.player_id, &req.email, &password_hash, req.display_name)
        .await?;
    let token = auth::generate_token();
    state
        .auth
        .create_session(&token, &account.player_id)
        .await?;
    Ok(Json(AuthResponse {
        player_id: account.player_id,
        email: account.email,
        display_name: account.display_name,
        token,
    }))
}

async fn login_handler(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    // One message for both unknown email and wrong password (no oracle).
    let bad = || AppError::Unauthorized("invalid email or password".into());
    let record = state
        .auth
        .find_by_email(&req.email)
        .await?
        .ok_or_else(bad)?;
    if !auth::verify_password(&record.password_hash, &req.password) {
        return Err(bad());
    }
    let token = auth::generate_token();
    state
        .auth
        .create_session(&token, &record.account.player_id)
        .await?;
    Ok(Json(AuthResponse {
        player_id: record.account.player_id,
        email: record.account.email,
        display_name: record.account.display_name,
        token,
    }))
}

/// Profile for the resolved identity: the account when registered, a synthetic
/// anonymous profile otherwise (registered=false).
async fn get_me_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let claimed = claimed_from_headers(&headers);
    let player_id = resolve_player(&state, &headers, &claimed).await?;
    let account = state.auth.get_player(&player_id).await?;
    Ok(Json(match account {
        Some(a) => serde_json::json!({
            "player_id": a.player_id, "registered": true,
            "email": a.email, "display_name": a.display_name,
        }),
        None => serde_json::json!({
            "player_id": player_id, "registered": false,
            "email": null, "display_name": null,
        }),
    }))
}

/// Cross-attempt player statistics: storage gathers the logs, the pure
/// projector folds them (player-stats spec; never re-folded in SQL).
async fn get_my_stats_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<facts::PlayerStats>, AppError> {
    let claimed = claimed_from_headers(&headers);
    let player_id = resolve_player(&state, &headers, &claimed).await?;
    let logs = state.store.attempt_logs_for_player(&player_id).await?;
    let grants_count = state
        .grants
        .list_all_grants()
        .await?
        .iter()
        .filter(|g| g.player_id == player_id)
        .count();
    Ok(Json(facts::project_player_stats(&logs, grants_count)))
}

/// A demo quest embedded at compile time and seeded at startup so a fresh dev
/// server has real published quests with frozen snapshot content.
struct DemoQuest {
    quest_id: &'static str,
    name: &'static str,
    template_summary: &'static str,
    snapshot_id: &'static str,
    primary_comic: Option<&'static str>,
    snapshot_json: &'static str,
}

const DEMO_QUESTS: &[DemoQuest] = &[
    DemoQuest {
        quest_id: "mystery-fortress-v1",
        name: "Mystery of the Fortress",
        template_summary: "4 steps incl. answer task with gift at 2",
        snapshot_id: "golden-mystery-fortress-v1",
        primary_comic: Some("comic-fortress"),
        snapshot_json: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../goldens/golden-mystery-fortress-v1.json"
        )),
    },
    DemoQuest {
        quest_id: "ironia-sudby",
        name: "Ирония судьбы: по следам исторических личностей",
        template_summary: "8 шагов · все 7 шаблонов · Нови Сад",
        snapshot_id: "golden-ironia-sudby-v1",
        primary_comic: Some("/assets/img/quest-card.png"),
        snapshot_json: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../goldens/golden-ironia-sudby-v1.json"
        )),
    },
];

async fn seed_demo_quests(grants: &GrantStores) -> Result<(), AppError> {
    for quest in DEMO_QUESTS {
        let snapshot: serde_json::Value =
            serde_json::from_str(quest.snapshot_json).map_err(|e| AppError::Internal(e.into()))?;
        grants
            .register_published(
                quest.quest_id,
                PublishedMeta {
                    quest_id: quest.quest_id.into(),
                    name: quest.name.into(),
                    primary_comic: quest.primary_comic.map(Into::into),
                    template_summary: quest.template_summary.into(),
                    snapshot_version: 1,
                    snapshot_id: quest.snapshot_id.into(),
                },
                Some(snapshot),
            )
            .await?;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv().ok();

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "geohod_backend=info,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = AppConfig::from_env().context("failed to load configuration")?;

    let state = match std::env::var("DATABASE_URL") {
        Ok(url) => {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(10)
                .connect(&url)
                .await
                .context("failed to connect to DATABASE_URL")?;
            sqlx::migrate!("./migrations")
                .run(&pool)
                .await
                .context("failed to run database migrations")?;
            tracing::info!("storage: PostgreSQL (migrations up to date)");
            AppState {
                config: config.clone(),
                store: FactStores::Postgres(pg_store::PgFactStore::new(pool.clone())),
                grants: GrantStores::Postgres(pg_store::PgGrantStore::new(pool.clone())),
                auth: AuthStores::Postgres(pg_store::PgAuthStore::new(pool)),
                payments: Arc::new(MockPaymentProvider),
            }
        }
        Err(_) => {
            tracing::warn!(
                "DATABASE_URL not set — using in-memory storage; ALL DATA IS LOST ON RESTART"
            );
            in_memory_state(config.clone())
        }
    };

    if let Err(e) = seed_demo_quests(&state.grants).await {
        tracing::warn!(error = ?e, "demo quest seeding failed (continuing)");
    }

    tracing::info!(addr = %config.addr, version = %config.version, "starting geohod-backend");

    let app = build_router(state).layer(tower_http::timeout::TimeoutLayer::with_status_code(
        StatusCode::REQUEST_TIMEOUT,
        Duration::from_secs(30),
    ));

    let listener = TcpListener::bind(config.addr)
        .await
        .with_context(|| format!("failed to bind to {}", config.addr))?;

    tracing::info!("listening on http://{}", config.addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received, starting graceful shutdown");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use facts::FactKind;
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    /// Admin secret wired into the test app so admin-gated scenarios can
    /// authenticate (and assert that the wrong/absent token is rejected).
    const TEST_ADMIN_TOKEN: &str = "test-admin-secret";

    fn test_app() -> Router {
        build_router(in_memory_state(AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            version: "test-0.0.0",
            admin_token: Some(TEST_ADMIN_TOKEN.to_string()),
            cors_allowed_origins: Vec::new(),
        }))
    }

    /// Router with NO admin secret configured — admin surfaces must fail closed.
    fn test_app_no_admin() -> Router {
        build_router(in_memory_state(AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            version: "test-0.0.0",
            admin_token: None,
            cors_allowed_origins: Vec::new(),
        }))
    }

    // ---- CORS allowlist -----------------------------------------------------

    #[test]
    fn origin_allowed_exact_match() {
        let allow = vec!["https://app.geohod.ru".to_string()];
        assert!(origin_allowed(&allow, "https://app.geohod.ru"));
        // Different host, different scheme, and trailing path/garbage all reject.
        assert!(!origin_allowed(&allow, "https://evil.geohod.ru"));
        assert!(!origin_allowed(&allow, "http://app.geohod.ru"));
        assert!(!origin_allowed(&allow, "https://app.geohod.ru.evil.com"));
    }

    #[test]
    fn origin_allowed_wildcard_subdomain() {
        let allow = vec!["https://*.vercel.app".to_string()];
        assert!(origin_allowed(
            &allow,
            "https://geohod-quest-abc123.vercel.app"
        ));
        assert!(origin_allowed(&allow, "https://x.vercel.app"));
        // Scheme is part of the match; suffix must be exact.
        assert!(!origin_allowed(&allow, "http://x.vercel.app"));
        assert!(!origin_allowed(&allow, "https://vercel.app.evil.com"));
    }

    #[test]
    fn origin_allowed_empty_list_rejects_everything() {
        assert!(!origin_allowed(&[], "https://app.geohod.ru"));
    }

    /// With a configured allowlist, a preflight from an allowed origin is
    /// reflected and a foreign origin is not.
    #[tokio::test]
    async fn cors_preflight_reflects_only_allowed_origin() {
        let app = build_router(in_memory_state(AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            version: "test-0.0.0",
            admin_token: None,
            cors_allowed_origins: vec!["https://app.geohod.ru".to_string()],
        }));

        let preflight = |origin: &'static str| {
            let app = app.clone();
            async move {
                let req = Request::builder()
                    .method("OPTIONS")
                    .uri("/api/quests")
                    .header("origin", origin)
                    .header("access-control-request-method", "GET")
                    .body(Body::empty())
                    .expect("request");
                let resp = app.oneshot(req).await.expect("response");
                resp.headers()
                    .get("access-control-allow-origin")
                    .map(|v| v.to_str().unwrap().to_string())
            }
        };

        assert_eq!(
            preflight("https://app.geohod.ru").await.as_deref(),
            Some("https://app.geohod.ru"),
            "allowed origin must be reflected"
        );
        assert_eq!(
            preflight("https://evil.example.com").await,
            None,
            "foreign origin must NOT receive an allow-origin header"
        );
    }

    #[tokio::test]
    async fn admin_endpoints_disabled_when_no_secret_configured() {
        let app = test_app_no_admin();
        // Even with a token header, an unset ADMIN_TOKEN disables the surface.
        let (st, _) = get_json_h(
            &app,
            "/api/admin/versions/whatever/stats",
            &[("x-admin-token", "anything")],
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        let (st, _) = post_json_h(
            &app,
            "/api/migrate/legacy",
            json!({"key": "k"}),
            &[("x-admin-token", "anything")],
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
    }

    async fn post_json_h(
        app: &Router,
        uri: &str,
        body: Value,
        extra_headers: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json");
        for (name, value) in extra_headers {
            builder = builder.header(*name, *value);
        }
        let resp = app
            .clone()
            .oneshot(builder.body(Body::from(body.to_string())).expect("request"))
            .await
            .expect("response");
        let status = resp.status();
        let bytes = resp.into_body().collect().await.expect("body").to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn post_json(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
        post_json_h(app, uri, body, &[]).await
    }

    async fn get_json_h(
        app: &Router,
        uri: &str,
        extra_headers: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().uri(uri);
        for (name, value) in extra_headers {
            builder = builder.header(*name, *value);
        }
        let resp = app
            .clone()
            .oneshot(builder.body(Body::empty()).expect("request"))
            .await
            .expect("response");
        let status = resp.status();
        let bytes = resp.into_body().collect().await.expect("body").to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn get_json(app: &Router, uri: &str) -> (StatusCode, Value) {
        get_json_h(app, uri, &[]).await
    }

    fn fact_json(kind: FactKind, step: i32, delta: i32, device: &str) -> Value {
        serde_json::to_value(Fact {
            kind,
            step_position: step,
            submitted_value: None,
            local_is_correct: true,
            coins_delta: delta,
            note: None,
            device_id: device.into(),
        })
        .expect("fact json")
    }

    /// Run-unique identifiers so the same scenarios can execute against a shared
    /// Postgres database without colliding with previous runs.
    struct Ids {
        player: String,
        quest: String,
        snap1: String,
        snap2: String,
    }

    impl Ids {
        fn new(tag: &str) -> Self {
            Self {
                player: format!("player-{tag}"),
                quest: format!("quest-{tag}"),
                snap1: format!("snap-{tag}-v1"),
                snap2: format!("snap-{tag}-v2"),
            }
        }
    }

    /// Grants + publishes ids.quest (v1, ids.snap1) and creates an attempt.
    /// Returns the attempt_id.
    async fn grant_publish_attempt(app: &Router, ids: &Ids) -> String {
        let (st, _) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest, "coupon_percent": null}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json(
            app,
            "/api/quests/publish",
            json!({
                "quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                "snapshot_version": 1, "snapshot_id": ids.snap1
            }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, meta) = post_json(
            app,
            "/api/attempts",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        meta["attempt_id"].as_str().expect("attempt id").to_string()
    }

    // === Shared scenarios: executed against the in-memory backend below and the
    // === Postgres backend in pg_full_suite (same behavior on both — persistence spec).

    async fn scenario_attempt_gating(app: &Router, ids: &Ids) {
        let (st, body) = post_json(
            app,
            "/api/attempts",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        assert!(body["error"].as_str().expect("error").contains("grant"));

        let _ = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        let (st, _) = post_json(
            app,
            "/api/attempts",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(
            st,
            StatusCode::NOT_FOUND,
            "grant alone is not enough: quest unpublished"
        );
    }

    async fn scenario_unknown_attempt(app: &Router) {
        let (st, _) = post_json(
            app,
            "/api/attempts/ghost/facts",
            json!({"facts": [fact_json(FactKind::PhysicalConfirmed, 0, 0, "a")]}),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _) = get_json(app, "/api/attempts/ghost/state").await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }

    /// Returns the attempt_id for restart-survival checks.
    async fn scenario_happy_chain(app: &Router, ids: &Ids) -> String {
        let attempt = grant_publish_attempt(app, ids).await;

        let happy = json!({"facts": [
            {"type": "physical_confirmed", "step_position": 0, "submitted_value": null,
             "local_is_correct": true, "coins_delta": 0, "note": "start", "device_id": "device-a"},
            {"type": "answer_submitted", "step_position": 1, "submitted_value": "МИХАЙЛО ПУПИН",
             "local_is_correct": true, "coins_delta": 0, "note": null, "device_id": "device-a"},
            {"type": "gift_claimed", "step_position": 2, "submitted_value": null,
             "local_is_correct": true, "coins_delta": 5, "note": "gift", "device_id": "device-a"},
            {"type": "attempt_completed", "step_position": 3, "submitted_value": null,
             "local_is_correct": true, "coins_delta": 0, "note": "done", "device_id": "device-a"}
        ]});

        let uri = format!("/api/attempts/{attempt}/facts");
        let (st, v1) = post_json(app, &uri, happy.clone()).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v1["accepted"].as_array().expect("accepted").len(), 4);
        assert_eq!(v1["projected"]["balance"], 5);
        assert!(
            v1.get("corrections").is_none(),
            "no corrections field in protocol"
        );

        let (_, v2) = post_json(app, &uri, happy).await;
        assert_eq!(
            v2["accepted"].as_array().expect("accepted").len(),
            0,
            "reconnect no-op"
        );
        assert_eq!(v2["fact_count"], 4);

        let (st, gv) = get_json(app, &format!("/api/attempts/{attempt}/state")).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(gv["projected"]["balance"], 5);
        assert_eq!(gv["projected"]["completed_steps"], json!([0, 1, 3]));
        assert_eq!(gv["snapshot_id"], ids.snap1);
        attempt
    }

    async fn scenario_multi_device_overdraft(app: &Router, ids: &Ids) {
        let attempt = grant_publish_attempt(app, ids).await;
        let uri = format!("/api/attempts/{attempt}/facts");

        let (_, _) = post_json(
            app,
            &uri,
            json!({"facts": [fact_json(FactKind::GiftClaimed, 2, 3, "device-a")]}),
        )
        .await;
        let (st, v) = post_json(
            app,
            &uri,
            json!({"facts": [fact_json(FactKind::HintPurchased, 1, -5, "device-b")]}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["accepted"].as_array().expect("accepted").len(), 1);
        assert_eq!(v["projected"]["balance"], -2, "negative balance persists");
        assert_eq!(v["fact_count"], 2, "no compensation facts appended");

        let (_, gv) = get_json(app, &format!("/api/attempts/{attempt}/state")).await;
        assert_eq!(
            gv["projected"]["balance"], -2,
            "still negative on later reads"
        );
    }

    async fn scenario_cross_device_duplicate(app: &Router, ids: &Ids) {
        let attempt = grant_publish_attempt(app, ids).await;
        let uri = format!("/api/attempts/{attempt}/facts");
        let (_, v1) = post_json(
            app,
            &uri,
            json!({"facts": [fact_json(FactKind::GiftClaimed, 2, 5, "device-a")]}),
        )
        .await;
        let (_, v2) = post_json(
            app,
            &uri,
            json!({"facts": [fact_json(FactKind::GiftClaimed, 2, 5, "device-b")]}),
        )
        .await;
        assert_eq!(v1["accepted"].as_array().expect("accepted").len(), 1);
        assert_eq!(
            v2["accepted"].as_array().expect("accepted").len(),
            0,
            "same gift from second device must not double-count"
        );
        assert_eq!(v2["projected"]["balance"], 5);
    }

    async fn scenario_concurrent_duplicate_batch(app: &Router, ids: &Ids) {
        let attempt = grant_publish_attempt(app, ids).await;
        let uri = format!("/api/attempts/{attempt}/facts");
        let batch = json!({"facts": [fact_json(FactKind::GiftClaimed, 2, 5, "device-a")]});

        let (r1, r2) = tokio::join!(
            post_json(app, &uri, batch.clone()),
            post_json(app, &uri, batch)
        );
        let accepted_total = r1.1["accepted"].as_array().expect("accepted").len()
            + r2.1["accepted"].as_array().expect("accepted").len();
        assert_eq!(
            accepted_total, 1,
            "exactly one of the racers wins the insert"
        );

        let (_, gv) = get_json(app, &format!("/api/attempts/{attempt}/state")).await;
        assert_eq!(gv["projected"]["balance"], 5, "counted once");
        assert_eq!(gv["fact_count"], 1);
    }

    async fn scenario_completion_bonus_once(app: &Router, ids: &Ids) {
        let first = grant_publish_attempt(app, ids).await;

        let bonus = json!({"facts": [fact_json(FactKind::CompletionBonus, 3, 5, "device-a")]});
        let (_, v1) = post_json(app, &format!("/api/attempts/{first}/facts"), bonus.clone()).await;
        assert_eq!(v1["accepted"].as_array().expect("accepted").len(), 1);
        assert_eq!(v1["projected"]["balance"], 5);

        // Reset + replay: a NEW attempt for the same player+quest gets no second bonus.
        let (_, meta2) = post_json(
            app,
            "/api/attempts",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        let second = meta2["attempt_id"].as_str().expect("attempt id");
        let (_, v2) = post_json(app, &format!("/api/attempts/{second}/facts"), bonus).await;
        assert_eq!(
            v2["accepted"].as_array().expect("accepted").len(),
            0,
            "bonus is once per (player, quest), ever"
        );
    }

    async fn scenario_version_freeze(app: &Router, ids: &Ids) {
        let first = grant_publish_attempt(app, ids).await;

        let (_, _) = post_json(
            app,
            "/api/quests/publish",
            json!({"quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                   "snapshot_version": 2, "snapshot_id": ids.snap2}),
        )
        .await;
        let (_, meta2) = post_json(
            app,
            "/api/attempts",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;

        let (_, gv1) = get_json(app, &format!("/api/attempts/{first}/state")).await;
        assert_eq!(
            gv1["snapshot_id"],
            ids.snap1.as_str(),
            "existing attempt stays on v1"
        );
        assert_eq!(
            meta2["snapshot_id"],
            ids.snap2.as_str(),
            "new attempt binds v2"
        );
    }

    async fn scenario_checkout_and_publish_list(app: &Router, ids: &Ids) {
        let (_, v1) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest, "coupon_percent": null}),
        )
        .await;
        assert_eq!(v1["created"], true);
        assert_eq!(v1["grant"]["source"], "Payment");

        let (_, v2) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest, "coupon_percent": 100}),
        )
        .await;
        assert_eq!(v2["created"], false, "idempotent");
        assert_eq!(v2["grant"]["source"], "Payment", "first source preserved");

        let other_quest = format!("{}-coupon", ids.quest);
        let (_, v3) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": other_quest, "coupon_percent": 100}),
        )
        .await;
        assert_eq!(v3["grant"]["source"], "CouponRedemption");

        let (_, _) = post_json(
            app,
            "/api/quests/publish",
            json!({"quest_id": ids.quest, "name": "Q", "primary_comic": "comic-q",
                   "template_summary": "demo", "snapshot_version": 1, "snapshot_id": ids.snap1}),
        )
        .await;
        let (_, list) = get_json(app, "/api/quests").await;
        assert!(
            list.as_array()
                .expect("list")
                .iter()
                .any(|m| m["quest_id"] == ids.quest.as_str()
                    && m["snapshot_id"] == ids.snap1.as_str())
        );

        // /api/grants is caller-scoped: anonymous callers must claim an id, and
        // the response contains ONLY that player's grants (no cross-player leak).
        let (st, _) = get_json(app, "/api/grants").await;
        assert_eq!(st, StatusCode::UNAUTHORIZED, "grants require an identity");

        let (_, grants) = get_json_h(app, "/api/grants", &[("x-player-id", &ids.player)]).await;
        let grants = grants.as_array().expect("grants");
        assert!(
            grants
                .iter()
                .any(|g| g["player_id"] == ids.player.as_str() && g["source"] == "Payment")
        );
        assert!(
            grants.iter().all(|g| g["player_id"] == ids.player.as_str()),
            "no other player's grants are exposed"
        );
    }

    async fn scenario_bundle_gated_by_grant(app: &Router, ids: &Ids) {
        let snapshot =
            json!({"golden_id": ids.snap1, "steps": [{"position": 0, "template": "start"}]});

        // Unpublished -> 404 even with the player param.
        let (st, _) = get_json(
            app,
            &format!("/api/quests/{}/bundle?player_id={}", ids.quest, ids.player),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        let (_, _) = post_json(
            app,
            "/api/quests/publish",
            json!({"quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": ids.snap1, "snapshot": snapshot}),
        )
        .await;

        // Published but no grant -> 403, no content.
        let (st, body) = get_json(
            app,
            &format!("/api/quests/{}/bundle?player_id={}", ids.quest, ids.player),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        assert!(body.get("snapshot").is_none());

        // After checkout -> full frozen snapshot JSON.
        let (_, _) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        let (st, body) = get_json(
            app,
            &format!("/api/quests/{}/bundle?player_id={}", ids.quest, ids.player),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["snapshot_id"], ids.snap1.as_str());
        assert_eq!(body["snapshot"]["golden_id"], ids.snap1.as_str());
    }

    async fn scenario_snapshot_immutability(app: &Router, ids: &Ids) {
        let v1 = json!({"steps": [1, 2, 3]});
        let publish = |snapshot: Value| {
            json!({"quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": ids.snap1, "snapshot": snapshot})
        };

        let (st, _) = post_json(app, "/api/quests/publish", publish(v1.clone())).await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json(app, "/api/quests/publish", publish(v1)).await;
        assert_eq!(st, StatusCode::OK, "identical re-publish is idempotent");
        let (st, body) =
            post_json(app, "/api/quests/publish", publish(json!({"steps": [9]}))).await;
        assert_eq!(
            st,
            StatusCode::BAD_REQUEST,
            "frozen snapshot must not be rewritten"
        );
        assert!(body["error"].as_str().expect("error").contains("frozen"));
    }

    async fn scenario_admin_stats(app: &Router, ids: &Ids) {
        let attempt = grant_publish_attempt(app, ids).await;

        let (_, _) = post_json(
            app,
            &format!("/api/attempts/{attempt}/facts"),
            json!({"facts": [
                {"type": "physical_confirmed", "step_position": 0, "submitted_value": null,
                 "local_is_correct": true, "coins_delta": 0, "note": null, "device_id": "device-a"},
                {"type": "answer_submitted", "step_position": 1, "submitted_value": "wrong",
                 "local_is_correct": false, "coins_delta": 0, "note": null, "device_id": "device-a"},
                {"type": "hint_purchased", "step_position": 1, "submitted_value": null,
                 "local_is_correct": true, "coins_delta": -5, "note": null, "device_id": "device-a"},
                {"type": "feedback_reported", "step_position": 1, "submitted_value": null,
                 "local_is_correct": true, "coins_delta": 0, "note": "test feedback", "device_id": "device-a"},
                {"type": "navigator_used", "step_position": 0, "submitted_value": null,
                 "local_is_correct": true, "coins_delta": 0, "note": null, "device_id": "device-a"},
                {"type": "attempt_completed", "step_position": 3, "submitted_value": null,
                 "local_is_correct": true, "coins_delta": 0, "note": null, "device_id": "device-a"}
            ]}),
        )
        .await;

        let stats_uri = format!("/api/admin/versions/{}/stats", ids.snap1);
        let feedbacks_uri = format!("/api/admin/versions/{}/feedbacks", ids.snap1);
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        // Admin telemetry is gated: no token / wrong token are rejected before
        // any data is returned (cross-quest aggregate + raw feedback notes).
        // (Token IS configured in the test app, so missing/wrong are 401; the
        // 403 "disabled" path applies only when ADMIN_TOKEN is unset.)
        let (st, _) = get_json(app, &stats_uri).await;
        assert_eq!(
            st,
            StatusCode::UNAUTHORIZED,
            "missing admin token is rejected"
        );
        let (st, _) = get_json_h(app, &stats_uri, &[("x-admin-token", "wrong")]).await;
        assert_eq!(
            st,
            StatusCode::UNAUTHORIZED,
            "wrong admin token is rejected"
        );
        let (st, _) = get_json(app, &feedbacks_uri).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED, "feedbacks gated too");

        let (st, stats) = get_json_h(app, &stats_uri, &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(stats["attempts_count"], 1);
        assert_eq!(stats["completions_count"], 1);
        assert_eq!(stats["per_step"]["1"]["wrongs"], 1);
        assert_eq!(stats["per_step"]["1"]["hints"], 1);
        assert_eq!(stats["per_step"]["1"]["feedbacks"], 1);
        assert_eq!(stats["navigator_clicks"], 1);

        let (_, feedbacks) = get_json_h(app, &feedbacks_uri, &admin).await;
        assert!(
            feedbacks
                .as_array()
                .expect("feedbacks")
                .iter()
                .any(|f| f["type"] == "feedback_reported" && f["note"] == "test feedback")
        );
    }

    async fn scenario_bad_payload(app: &Router, ids: &Ids) {
        let attempt = grant_publish_attempt(app, ids).await;
        // Missing device_id -> deserialization failure -> 4xx, nothing appended.
        let (st, _) = post_json(
            app,
            &format!("/api/attempts/{attempt}/facts"),
            json!({"facts": [{"type": "physical_confirmed", "step_position": 0,
                              "local_is_correct": true, "coins_delta": 0}]}),
        )
        .await;
        assert!(st.is_client_error(), "4xx for bad payload, got {st}");
        let (_, gv) = get_json(app, &format!("/api/attempts/{attempt}/state")).await;
        assert_eq!(gv["fact_count"], 0, "log untouched after bad payload");
    }

    async fn scenario_migration_idempotent(app: &Router, key: &str) {
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let body = json!({
            "answer_cards": [
                {"step": 2, "type": "gift", "coins": 5},
                {"step": 3, "type": "complete", "correct": true}
            ],
            "key": key
        });

        // Migration is admin-gated: unauthenticated callers cannot run it.
        let (st, _) = post_json(app, "/api/migrate/legacy", body.clone()).await;
        assert_eq!(
            st,
            StatusCode::UNAUTHORIZED,
            "migration requires admin token"
        );

        let (st, v) = post_json_h(app, "/api/migrate/legacy", body, &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["marked"], true);
        assert_eq!(v["synth_facts"].as_array().expect("facts").len(), 2);

        let (_, v2) = post_json_h(app, "/api/migrate/legacy", json!({"key": key}), &admin).await;
        assert_eq!(
            v2["synth_facts"].as_array().expect("facts").len(),
            0,
            "re-run is a no-op"
        );
    }

    /// Register `player` with a derived email; returns (email, token).
    async fn register(app: &Router, player: &str) -> (String, String) {
        let email = format!("{player}@example.com");
        let (st, v) = post_json(
            app,
            "/api/auth/register",
            json!({"player_id": player, "email": email, "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["player_id"], player, "registration keeps the player id");
        let token = v["token"].as_str().expect("token").to_string();
        assert_eq!(token.len(), 64);
        (email, token)
    }

    async fn scenario_auth_register_login(app: &Router, ids: &Ids) {
        // Anonymous purchase BEFORE registration — must survive it.
        let (st, _) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        let (email, token) = register(app, &ids.player).await;

        // Garbage credentials are rejected up front.
        let (st, _) = post_json(
            app,
            "/api/auth/register",
            json!({"player_id": "p-x", "email": "no-at-sign", "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _) = post_json(
            app,
            "/api/auth/register",
            json!({"player_id": "p-x", "email": "x@example.com", "password": "short"}),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        // Duplicate email (another player) and re-registration: 409, no partial state.
        let (st, _) = post_json(
            app,
            "/api/auth/register",
            json!({"player_id": format!("{}-other", ids.player), "email": email,
                   "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);
        let (st, _) = post_json(
            app,
            "/api/auth/register",
            json!({"player_id": ids.player, "email": format!("second-{email}"),
                   "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);

        // Login: fresh token, same identity; wrong password and unknown email are 401.
        let (st, v) = post_json(
            app,
            "/api/auth/login",
            json!({"email": email, "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["player_id"], ids.player.as_str());
        let login_token = v["token"].as_str().expect("token").to_string();
        assert_ne!(login_token, token, "each login mints a fresh session");
        let (st, _) = post_json(
            app,
            "/api/auth/login",
            json!({"email": email, "password": "wrong-password"}),
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        let (st, _) = post_json(
            app,
            "/api/auth/login",
            json!({"email": format!("ghost-{email}"), "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        // The pre-registration grant still authorizes attempts (with the session).
        let (st, _) = post_json(
            app,
            "/api/quests/publish",
            json!({"quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": ids.snap1}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let bearer = format!("Bearer {login_token}");
        let (st, _) = post_json_h(
            app,
            "/api/attempts",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::OK, "grant survived registration");
    }

    async fn scenario_auth_enforcement(app: &Router, ids: &Ids) {
        // Anonymous: tokenless checkout works (device possession is the credential).
        let (st, _) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Anonymous profile via X-Player-Id.
        let (st, me) = get_json_h(app, "/api/players/me", &[("x-player-id", &ids.player)]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["registered"], false);
        assert_eq!(me["player_id"], ids.player.as_str());

        let (_, token) = register(app, &ids.player).await;
        let bearer = format!("Bearer {token}");

        // After registration: tokenless claims of this id are 401 everywhere scoped.
        let (st, _) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": "another-quest"}),
        )
        .await;
        assert_eq!(
            st,
            StatusCode::UNAUTHORIZED,
            "registered id needs a session"
        );
        let (st, _) = post_json(
            app,
            "/api/attempts",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        let (st, _) = get_json_h(
            app,
            "/api/players/me/stats",
            &[("x-player-id", &ids.player)],
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        let (st, _) = get_json(
            app,
            &format!("/api/quests/{}/bundle?player_id={}", ids.quest, ids.player),
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        // With the session, the same requests pass identity (then normal gating).
        let (st, me) = get_json_h(app, "/api/players/me", &[("authorization", &bearer)]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["registered"], true);
        let (st, v) = post_json_h(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": "another-quest"}),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["grant"]["player_id"], ids.player.as_str());

        // A session must not act as someone else (client-bug guard).
        let (st, _) = post_json_h(
            app,
            "/api/checkout",
            json!({"player_id": "someone-else", "quest_id": ids.quest}),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);

        // Garbage tokens are 401, not anonymous fallback.
        let (st, _) = post_json_h(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
            &[("authorization", "Bearer not-a-real-token")],
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }

    async fn scenario_player_stats(app: &Router, ids: &Ids) {
        // Quest A: completed with gift +5 and completion bonus +5.
        let attempt_a = grant_publish_attempt(app, ids).await;
        let (st, _) = post_json(
            app,
            &format!("/api/attempts/{attempt_a}/facts"),
            json!({"facts": [
                fact_json(FactKind::GiftClaimed, 2, 5, "device-a"),
                fact_json(FactKind::CompletionBonus, 3, 5, "device-a"),
                fact_json(FactKind::AttemptCompleted, 3, 0, "device-a"),
            ]}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Quest B: in progress with a hint overdraft (−12).
        let quest_b = format!("{}-b", ids.quest);
        let snap_b = format!("{}-b", ids.snap1);
        let (_, _) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": quest_b}),
        )
        .await;
        let (_, _) = post_json(
            app,
            "/api/quests/publish",
            json!({"quest_id": quest_b, "name": "QB", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": snap_b}),
        )
        .await;
        let (_, meta_b) = post_json(
            app,
            "/api/attempts",
            json!({"player_id": ids.player, "quest_id": quest_b}),
        )
        .await;
        let attempt_b = meta_b["attempt_id"].as_str().expect("attempt id");
        let hint_batch = json!({"facts": [fact_json(FactKind::HintPurchased, 1, -12, "device-a")]});
        let (st, _) = post_json(
            app,
            &format!("/api/attempts/{attempt_b}/facts"),
            hint_batch.clone(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Stats: signed cross-attempt fold; quest A completed, B not.
        let (st, stats) = get_json_h(
            app,
            "/api/players/me/stats",
            &[("x-player-id", &ids.player)],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(stats["balance"], -2, "5 + 5 - 12, unclamped");
        assert_eq!(stats["quests_completed"], 1);
        assert_eq!(stats["completed_quest_ids"], json!([ids.quest.as_str()]));
        assert_eq!(stats["attempts_count"], 2);
        assert_eq!(stats["grants_count"], 2);

        // Idempotent re-append changes nothing.
        let (_, _) = post_json(app, &format!("/api/attempts/{attempt_b}/facts"), hint_batch).await;
        let (_, stats2) = get_json_h(
            app,
            "/api/players/me/stats",
            &[("x-player-id", &ids.player)],
        )
        .await;
        assert_eq!(stats, stats2, "duplicate appends never move stats");
    }

    async fn scenario_payment_ref_audit(app: &Router, ids: &Ids) {
        // Payment path: mock provider approves, ref recorded on the grant.
        let (st, v1) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v1["created"], true);
        assert_eq!(
            v1["grant"]["source_ref"],
            format!("mock-pay-{}-{}", ids.player, ids.quest)
        );

        // Coupon 100% bypasses the provider: no ref.
        let coupon_quest = format!("{}-coupon", ids.quest);
        let (_, v2) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": coupon_quest, "coupon_percent": 100}),
        )
        .await;
        assert_eq!(v2["grant"]["source"], "CouponRedemption");
        assert_eq!(v2["grant"]["source_ref"], Value::Null);

        // Idempotent repeat preserves the original audit ref.
        let (_, v3) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(v3["created"], false);
        assert_eq!(v3["grant"]["source_ref"], v1["grant"]["source_ref"]);
    }

    // === In-memory backend (fresh state per test, fixed tags) ===

    #[tokio::test]
    async fn health_returns_ok_and_version() {
        let app = test_app();
        let (status, body) = get_json(&app, "/health").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["version"], "test-0.0.0");
    }

    #[tokio::test]
    async fn attempt_requires_grant_and_published_quest() {
        scenario_attempt_gating(&test_app(), &Ids::new("gate")).await;
    }

    #[tokio::test]
    async fn unknown_attempt_rejected_on_append_and_state() {
        scenario_unknown_attempt(&test_app()).await;
    }

    #[tokio::test]
    async fn happy_chain_grant_attempt_facts_idempotent_reconnect() {
        scenario_happy_chain(&test_app(), &Ids::new("happy")).await;
    }

    #[tokio::test]
    async fn multi_device_overdraft_stays_negative() {
        scenario_multi_device_overdraft(&test_app(), &Ids::new("od")).await;
    }

    #[tokio::test]
    async fn cross_device_duplicate_award_absorbed() {
        scenario_cross_device_duplicate(&test_app(), &Ids::new("dup")).await;
    }

    #[tokio::test]
    async fn concurrent_duplicate_batch_collapses_to_one() {
        scenario_concurrent_duplicate_batch(&test_app(), &Ids::new("race")).await;
    }

    #[tokio::test]
    async fn completion_bonus_idempotent_across_attempts() {
        scenario_completion_bonus_once(&test_app(), &Ids::new("bonus")).await;
    }

    #[tokio::test]
    async fn version_freeze_new_publish_does_not_rebind() {
        scenario_version_freeze(&test_app(), &Ids::new("freeze")).await;
    }

    #[tokio::test]
    async fn checkout_idempotent_coupon100_and_publish_list() {
        scenario_checkout_and_publish_list(&test_app(), &Ids::new("shop")).await;
    }

    #[tokio::test]
    async fn bundle_endpoint_gated_by_grant() {
        scenario_bundle_gated_by_grant(&test_app(), &Ids::new("bundle")).await;
    }

    #[tokio::test]
    async fn publish_rejects_frozen_snapshot_rewrite() {
        scenario_snapshot_immutability(&test_app(), &Ids::new("frozen")).await;
    }

    #[tokio::test]
    async fn admin_stats_and_feedbacks_per_version() {
        scenario_admin_stats(&test_app(), &Ids::new("admin")).await;
    }

    #[tokio::test]
    async fn bad_payload_rejected_with_4xx() {
        scenario_bad_payload(&test_app(), &Ids::new("bad")).await;
    }

    #[tokio::test]
    async fn auth_register_login_preserves_identity() {
        scenario_auth_register_login(&test_app(), &Ids::new("auth")).await;
    }

    #[tokio::test]
    async fn auth_enforcement_two_tier() {
        scenario_auth_enforcement(&test_app(), &Ids::new("enforce")).await;
    }

    #[tokio::test]
    async fn player_stats_cross_attempt_fold() {
        scenario_player_stats(&test_app(), &Ids::new("stats")).await;
    }

    #[tokio::test]
    async fn payment_ref_audited_on_grants() {
        scenario_payment_ref_audit(&test_app(), &Ids::new("pay")).await;
    }

    #[tokio::test]
    async fn migration_idempotent_and_measure_rates() {
        let app = test_app();
        scenario_migration_idempotent(&app, "legacy:inmem").await;
        let (st, rates) = get_json(&app, "/api/measure/rates").await;
        assert_eq!(st, StatusCode::OK);
        assert!(
            rates["note"]
                .as_str()
                .expect("note")
                .contains("measurement")
        );
    }

    // === Postgres backend: full scenario suite + durability. Self-skips without
    // === DATABASE_URL (zero-infra dev/CI stays green); run `docker compose up -d`
    // === and set DATABASE_URL (see backend/.env.example) to execute.

    fn pg_app(pool: sqlx::PgPool) -> Router {
        build_router(AppState {
            config: AppConfig {
                addr: "0.0.0.0:0".parse().expect("test addr"),
                version: "test-pg",
                admin_token: Some(TEST_ADMIN_TOKEN.to_string()),
                cors_allowed_origins: Vec::new(),
            },
            store: FactStores::Postgres(pg_store::PgFactStore::new(pool.clone())),
            grants: GrantStores::Postgres(pg_store::PgGrantStore::new(pool.clone())),
            auth: AuthStores::Postgres(pg_store::PgAuthStore::new(pool)),
            payments: Arc::new(MockPaymentProvider),
        })
    }

    #[tokio::test]
    async fn pg_full_suite() {
        dotenv().ok();
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("pg_full_suite: skipped (DATABASE_URL not set)");
            return;
        };
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .expect("connect to DATABASE_URL");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        let app = pg_app(pool.clone());

        // Run-unique tag: scenarios tolerate a shared, pre-populated database.
        let run = store::now_secs() * 1_000_000 + (std::process::id() as u64 % 1_000_000);

        scenario_attempt_gating(&app, &Ids::new(&format!("gate-{run}"))).await;
        scenario_unknown_attempt(&app).await;
        let happy_ids = Ids::new(&format!("happy-{run}"));
        let happy_attempt = scenario_happy_chain(&app, &happy_ids).await;
        scenario_multi_device_overdraft(&app, &Ids::new(&format!("od-{run}"))).await;
        scenario_cross_device_duplicate(&app, &Ids::new(&format!("dup-{run}"))).await;
        scenario_concurrent_duplicate_batch(&app, &Ids::new(&format!("race-{run}"))).await;
        scenario_completion_bonus_once(&app, &Ids::new(&format!("bonus-{run}"))).await;
        scenario_version_freeze(&app, &Ids::new(&format!("freeze-{run}"))).await;
        scenario_checkout_and_publish_list(&app, &Ids::new(&format!("shop-{run}"))).await;
        scenario_bundle_gated_by_grant(&app, &Ids::new(&format!("bundle-{run}"))).await;
        scenario_snapshot_immutability(&app, &Ids::new(&format!("frozen-{run}"))).await;
        scenario_admin_stats(&app, &Ids::new(&format!("admin-{run}"))).await;
        scenario_bad_payload(&app, &Ids::new(&format!("bad-{run}"))).await;
        scenario_migration_idempotent(&app, &format!("legacy:{run}")).await;
        scenario_auth_register_login(&app, &Ids::new(&format!("auth-{run}"))).await;
        let enforce_ids = Ids::new(&format!("enforce-{run}"));
        scenario_auth_enforcement(&app, &enforce_ids).await;
        scenario_player_stats(&app, &Ids::new(&format!("stats-{run}"))).await;
        scenario_payment_ref_audit(&app, &Ids::new(&format!("pay-{run}"))).await;

        // Restart survival: a brand-new pool + router (process restart equivalent)
        // sees the pre-restart state, and bonus idempotency survives.
        let pool2 = sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .expect("reconnect");
        let app2 = pg_app(pool2);
        let (st, gv) = get_json(&app2, &format!("/api/attempts/{happy_attempt}/state")).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(gv["projected"]["balance"], 5, "projection survives restart");
        assert_eq!(gv["snapshot_id"], happy_ids.snap1.as_str());

        let bonus = json!({"facts": [fact_json(FactKind::CompletionBonus, 3, 5, "device-a")]});
        let (_, meta2) = post_json(
            &app2,
            "/api/attempts",
            json!({"player_id": happy_ids.player, "quest_id": happy_ids.quest}),
        )
        .await;
        let second = meta2["attempt_id"].as_str().expect("attempt id");
        let (_, v1) = post_json(
            &app2,
            &format!("/api/attempts/{second}/facts"),
            bonus.clone(),
        )
        .await;
        assert_eq!(
            v1["accepted"].as_array().expect("accepted").len(),
            1,
            "first bonus for this player+quest"
        );
        let (_, meta3) = post_json(
            &app2,
            "/api/attempts",
            json!({"player_id": happy_ids.player, "quest_id": happy_ids.quest}),
        )
        .await;
        let third = meta3["attempt_id"].as_str().expect("attempt id");
        let (_, v2) = post_json(&app2, &format!("/api/attempts/{third}/facts"), bonus).await;
        assert_eq!(
            v2["accepted"].as_array().expect("accepted").len(),
            0,
            "bonus once-ever survives restart"
        );

        // Accounts and sessions are durable: the pre-restart registration still
        // logs in, and a pre-restart session token still resolves.
        let (st, v) = post_json(
            &app2,
            "/api/auth/login",
            json!({"email": format!("{}@example.com", enforce_ids.player),
                   "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "players table survives restart");
        let bearer = format!("Bearer {}", v["token"].as_str().expect("token"));
        let (st, me) = get_json_h(&app2, "/api/players/me", &[("authorization", &bearer)]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["registered"], true);
        assert_eq!(me["player_id"], enforce_ids.player.as_str());
    }
}
