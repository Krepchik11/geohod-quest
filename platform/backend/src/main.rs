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
    extract::{DefaultBodyLimit, Path, Query, State},
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
mod media;
mod payments;
mod pg_store;
mod store;

use std::sync::{Arc, Mutex};

use config::AppConfig;
use errors::AppError;
use facts::{Fact, MigrationResult, ProjectedState};
use grants::{AccessGrant, GrantSource};
use media::{MediaRef, MediaStores};
use payments::{MockPaymentProvider, PaymentOutcome, PaymentProvider};
use store::{
    AttemptMeta, AuthStores, ConstructorQuest, ConstructorQuestSummary, ConstructorStores,
    FactStores, GrantStores, InMemoryAuthStore, InMemoryConstructorStore, InMemoryFactStore,
    InMemoryGrantStore, PublishedMeta,
};

/// Shared application state.
#[derive(Clone)]
struct AppState {
    config: AppConfig,
    store: FactStores,
    grants: GrantStores,
    auth: AuthStores,
    /// Authoring-side quest registry (drafts + lifecycle) behind the constructor.
    constructor: ConstructorStores,
    /// Content-addressed media blobs (Cloudflare R2 in prod; in-process otherwise).
    media: MediaStores,
    payments: Arc<dyn PaymentProvider>,
}

fn in_memory_state(config: AppConfig, media: MediaStores) -> AppState {
    AppState {
        config,
        store: FactStores::InMemory(Arc::new(Mutex::new(InMemoryFactStore::new()))),
        grants: GrantStores::InMemory(Arc::new(Mutex::new(InMemoryGrantStore::new()))),
        auth: AuthStores::InMemory(Arc::new(Mutex::new(InMemoryAuthStore::new()))),
        constructor: ConstructorStores::InMemory(Arc::new(Mutex::new(
            InMemoryConstructorStore::new(),
        ))),
        media,
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
    if state.auth.get_user(claimed).await?.is_some() {
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

/// Extract a `Bearer <token>` value from the Authorization header when present and
/// well-formed. Returns None for a missing/malformed header (the caller decides the
/// fallback) — unlike [`resolve_player`] it never errors on a missing header.
fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.strip_prefix("Bearer "))
        .map(str::to_string)
}

/// True when the shared `ADMIN_TOKEN` is configured AND the request presents it in
/// `X-Admin-Token`. This is the operator/bootstrap credential the admin and editor
/// gates share; it carries no identity (no "self"), so it is exempt from the
/// self-change guard. Fails closed when no token is configured.
fn ops_token_ok(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = state.config.admin_token.as_deref() else {
        return false;
    };
    let provided = headers
        .get("x-admin-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    !provided.is_empty() && provided == expected
}

/// The registered account behind a valid `Bearer` session, if any. A missing or
/// malformed token, an unknown session, and an anonymous id (no account row) all
/// collapse to `None`, so callers express authorization as a plain role check.
async fn session_account(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<auth::UserAccount>, AppError> {
    let Some(token) = bearer_token(headers) else {
        return Ok(None);
    };
    let Some(player_id) = state.auth.get_session(&token).await? else {
        return Ok(None);
    };
    state.auth.get_user(&player_id).await
}

/// The identity authorized to act on the admin user-management surface. `player_id`
/// is `Some` for a session-admin (the acting account) and `None` for the shared
/// `ADMIN_TOKEN` ops path (no "self"); the role handler uses this to forbid an admin
/// from changing their own role while leaving the ops path unrestricted.
struct AdminActor {
    player_id: Option<String>,
}

/// Authorize an admin user-management request. Two accepted credentials:
///
/// 1. The shared `ADMIN_TOKEN` in `X-Admin-Token` — the ops/bootstrap path that
///    promotes the first admin (and recovers if every admin is demoted). It carries
///    no identity, so it is exempt from the self-change guard.
/// 2. A `Bearer` session whose account has role `admin` — the user-facing path the
///    admin page uses once an admin exists.
///
/// Every other caller (anonymous, non-admin account, bad/expired token) gets a
/// single opaque 403 that never reveals which credential was tried or missing.
async fn require_admin_actor(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AdminActor, AppError> {
    if ops_token_ok(state, headers) {
        return Ok(AdminActor { player_id: None });
    }
    if let Some(account) = session_account(state, headers).await?
        && account.role == auth::ROLE_ADMIN
    {
        return Ok(AdminActor {
            player_id: Some(account.player_id),
        });
    }
    Err(AppError::Forbidden("admin access required".into()))
}

/// Authorize a quest-authoring request (the constructor / `/quest-editor` surface).
///
/// Authoring is the `editor` capability: a `Bearer` session whose account role is
/// `editor` or `admin` (admin ⊃ editor), OR the shared `ADMIN_TOKEN` operator
/// credential. Anonymous devices and plain `player` accounts get an opaque 403.
///
/// This is the server-side half of the role model — the `/quest-editor` page hides
/// itself from non-editors, but publish is a direct API call, so it must be gated
/// here too (a player could otherwise POST `/api/quests/publish` straight). It does
/// NOT bind authorship to the editor (any editor may publish any quest); per-author
/// ownership remains a separate, tracked follow-up.
async fn require_editor(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    if ops_token_ok(state, headers) {
        return Ok(());
    }
    if let Some(account) = session_account(state, headers).await?
        && (account.role == auth::ROLE_EDITOR || account.role == auth::ROLE_ADMIN)
    {
        return Ok(());
    }
    Err(AppError::Forbidden("editor access required".into()))
}

/// Health check response for probes and tests.
#[derive(serde::Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

/// Body-size ceiling for the authoring routes that carry a full quest payload —
/// create/save (the whole editable `body`) and publish (the frozen `snapshot`).
/// Axum's default extractor limit is 2 MiB, but a single quest legitimately
/// exceeds that: even a spec-compliant quest near the ≤5 MB bundle target blows
/// past 2 MiB, and imported legacy quests reach ~13 MB. With media stored INLINE
/// as base64 (the structural root cause — see the publish/save handlers), that
/// payload must currently travel in one request, so the cap is raised here.
/// Scoped to these editor-gated routes only; every other route keeps the 2 MiB
/// default. The real fix is externalizing media to content-addressed blobs so the
/// body carries references, not bytes — a separate change.
const MAX_AUTHORING_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Body-size ceiling for a single media upload. The client downscales images to
/// ≤2.5 MB before upload; 10 MiB is a generous ceiling that still rejects abuse.
const MAX_MEDIA_BYTES: usize = 10 * 1024 * 1024;

/// Image content-types accepted for upload (what the editor produces and the
/// import tool emits). Anything else is rejected before it reaches storage.
fn is_allowed_media_type(ct: &str) -> bool {
    matches!(ct, "image/jpeg" | "image/png" | "image/webp" | "image/gif")
}

/// POST /api/media — upload a quest image (editor-gated). The body is the raw
/// image bytes and `Content-Type` names the format. The SERVER hashes the bytes
/// (sha256) and stores them content-addressed in R2 (or the in-process store),
/// returning the public URL the quest JSON should reference. Idempotent: identical
/// bytes resolve to the same URL and are not re-stored.
async fn upload_media_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<MediaRef>, AppError> {
    require_editor(&state, &headers).await?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        // drop any "; charset=…" parameter the client may append (split always
        // yields ≥1 element, so the unwrap fallback is never taken)
        .map(|s| s.split(';').next().unwrap_or("").trim().to_string())
        .unwrap_or_default();
    if !is_allowed_media_type(&content_type) {
        return Err(AppError::BadRequest(format!(
            "unsupported media type '{content_type}' (allowed: jpeg, png, webp, gif)"
        )));
    }
    if body.is_empty() {
        return Err(AppError::BadRequest("empty media upload".into()));
    }
    let media_ref = state.media.put(body, &content_type).await?;
    Ok(Json(media_ref))
}

/// GET /api/media/{hash} — serve in-process media (local dev / tests). In
/// production media is served directly from R2's public URL, so this 404s there.
async fn get_media_handler(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let Some(blob) = state.media.get(&hash).await? else {
        return Err(AppError::NotFound(format!("media '{hash}' not found")));
    };
    axum::response::Response::builder()
        .header(header::CONTENT_TYPE, blob.content_type)
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(axum::body::Body::from(blob.bytes))
        .map_err(|e| AppError::Internal(anyhow::anyhow!("media response build: {e}")))
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
        .route(
            "/api/quests/publish",
            post(publish_quest_handler).layer(DefaultBodyLimit::max(MAX_AUTHORING_BODY_BYTES)),
        )
        .route("/api/quests/{quest_id}/bundle", get(get_bundle_handler))
        // Media: upload (editor-gated, lifts the body cap to a single image) and
        // the in-process serve route (R2 serves directly in prod; this 404s there).
        .route(
            "/api/media",
            post(upload_media_handler).layer(DefaultBodyLimit::max(MAX_MEDIA_BYTES)),
        )
        .route("/api/media/{hash}", get(get_media_handler))
        // Constructor dashboard (authoring-side; require_editor). All mutations are
        // POST — the router/CORS surface is GET+POST only by design. Create/save
        // carry the full editable body, so they lift the default 2 MiB body cap
        // (see MAX_AUTHORING_BODY_BYTES); the GET list/one and the tiny
        // status/delete bodies keep the default.
        .route(
            "/api/constructor/quests",
            get(list_constructor_quests_handler)
                .post(create_constructor_quest_handler)
                .layer(DefaultBodyLimit::max(MAX_AUTHORING_BODY_BYTES)),
        )
        .route(
            "/api/constructor/quests/{quest_id}",
            get(get_constructor_quest_handler),
        )
        .route(
            "/api/constructor/quests/{quest_id}/save",
            post(save_constructor_quest_handler).layer(DefaultBodyLimit::max(MAX_AUTHORING_BODY_BYTES)),
        )
        .route(
            "/api/constructor/quests/{quest_id}/status",
            post(set_constructor_status_handler),
        )
        .route(
            "/api/constructor/quests/{quest_id}/delete",
            post(delete_constructor_quest_handler),
        )
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
        .route("/api/admin/users", get(list_users_handler))
        .route(
            "/api/admin/users/{player_id}/role",
            post(set_user_role_handler),
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
    /// Real store-card fields the constructor collects; surfaced in the catalog so
    /// no card has to fabricate them. All optional (a blank field stays absent).
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    duration: Option<String>,
    #[serde(default)]
    price: Option<i64>,
}

async fn publish_quest_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PublishRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Publishing is the editor capability (role editor/admin or the ops token):
    // authoring lives behind /quest-editor, which only editors/admins can open, but
    // publish is a direct API call so the role is enforced here too. Author binding
    // (which editor owns which quest) remains a tracked follow-up.
    require_editor(&state, &headers).await?;
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
        // Normalize blank-string meta to None so the catalog omits the field
        // instead of rendering an empty pin/clock.
        city: req.city.filter(|s| !s.trim().is_empty()),
        duration: req.duration.filter(|s| !s.trim().is_empty()),
        price: req.price,
    };
    state
        .grants
        .register_published(&req.quest_id, meta, req.snapshot)
        .await?;
    // Reflect the publish in the constructor lifecycle: a quest tracked by the
    // dashboard flips to 'published'. Best-effort — a quest published straight
    // through the API (e.g. a seeded demo) simply has no constructor row.
    state
        .constructor
        .set_status(&req.quest_id, store::CTOR_STATUS_PUBLISHED, store::now_secs())
        .await?;
    Ok(Json(
        serde_json::json!({ "status": "published", "quest_id": req.quest_id }),
    ))
}

// ============ Constructor dashboard ============
//
// The authoring registry behind /quest-editor. Every endpoint is editor-gated
// (require_editor: an editor/admin session or the ops token). Completions
// ("прохождения") are derived per quest from the fact log — never stored on the
// constructor row — so the metric stays a pure projection.

/// One dashboard list row.
#[derive(serde::Serialize)]
struct ConstructorQuestWire {
    quest_id: String,
    name: String,
    /// Display label of the author (denormalized at creation).
    author: String,
    author_id: String,
    status: String,
    steps: u32,
    /// Distinct players who completed this quest (derived from the fact log).
    completed: usize,
    // No `cover`: the dashboard renders a name-derived thumbnail, not the stored
    // cover image, so the base64 cover was dead weight that bloated the list
    // (megabytes for media-heavy quests). It stays on the GET-one full wire.
    created_at: u64,
    updated_at: u64,
}

/// A single quest with its full editable body (for opening in the builder).
#[derive(serde::Serialize)]
struct ConstructorQuestFullWire {
    quest_id: String,
    name: String,
    author: String,
    author_id: String,
    status: String,
    steps: u32,
    completed: usize,
    cover: Option<String>,
    created_at: u64,
    updated_at: u64,
    body: serde_json::Value,
}

fn ctor_wire(s: ConstructorQuestSummary, completed: usize) -> ConstructorQuestWire {
    ConstructorQuestWire {
        quest_id: s.quest_id,
        name: s.name,
        author: s.author_name,
        author_id: s.author_id,
        status: s.status,
        steps: s.steps_count,
        completed,
        created_at: s.created_at,
        updated_at: s.updated_at,
    }
}

/// The acting editor's (id, display label, is_admin) for a constructor request,
/// resolved from a SINGLE session lookup. A Bearer session resolves to the real
/// account (admin iff role == admin); the ops-token path (no "self") is labeled
/// generically, keyed by the claimed device id, and is never admin — the
/// constructor keeps that bootstrap path author-scoped so an operator never gains
/// cross-author reach. Callers that also need the admin flag use this directly
/// instead of a second `session_account` round-trip.
async fn acting_author_role(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, String, bool), AppError> {
    if let Some(account) = session_account(state, headers).await? {
        let is_admin = account.role == auth::ROLE_ADMIN;
        let name = account
            .display_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(account.email);
        return Ok((account.player_id, name, is_admin));
    }
    let claimed = claimed_from_headers(headers);
    let id = if claimed.is_empty() {
        "ops".to_string()
    } else {
        claimed
    };
    Ok((id, "Оператор".to_string(), false))
}

/// The acting editor's (id, display label) for author attribution. See
/// [`acting_author_role`] when the admin flag is also needed.
async fn acting_author(state: &AppState, headers: &HeaderMap) -> Result<(String, String), AppError> {
    let (id, name, _) = acting_author_role(state, headers).await?;
    Ok((id, name))
}

/// Fetch a constructor quest the caller is allowed to act on, or 404.
///
/// Authoring is editor-gated (capability), then ownership-gated: a quest stays the
/// author's, but an ADMIN is the superuser and may act on any author's quest in any
/// state (the stated lifecycle: a published quest is "owned by author" yet "can be
/// edited by admin"). For a non-admin, a quest they did not author is
/// indistinguishable from one that does not exist — the same opaque 404, never a
/// signal that another author's quest exists. `author_id` is immutable (there is
/// no quest-transfer), so the fetched quest can be reused for the follow-up
/// mutation with no TOCTOU ownership gap. This is the single chokepoint every
/// per-quest constructor handler routes through, so the owner-or-admin rule is
/// structural rather than re-derived (and forgettable) at each call site.
async fn require_owned_constructor_quest(
    state: &AppState,
    headers: &HeaderMap,
    quest_id: &str,
) -> Result<ConstructorQuest, AppError> {
    require_editor(state, headers).await?;
    let (author_id, _, admin) = acting_author_role(state, headers).await?;
    state
        .constructor
        .get(quest_id)
        .await?
        .filter(|q| admin || q.author_id == author_id)
        .ok_or_else(|| AppError::NotFound(format!("constructor quest '{quest_id}' not found")))
}

async fn list_constructor_quests_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ConstructorQuestWire>>, AppError> {
    require_editor(&state, &headers).await?;
    // Editors get a personal workspace: ONLY their own quests (the reported bug was
    // every editor seeing everyone's). An ADMIN is the superuser and sees every
    // author's quest so it can manage any of them. The id is the same one creation
    // stamps, so a non-admin always sees exactly what they made.
    let (author_id, _, admin) = acting_author_role(&state, &headers).await?;
    let summaries = if admin {
        state.constructor.list_all_summaries().await?
    } else {
        state
            .constructor
            .list_summaries_for_author(&author_id)
            .await?
    };
    let completions = state.store.completions_by_quest().await?;
    Ok(Json(
        summaries
            .into_iter()
            .map(|s| {
                let c = completions.get(&s.quest_id).copied().unwrap_or(0);
                ctor_wire(s, c)
            })
            .collect(),
    ))
}

async fn get_constructor_quest_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<ConstructorQuestFullWire>, AppError> {
    let q = require_owned_constructor_quest(&state, &headers, &quest_id).await?;
    let completed = state
        .store
        .completions_by_quest()
        .await?
        .get(&q.quest_id)
        .copied()
        .unwrap_or(0);
    Ok(Json(ConstructorQuestFullWire {
        quest_id: q.quest_id,
        name: q.name,
        author: q.author_name,
        author_id: q.author_id,
        status: q.status,
        steps: q.steps_count,
        completed,
        cover: q.cover,
        created_at: q.created_at,
        updated_at: q.updated_at,
        body: q.body,
    }))
}

/// Body for POST /api/constructor/quests. The client mints the id (the same id
/// publish later binds), so it is required here.
#[derive(serde::Deserialize)]
struct CreateConstructorQuestRequest {
    quest_id: String,
    name: String,
    cover: Option<String>,
    steps_count: u32,
    body: serde_json::Value,
}

async fn create_constructor_quest_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateConstructorQuestRequest>,
) -> Result<Json<ConstructorQuestWire>, AppError> {
    require_editor(&state, &headers).await?;
    if req.quest_id.trim().is_empty() {
        return Err(AppError::BadRequest("quest_id is required".into()));
    }
    let (author_id, author_name) = acting_author(&state, &headers).await?;
    let now = store::now_secs();
    let quest = ConstructorQuest {
        quest_id: req.quest_id,
        author_id,
        author_name,
        name: req.name,
        status: store::CTOR_STATUS_DRAFT.to_string(),
        cover: req.cover,
        steps_count: req.steps_count,
        created_at: now,
        updated_at: now,
        body: req.body,
    };
    let summary = state.constructor.create(quest).await?;
    Ok(Json(ctor_wire(summary, 0)))
}

/// Body for POST /api/constructor/quests/{id}/save (autosave).
#[derive(serde::Deserialize)]
struct SaveConstructorQuestRequest {
    name: String,
    cover: Option<String>,
    steps_count: u32,
    body: serde_json::Value,
}

async fn save_constructor_quest_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SaveConstructorQuestRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_owned_constructor_quest(&state, &headers, &quest_id).await?;
    let now = store::now_secs();
    let s = state
        .constructor
        .save_body(&quest_id, &req.name, req.cover, req.steps_count, req.body, now)
        .await?;
    Ok(Json(
        serde_json::json!({ "status": "saved", "quest_id": s.quest_id, "updated_at": s.updated_at }),
    ))
}

/// Body for POST /api/constructor/quests/{id}/status.
#[derive(serde::Deserialize)]
struct SetConstructorStatusRequest {
    status: String,
}

async fn set_constructor_status_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetConstructorStatusRequest>,
) -> Result<Json<ConstructorQuestWire>, AppError> {
    require_owned_constructor_quest(&state, &headers, &quest_id).await?;
    store::validate_ctor_status(&req.status)?;
    // Coherence invariant: a quest can be `test` or `published` ONLY once a frozen
    // snapshot exists (created by the gated Publish in the editor). Without this, a
    // bare status flip could claim the quest is live while nothing is playable or
    // sellable — and because the store lists `status == published`, the author would
    // get a quest stuck at "published but never in the store" (the reported bug).
    // `draft` (delist / park) is always allowed. publish_quest_handler sets the
    // status directly AFTER registering the snapshot, so it is unaffected by this.
    if req.status != store::CTOR_STATUS_DRAFT
        && state.grants.get_published(&quest_id).await?.is_none()
    {
        return Err(AppError::BadRequest(
            "publish a version in the editor before marking the quest as «test» or «published»"
                .into(),
        ));
    }
    let now = store::now_secs();
    let updated = state
        .constructor
        .set_status(&quest_id, &req.status, now)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("constructor quest '{quest_id}' not found")))?;
    let completed = state
        .store
        .completions_by_quest()
        .await?
        .get(&updated.quest_id)
        .copied()
        .unwrap_or(0);
    Ok(Json(ctor_wire(updated, completed)))
}

async fn delete_constructor_quest_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    require_owned_constructor_quest(&state, &headers, &quest_id).await?;
    if !state.constructor.delete(&quest_id).await? {
        return Err(AppError::NotFound(format!(
            "constructor quest '{quest_id}' not found"
        )));
    }
    Ok(Json(
        serde_json::json!({ "status": "deleted", "quest_id": quest_id }),
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

/// Marketplace catalog row: the stored [`PublishedMeta`] plus the live aggregate
/// rating. The rating is a pure projection of the current published version's
/// finale `quest_rated` facts (never stored), so a freshly published quest reports
/// `rating_count: 0` and the client shows "no ratings yet" instead of a fake score.
#[derive(serde::Serialize)]
struct CatalogQuest {
    #[serde(flatten)]
    meta: PublishedMeta,
    rating_avg: f64,
    rating_count: usize,
}

async fn list_quests_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<CatalogQuest>>, AppError> {
    // Store visibility is governed by the AUTHORITATIVE lifecycle status
    // (constructor_quests.status) — the single source of truth — NOT by the mere
    // presence of a frozen snapshot. The marketplace lists ONLY `published` quests:
    // a quest the author moved to `test` or `draft` keeps its snapshot (still
    // resolvable by direct link, grant-gated) but disappears from the store. This is
    // the root-cause fix for "a test/draft quest still shows in the store": before,
    // the catalog returned every `published_quests` row regardless of status, so a
    // publish-then-unpublish left the row (and thus the store card) behind.
    //
    // A `published_quests` row with NO constructor row (a quest published straight
    // through the API, e.g. a legacy/operator publish) has no managed lifecycle and
    // is treated as published — preserving prior behavior for that path.
    //
    // The two reads hit different tables with no data dependency, so run them
    // concurrently.
    let (published, statuses) = tokio::join!(
        state.grants.list_published(),
        state.constructor.statuses_by_quest(),
    );
    let published = published?;
    let statuses = statuses?;
    let mut out = Vec::with_capacity(published.len());
    for meta in published {
        // Hidden when the author moved it to `test`/`draft`; listed when `published`
        // or when there is no constructor row (legacy/direct publish).
        if statuses
            .get(&meta.quest_id)
            .map(String::as_str)
            .is_some_and(|s| s != store::CTOR_STATUS_PUBLISHED)
        {
            continue;
        }
        // Aggregate ratings for the version on sale (the published snapshot),
        // reusing the same projector the author dashboard's version-stats use.
        // grants_count does not affect the rating fields, so pass 0.
        let stats = state.store.get_version_stats(&meta.snapshot_id, 0).await?;
        out.push(CatalogQuest {
            meta,
            rating_avg: stats.rating_avg,
            rating_count: stats.rating_count,
        });
    }
    Ok(Json(out))
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
    /// Access role (admin/editor/player) — drives the admin-surface nav/gate client-side.
    role: String,
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
        .register_user(&req.player_id, &req.email, &password_hash, req.display_name)
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
        role: account.role,
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
        role: record.account.role,
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
    let account = state.auth.get_user(&player_id).await?;
    Ok(Json(match account {
        Some(a) => serde_json::json!({
            "player_id": a.player_id, "registered": true,
            "email": a.email, "display_name": a.display_name, "role": a.role,
        }),
        None => serde_json::json!({
            "player_id": player_id, "registered": false,
            "email": null, "display_name": null, "role": null,
        }),
    }))
}

/// One registered account as served by the admin user list (admin-users spec).
/// Carries the public identity, role and registration time — never the password
/// hash or session tokens. The backend does not model telegram/phone, so the UI
/// renders contact fields present-only and simply omits the ones it has no data for.
#[derive(serde::Serialize)]
struct AdminUserWire {
    player_id: String,
    email: String,
    display_name: Option<String>,
    role: String,
    created_at: u64,
}

impl From<auth::UserAccount> for AdminUserWire {
    fn from(a: auth::UserAccount) -> Self {
        Self {
            player_id: a.player_id,
            email: a.email,
            display_name: a.display_name,
            role: a.role,
            created_at: a.created_at,
        }
    }
}

/// Body for POST /api/admin/users/{player_id}/role.
#[derive(serde::Deserialize)]
struct SetRoleRequest {
    role: String,
}

/// Admin user list: every registered account, newest registration first. Admin-gated
/// (session-admin or the shared `ADMIN_TOKEN`). Anonymous devices have no account row,
/// so only real accounts appear — bounded by the number of registrations.
async fn list_users_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminUserWire>>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let users = state.auth.list_users().await?;
    Ok(Json(users.into_iter().map(AdminUserWire::from).collect()))
}

/// Assign a role to a registered account. Admin-gated, with three guards:
///   * an unknown role value → 400 ([`auth::validate_role`]);
///   * a session-admin changing THEIR OWN role → 409 (prevents accidental
///     self-lockout; the shared-secret ops path has no "self" and is exempt, so it
///     can still recover any state);
///   * an unknown/anonymous id → 404 (only registered accounts have a role).
async fn set_user_role_handler(
    State(state): State<AppState>,
    Path(player_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetRoleRequest>,
) -> Result<Json<AdminUserWire>, AppError> {
    let actor = require_admin_actor(&state, &headers).await?;
    auth::validate_role(&req.role)?;
    if actor.player_id.as_deref() == Some(player_id.as_str()) {
        return Err(AppError::Conflict(
            "an admin cannot change their own role".into(),
        ));
    }
    let updated = state.auth.set_role(&player_id, &req.role).await?;
    Ok(Json(updated.into()))
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
    // Caller-scoped, PK-indexed lookup — never load every player's grants to count one's own.
    let grants_count = state.grants.grants_for_player(&player_id).await?.len();
    Ok(Json(facts::project_player_stats(&logs, grants_count)))
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

    // Build the media store once — R2-vs-in-process selection is orthogonal to the
    // DB backend, so it lives above the DATABASE_URL match and is injected into
    // whichever branch runs (one fallible init, no per-branch duplication).
    let media =
        MediaStores::from_config(&config.media).context("failed to initialize media store")?;

    let state = match std::env::var("DATABASE_URL") {
        Ok(url) => {
            // Pool size is env-tunable (DB_MAX_CONNECTIONS, default 5). Kept modest
            // so several app instances stay within a managed pooler's connection
            // budget (e.g. Supabase's session pooler); raise it for a bigger plan.
            let max_connections: u32 = std::env::var("DB_MAX_CONNECTIONS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(5);
            // Bounded retry around the eager connect. A remote/managed Postgres can
            // briefly refuse connections on a cold start or transient blip, and the
            // migration step below connects immediately. A few backed-off attempts
            // absorb that instead of exiting and leaning on the supervisor to
            // crash-loop; a longer outage still falls through to Restart=always.
            // Options are rebuilt per attempt (connect consumes them).
            let pool = {
                let mut attempt: u32 = 1;
                loop {
                    let opts = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(max_connections)
                        // Recycle pooled connections: a managed pooler (Supabase
                        // Supavisor) can drop server-side connections under an idle pool.
                        .acquire_timeout(Duration::from_secs(10))
                        .idle_timeout(Duration::from_secs(600))
                        .max_lifetime(Duration::from_secs(1800));
                    match opts.connect(&url).await {
                        Ok(pool) => break pool,
                        Err(e) if attempt < 5 => {
                            let backoff = Duration::from_secs(u64::from(attempt));
                            tracing::warn!(
                                attempt,
                                error = %e,
                                "failed to connect to DATABASE_URL; retrying in {}s",
                                backoff.as_secs()
                            );
                            tokio::time::sleep(backoff).await;
                            attempt += 1;
                        }
                        Err(e) => {
                            return Err(e)
                                .context("failed to connect to DATABASE_URL after 5 attempts");
                        }
                    }
                }
            };
            sqlx::migrate!("./migrations")
                .run(&pool)
                .await
                .context("failed to run database migrations")?;
            tracing::info!(max_connections, "storage: PostgreSQL (migrations up to date)");
            AppState {
                config: config.clone(),
                store: FactStores::Postgres(pg_store::PgFactStore::new(pool.clone())),
                grants: GrantStores::Postgres(pg_store::PgGrantStore::new(pool.clone())),
                auth: AuthStores::Postgres(pg_store::PgAuthStore::new(pool.clone())),
                constructor: ConstructorStores::Postgres(pg_store::PgConstructorStore::new(pool)),
                media,
                payments: Arc::new(MockPaymentProvider),
            }
        }
        Err(_) => {
            tracing::warn!(
                "DATABASE_URL not set — using in-memory storage; ALL DATA IS LOST ON RESTART"
            );
            in_memory_state(config.clone(), media)
        }
    };

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

    /// In-process media config for tests (uploads served via `/api/media/{hash}`).
    fn test_media_cfg() -> config::MediaConfig {
        config::MediaConfig::Local {
            public_base: "http://test.local/api/media".to_string(),
        }
    }

    /// Build an in-memory `AppState` for tests — the media store comes from the
    /// config, mirroring how `main()` builds it once and injects it.
    fn test_state(config: AppConfig) -> AppState {
        let media = MediaStores::from_config(&config.media).expect("test media store");
        in_memory_state(config, media)
    }

    fn test_app() -> Router {
        build_router(test_state(AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            version: "test-0.0.0",
            admin_token: Some(TEST_ADMIN_TOKEN.to_string()),
            cors_allowed_origins: Vec::new(),
            media: test_media_cfg(),
        }))
    }

    /// Router with NO admin secret configured — admin surfaces must fail closed.
    fn test_app_no_admin() -> Router {
        build_router(test_state(AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            version: "test-0.0.0",
            admin_token: None,
            cors_allowed_origins: Vec::new(),
            media: test_media_cfg(),
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

    // ---- media upload (content-addressed blobs) ----------------------------

    #[tokio::test]
    async fn media_upload_round_trips_via_inprocess_store() {
        let app = test_app();
        let bytes = vec![137u8, 80, 78, 71, 1, 2, 3, 4]; // arbitrary "image" bytes
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/media")
                    .header("x-admin-token", TEST_ADMIN_TOKEN) // editor (ops) gate
                    .header("content-type", "image/png")
                    .body(Body::from(bytes.clone()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: Value = serde_json::from_slice(&body).unwrap();
        let hash = media::sha256_hex(&bytes);
        assert_eq!(v["hash"], hash);
        assert_eq!(v["size"], bytes.len());
        assert_eq!(v["content_type"], "image/png");
        assert_eq!(v["url"], format!("http://test.local/api/media/{hash}"));

        // The in-process serve route returns the exact bytes + content-type.
        let got = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/media/{hash}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(got.status(), StatusCode::OK);
        assert_eq!(got.headers().get("content-type").unwrap(), "image/png");
        let got_bytes = got.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(got_bytes.as_ref(), bytes.as_slice());
    }

    #[tokio::test]
    async fn media_upload_rejects_non_image() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/media")
                    .header("x-admin-token", TEST_ADMIN_TOKEN)
                    .header("content-type", "text/plain")
                    .body(Body::from("not an image"))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn media_upload_requires_editor() {
        let app = test_app();
        // No editor session and no ops token -> fail closed (403).
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/media")
                    .header("content-type", "image/png")
                    .body(Body::from(vec![1u8, 2, 3]))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn media_get_unknown_is_404() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/media/deadbeefdeadbeef")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    /// With a configured allowlist, a preflight from an allowed origin is
    /// reflected and a foreign origin is not.
    #[tokio::test]
    async fn cors_preflight_reflects_only_allowed_origin() {
        let app = build_router(test_state(AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            version: "test-0.0.0",
            admin_token: None,
            cors_allowed_origins: vec!["https://app.geohod.ru".to_string()],
            media: test_media_cfg(),
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
        // The user-management surface fails closed too: with ADMIN_TOKEN unset the
        // shared-secret header is inert, and there is no admin session to fall back
        // on, so listing is forbidden.
        let (st, _) = get_json_h(
            &app,
            "/api/admin/users",
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

    /// A registered session with `role` (promoted via the ops token), as the
    /// `Authorization: Bearer <token>` value. The account id is `{prefix}-{tag}`,
    /// derived from `tag` so the shared Postgres suite never collides; a 409 (account
    /// already exists from a prior run) falls back to login.
    async fn role_bearer(app: &Router, prefix: &str, tag: &str, role: &str) -> String {
        let id = format!("{prefix}-{tag}");
        let email = format!("{id}@example.com");
        let (st, v) = post_json(
            app,
            "/api/auth/register",
            json!({"player_id": id, "email": email, "password": "hunter2hunter2"}),
        )
        .await;
        let token = if st == StatusCode::OK {
            let (st2, _) = post_json_h(
                app,
                &format!("/api/admin/users/{id}/role"),
                json!({ "role": role }),
                &[("x-admin-token", TEST_ADMIN_TOKEN)],
            )
            .await;
            assert_eq!(st2, StatusCode::OK, "promote {role}");
            v["token"].as_str().expect("token").to_string()
        } else {
            let (_, lv) = post_json(
                app,
                "/api/auth/login",
                json!({"email": email, "password": "hunter2hunter2"}),
            )
            .await;
            lv["token"].as_str().expect("token").to_string()
        };
        format!("Bearer {token}")
    }

    /// A registered editor session authorized to publish (publish is gated on the
    /// editor capability). Returns the `Authorization: Bearer <token>` value.
    async fn editor_bearer(app: &Router, tag: &str) -> String {
        role_bearer(app, "ed", tag, "editor").await
    }

    /// A registered ADMIN session (role=admin), for the admin superuser paths
    /// (cross-author constructor management). Returns `Authorization: Bearer <token>`.
    async fn admin_bearer(app: &Router, tag: &str) -> String {
        role_bearer(app, "adm", tag, "admin").await
    }

    /// True if `quest_id` is currently listed in the public store (`GET /api/quests`).
    async fn store_has(app: &Router, quest_id: &str) -> bool {
        let (_, list) = get_json(app, "/api/quests").await;
        list.as_array()
            .map(|a| a.iter().any(|q| q["quest_id"] == quest_id))
            .unwrap_or(false)
    }

    /// Publish `body` as an editor (the editor account is derived from `ids.player`).
    /// Replaces bare `post_json(app, "/api/quests/publish", ...)` now that publish is
    /// role-gated by [`require_editor`].
    async fn publish(app: &Router, ids: &Ids, body: Value) -> (StatusCode, Value) {
        let bearer = editor_bearer(app, &ids.player).await;
        post_json_h(app, "/api/quests/publish", body, &[("authorization", &bearer)]).await
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
        let (st, _) = publish(
            app,
            ids,
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

        let (_, _) = publish(
            app,
            ids,
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

        let (_, _) = publish(
            app,
            ids,
            json!({"quest_id": ids.quest, "name": "Q", "primary_comic": "comic-q",
                   "template_summary": "demo", "snapshot_version": 1, "snapshot_id": ids.snap1,
                   "city": "Нови Сад", "duration": "1.5 часа", "price": 300}),
        )
        .await;
        let (_, list) = get_json(app, "/api/quests").await;
        let row = list
            .as_array()
            .expect("list")
            .iter()
            .find(|m| m["quest_id"] == ids.quest.as_str() && m["snapshot_id"] == ids.snap1.as_str())
            .expect("published quest is listed")
            .clone();
        // Real store-card meta the constructor collected flows into the catalog —
        // the card never has to fabricate city/duration/price.
        assert_eq!(row["city"], "Нови Сад");
        assert_eq!(row["duration"], "1.5 часа");
        assert_eq!(row["price"], 300);
        // A freshly published quest has no ratings yet — reported honestly as zero,
        // not a fake "5 (2 отзыва)". (Pure projection of finale facts.)
        assert_eq!(row["rating_count"], 0);
        assert_eq!(row["rating_avg"], 0.0);

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

    /// Store visibility tracks the AUTHORITATIVE lifecycle status, not the mere
    /// presence of a frozen snapshot. The reported bug: a quest published and then
    /// moved back to `test`/`draft` kept showing in the store. Here one
    /// constructor-tracked quest is published (listed), then walked test → draft →
    /// published; it leaves the store on every non-published status and returns on
    /// `published` WITHOUT a re-publish (the frozen snapshot is reused).
    async fn scenario_store_lists_only_published(app: &Router, ids: &Ids) {
        let bearer = editor_bearer(app, &ids.player).await;
        let auth = [("authorization", bearer.as_str())];
        let status_url = format!("/api/constructor/quests/{}/status", ids.quest);

        // A constructor draft owned by this editor — not yet in the store.
        let (st, _) = post_json_h(
            app,
            "/api/constructor/quests",
            json!({
                "quest_id": ids.quest, "name": "Q", "cover": null, "steps_count": 1,
                "body": { "id": ids.quest, "meta": { "title": "Q" }, "steps": [1], "versions": [] }
            }),
            &auth,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert!(
            !store_has(app, &ids.quest).await,
            "an unpublished draft is not in the store"
        );

        // Publish → listed (and the constructor row flips to `published`).
        let (st, _) = publish(
            app,
            ids,
            json!({"quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": ids.snap1, "snapshot": {"steps": []}}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert!(store_has(app, &ids.quest).await, "a published quest is listed");

        // → test: leaves the store (the snapshot stays, so it is still resolvable by
        // direct link — grant-gated — it is simply delisted).
        let (st, _) = post_json_h(app, &status_url, json!({"status": "test"}), &auth).await;
        assert_eq!(st, StatusCode::OK);
        assert!(
            !store_has(app, &ids.quest).await,
            "a test quest is hidden from the store"
        );

        // → draft: still hidden.
        let (st, _) = post_json_h(app, &status_url, json!({"status": "draft"}), &auth).await;
        assert_eq!(st, StatusCode::OK);
        assert!(
            !store_has(app, &ids.quest).await,
            "a draft quest is hidden from the store"
        );

        // → published again: returns to the store with NO re-publish (the same
        // frozen snapshot is reused), proving status alone drives visibility.
        let (st, _) = post_json_h(app, &status_url, json!({"status": "published"}), &auth).await;
        assert_eq!(st, StatusCode::OK);
        assert!(
            store_has(app, &ids.quest).await,
            "re-listing needs only the status flip"
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

        let (_, _) = publish(
            app,
            ids,
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
        let publish_body = |snapshot: Value| {
            json!({"quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": ids.snap1, "snapshot": snapshot})
        };

        let (st, _) = publish(app, ids, publish_body(v1.clone())).await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = publish(app, ids, publish_body(v1)).await;
        assert_eq!(st, StatusCode::OK, "identical re-publish is idempotent");
        let (st, body) = publish(app, ids, publish_body(json!({"steps": [9]}))).await;
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
        let (st, _) = publish(
            app,
            ids,
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

    /// Admin user management (admin-users spec): the dual authorizer (shared secret
    /// vs session-admin), listing without secret leakage, role assignment, and the
    /// anti-lockout + validation guards. Uses `.find` rather than length/index so it
    /// tolerates the shared, pre-populated Postgres database in `pg_full_suite`.
    async fn scenario_admin_users(app: &Router, ids: &Ids) {
        let admin_hdr = [("x-admin-token", TEST_ADMIN_TOKEN)];

        // Two fresh accounts; both default to role `player`.
        let alice = ids.player.clone();
        let bob = format!("{}-bob", ids.player);
        let (alice_email, alice_token) = register(app, &alice).await;
        let (_, bob_token) = register(app, &bob).await;
        let alice_bearer = format!("Bearer {alice_token}");
        let bob_bearer = format!("Bearer {bob_token}");

        // /me carries the role; a fresh account is a player.
        let (st, me) =
            get_json_h(app, "/api/players/me", &[("authorization", &alice_bearer)]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["role"], "player");

        // The list is admin-gated: anonymous and plain-player sessions are refused.
        let (st, _) = get_json(app, "/api/admin/users").await;
        assert_eq!(st, StatusCode::FORBIDDEN, "anonymous cannot list users");
        let (st, _) =
            get_json_h(app, "/api/admin/users", &[("authorization", &bob_bearer)]).await;
        assert_eq!(st, StatusCode::FORBIDDEN, "a player session cannot list users");

        // The shared secret lists accounts (ops/bootstrap path) and leaks no secret.
        let (st, list) = get_json_h(app, "/api/admin/users", &admin_hdr).await;
        assert_eq!(st, StatusCode::OK);
        let users = list.as_array().expect("users array");
        let alice_row = users
            .iter()
            .find(|u| u["player_id"] == alice.as_str())
            .expect("alice present in list");
        assert_eq!(alice_row["role"], "player");
        assert_eq!(alice_row["email"], alice_email.as_str());
        assert!(alice_row.get("password_hash").is_none(), "no hash leak");
        assert!(alice_row.get("token").is_none(), "no token leak");

        // Bootstrap: promote Alice to admin via the shared secret.
        let role_uri = |p: &str| format!("/api/admin/users/{p}/role");
        let (st, updated) =
            post_json_h(app, &role_uri(&alice), json!({"role": "admin"}), &admin_hdr).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(updated["role"], "admin");

        // Alice's session is now an admin actor: she can list and assign roles.
        let (st, _) =
            get_json_h(app, "/api/admin/users", &[("authorization", &alice_bearer)]).await;
        assert_eq!(st, StatusCode::OK, "admin session can list");
        let admin_session = [("authorization", alice_bearer.as_str())];
        let (st, ub) =
            post_json_h(app, &role_uri(&bob), json!({"role": "editor"}), &admin_session).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(ub["role"], "editor");
        let (_, me_b) =
            get_json_h(app, "/api/players/me", &[("authorization", &bob_bearer)]).await;
        assert_eq!(me_b["role"], "editor", "bob sees his new role");

        // Anti-lockout: a session-admin cannot change their OWN role...
        let (st, _) =
            post_json_h(app, &role_uri(&alice), json!({"role": "player"}), &admin_session).await;
        assert_eq!(
            st,
            StatusCode::CONFLICT,
            "an admin cannot self-demote via a session"
        );
        // ...but the shared-secret ops path can (the recovery path has no "self").
        let (st, _) =
            post_json_h(app, &role_uri(&alice), json!({"role": "player"}), &admin_hdr).await;
        assert_eq!(st, StatusCode::OK, "ops path may change any role");

        // Validation + existence guards.
        let (st, _) =
            post_json_h(app, &role_uri(&bob), json!({"role": "superuser"}), &admin_hdr).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "unknown role rejected");
        let (st, _) = post_json_h(
            app,
            "/api/admin/users/ghost-unregistered/role",
            json!({"role": "player"}),
            &admin_hdr,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND, "unknown account rejected");
    }

    /// Publishing a quest is the editor capability (admin-roles): anonymous devices
    /// and plain `player` accounts are refused (403); an editor, an admin, and the
    /// shared ops token all succeed. This is the server enforcement behind the
    /// role-gated /quest-editor surface — a player must not be able to POST publish.
    async fn scenario_publish_authz(app: &Router, ids: &Ids) {
        let body = json!({
            "quest_id": ids.quest, "name": "Q", "template_summary": "demo",
            "snapshot_version": 1, "snapshot_id": ids.snap1
        });

        // Anonymous (device id only, no session) cannot publish.
        let (st, _) = post_json_h(
            app,
            "/api/quests/publish",
            body.clone(),
            &[("x-player-id", &ids.player)],
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN, "anonymous cannot publish");

        // A plain player session cannot publish.
        let pl = format!("{}-pl", ids.player);
        let pl_email = format!("{pl}@example.com");
        let (st, rv) = post_json(
            app,
            "/api/auth/register",
            json!({"player_id": pl, "email": pl_email, "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let pl_bearer = format!("Bearer {}", rv["token"].as_str().expect("token"));
        let (st, _) = post_json_h(
            app,
            "/api/quests/publish",
            body.clone(),
            &[("authorization", &pl_bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN, "a player cannot publish");

        // The shared ops token can publish (operator/bootstrap path).
        let (st, _) = post_json_h(
            app,
            "/api/quests/publish",
            body.clone(),
            &[("x-admin-token", TEST_ADMIN_TOKEN)],
        )
        .await;
        assert_eq!(st, StatusCode::OK, "ops token can publish");

        // An editor session can publish.
        let editor = editor_bearer(app, &ids.player).await;
        let (st, _) = post_json_h(
            app,
            "/api/quests/publish",
            body.clone(),
            &[("authorization", &editor)],
        )
        .await;
        assert_eq!(st, StatusCode::OK, "an editor can publish");

        // An admin session can publish too: promote the player to admin via ops,
        // then the SAME session token now resolves to an admin role.
        let (st, _) = post_json_h(
            app,
            &format!("/api/admin/users/{pl}/role"),
            json!({"role": "admin"}),
            &[("x-admin-token", TEST_ADMIN_TOKEN)],
        )
        .await;
        assert_eq!(st, StatusCode::OK, "promote admin");
        let (st, _) = post_json_h(
            app,
            "/api/quests/publish",
            body,
            &[("authorization", &pl_bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::OK, "an admin can publish");
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
        let (_, _) = publish(
            app,
            ids,
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
    async fn store_lists_only_published_quests() {
        scenario_store_lists_only_published(&test_app(), &Ids::new("vis")).await;
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
    async fn admin_user_management_list_and_roles() {
        scenario_admin_users(&test_app(), &Ids::new("users")).await;
    }

    #[tokio::test]
    async fn publish_requires_editor_role() {
        scenario_publish_authz(&test_app(), &Ids::new("pubauthz")).await;
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

    // ---- Constructor dashboard --------------------------------------------

    /// Editor gate: the ops token authorizes every constructor endpoint; a
    /// caller with neither a session nor the token gets 403.
    #[tokio::test]
    async fn constructor_requires_editor() {
        let app = test_app();
        let (st, _) = get_json(&app, "/api/constructor/quests").await;
        assert_eq!(st, StatusCode::FORBIDDEN, "anonymous is forbidden");
        let (st, _) =
            get_json_h(&app, "/api/constructor/quests", &[("x-admin-token", TEST_ADMIN_TOKEN)]).await;
        assert_eq!(st, StatusCode::OK, "ops token authorizes the editor surface");
    }

    /// Full CRUD lifecycle: create → list → get(body) → save → status → publish
    /// flips status → delete. Asserts the derived `completed` count too.
    #[tokio::test]
    async fn constructor_full_lifecycle() {
        let app = test_app();
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        // Empty to start.
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert_eq!(list.as_array().expect("array").len(), 0);

        // Create.
        let body = json!({
            "quest_id": "q-test",
            "name": "Тестовый квест",
            "cover": null,
            "steps_count": 2,
            "body": { "id": "q-test", "meta": { "title": "Тестовый квест" }, "steps": [1, 2], "versions": [] }
        });
        let (st, created) =
            post_json_h(&app, "/api/constructor/quests", body, &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(created["status"], "draft");
        assert_eq!(created["steps"], 2);
        assert_eq!(created["completed"], 0);
        assert_eq!(created["author"], "Оператор", "ops path is labeled generically");

        // List shows it.
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert_eq!(list.as_array().expect("array").len(), 1);
        assert_eq!(list[0]["quest_id"], "q-test");

        // Get returns the full body.
        let (st, full) =
            get_json_h(&app, "/api/constructor/quests/q-test", &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(full["body"]["steps"].as_array().expect("steps").len(), 2);

        // Save updates name + step count.
        let save = json!({
            "name": "Переименован",
            "cover": "cover.png",
            "steps_count": 5,
            "body": { "id": "q-test", "steps": [1, 2, 3, 4, 5] }
        });
        let (st, _) =
            post_json_h(&app, "/api/constructor/quests/q-test/save", save, &admin).await;
        assert_eq!(st, StatusCode::OK);
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert_eq!(list[0]["name"], "Переименован");
        assert_eq!(list[0]["steps"], 5);

        // Status: an unknown value is rejected.
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-test/status",
            json!({ "status": "live" }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        // Coherence guard: a quest with no published snapshot cannot be marked
        // `test`/`published` (otherwise it would claim to be live yet never reach
        // the store). `draft` is always allowed.
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-test/status",
            json!({ "status": "test" }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "test needs a published snapshot first");
        let (st, updated) = post_json_h(
            &app,
            "/api/constructor/quests/q-test/status",
            json!({ "status": "draft" }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(updated["status"], "draft");

        // Publishing the same quest_id creates the snapshot and flips status to published.
        let (st, _) = post_json_h(
            &app,
            "/api/quests/publish",
            json!({
                "quest_id": "q-test",
                "name": "Переименован",
                "template_summary": "2 steps",
                "snapshot_version": 1,
                "snapshot": { "steps": [] }
            }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert_eq!(list[0]["status"], "published", "publish flips lifecycle");

        // Now that a snapshot exists, the author can move it to `test` (delist) and
        // back — the guard passes because the frozen snapshot is present.
        let (st, updated) = post_json_h(
            &app,
            "/api/constructor/quests/q-test/status",
            json!({ "status": "test" }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK, "test is allowed once a snapshot exists");
        assert_eq!(updated["status"], "test");

        // Delete.
        let (st, _) =
            post_json_h(&app, "/api/constructor/quests/q-test/delete", json!({}), &admin).await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-test/delete",
            json!({}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND, "second delete is 404");
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert_eq!(list.as_array().expect("array").len(), 0);
    }

    /// Author scoping (the reported bug: an admin/editor saw EVERY author's quests
    /// in the constructor). The dashboard is a personal workspace, so two distinct
    /// authors — here two ops-token callers separated only by their device id —
    /// each see ONLY their own quest, and neither can get/save/restatus/delete the
    /// other's by id. Cross-author access is a 404 (existence hidden), not a 403,
    /// so the API never reveals that another author's quest exists.
    #[tokio::test]
    async fn constructor_is_author_scoped() {
        let app = test_app();
        let a: [(&str, &str); 2] = [("x-admin-token", TEST_ADMIN_TOKEN), ("x-player-id", "dev-a")];
        let b: [(&str, &str); 2] = [("x-admin-token", TEST_ADMIN_TOKEN), ("x-player-id", "dev-b")];

        let mk = |id: &str, name: &str| {
            json!({
                "quest_id": id, "name": name, "cover": null, "steps_count": 2,
                "body": { "id": id, "meta": { "title": name }, "steps": [1, 2], "versions": [] }
            })
        };
        let (st, _) = post_json_h(&app, "/api/constructor/quests", mk("q-a", "Квест А"), &a).await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json_h(&app, "/api/constructor/quests", mk("q-b", "Квест Б"), &b).await;
        assert_eq!(st, StatusCode::OK);

        // Each author's list contains ONLY their own quest.
        let (_, la) = get_json_h(&app, "/api/constructor/quests", &a).await;
        let la = la.as_array().expect("array");
        assert_eq!(la.len(), 1, "A sees only their own quest");
        assert_eq!(la[0]["quest_id"], "q-a");
        let (_, lb) = get_json_h(&app, "/api/constructor/quests", &b).await;
        let lb = lb.as_array().expect("array");
        assert_eq!(lb.len(), 1, "B sees only their own quest");
        assert_eq!(lb[0]["quest_id"], "q-b");

        // B cannot read / save / restatus / delete A's quest — every per-quest
        // route 404s for a non-owner.
        let (st, _) = get_json_h(&app, "/api/constructor/quests/q-a", &b).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "cannot get another author's quest");
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-a/save",
            json!({ "name": "захват", "cover": null, "steps_count": 1, "body": {} }),
            &b,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND, "cannot save another author's quest");
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-a/status",
            json!({ "status": "published" }),
            &b,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND, "cannot restatus another author's quest");
        let (st, _) =
            post_json_h(&app, "/api/constructor/quests/q-a/delete", json!({}), &b).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "cannot delete another author's quest");

        // A's quest survived every B attempt, unchanged, and A still owns it.
        let (st, full) = get_json_h(&app, "/api/constructor/quests/q-a", &a).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(full["name"], "Квест А", "A's quest is untouched by B's attempts");
    }

    /// Admin superuser reach over the constructor (the stated model: a published
    /// quest is "owned by author" yet "can be edited by admin"). Two editors each
    /// own one quest; an admin SEES BOTH and can open / restatus / delete either,
    /// while a plain editor still sees and reaches ONLY their own — the regression
    /// guard that cross-author scoping stays intact for non-admins.
    #[tokio::test]
    async fn constructor_admin_manages_any_author_quest() {
        let app = test_app();
        let a = editor_bearer(&app, "a").await;
        let b = editor_bearer(&app, "b").await;
        let admin = admin_bearer(&app, "x").await;
        let mk = |id: &str, name: &str| {
            json!({
                "quest_id": id, "name": name, "cover": null, "steps_count": 1,
                "body": { "id": id, "meta": { "title": name }, "steps": [1], "versions": [] }
            })
        };
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests",
            mk("q-eda", "A"),
            &[("authorization", a.as_str())],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests",
            mk("q-edb", "B"),
            &[("authorization", b.as_str())],
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // A plain editor sees ONLY their own quest (scoping preserved for non-admins).
        let (_, la) =
            get_json_h(&app, "/api/constructor/quests", &[("authorization", a.as_str())]).await;
        let la = la.as_array().expect("array");
        assert_eq!(la.len(), 1, "an editor sees only their own quests");
        assert_eq!(la[0]["quest_id"], "q-eda");

        // The admin sees BOTH authors' quests.
        let (_, all) =
            get_json_h(&app, "/api/constructor/quests", &[("authorization", admin.as_str())]).await;
        let all = all.as_array().expect("array");
        assert!(
            all.iter().any(|q| q["quest_id"] == "q-eda")
                && all.iter().any(|q| q["quest_id"] == "q-edb"),
            "an admin sees every author's quests"
        );

        // The admin can open, EDIT (save body) and delete ANOTHER author's quest.
        let (st, _) = get_json_h(
            &app,
            "/api/constructor/quests/q-eda",
            &[("authorization", admin.as_str())],
        )
        .await;
        assert_eq!(st, StatusCode::OK, "admin can open any author's quest");
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-edb/save",
            json!({
                "name": "B — отредактирован администратором",
                "cover": null, "steps_count": 2,
                "body": { "id": "q-edb", "meta": { "title": "B" }, "steps": [1, 2], "versions": [] }
            }),
            &[("authorization", admin.as_str())],
        )
        .await;
        assert_eq!(st, StatusCode::OK, "admin can edit any author's quest");
        // The edit persisted on B's quest.
        let (_, edited) = get_json_h(
            &app,
            "/api/constructor/quests/q-edb",
            &[("authorization", admin.as_str())],
        )
        .await;
        assert_eq!(edited["name"], "B — отредактирован администратором");
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-eda/delete",
            json!({}),
            &[("authorization", admin.as_str())],
        )
        .await;
        assert_eq!(st, StatusCode::OK, "admin can delete any author's quest");

        // A plain editor still cannot reach another editor's quest (opaque 404).
        let (st, _) = get_json_h(
            &app,
            "/api/constructor/quests/q-edb",
            &[("authorization", a.as_str())],
        )
        .await;
        assert_eq!(
            st,
            StatusCode::NOT_FOUND,
            "an editor cannot reach another author's quest"
        );
    }

    /// The reported regression: an admin creates a quest and publishes it — it MUST
    /// appear in the store. This pins both halves of the conflation that caused
    /// "published but not in the store":
    ///   * the editor publish (`/api/quests/publish`) creates the frozen snapshot,
    ///     flips status to `published`, and the quest is listed;
    ///   * a bare status flip to `published`/`test` BEFORE a snapshot exists is
    ///     rejected by the coherence guard — so the dashboard dropdown can no longer
    ///     mark a quest "published" without anything to actually sell/play.
    #[tokio::test]
    async fn admin_publish_appears_in_store_guarded_by_snapshot() {
        let app = test_app();
        let admin = admin_bearer(&app, "pubflow").await;
        let auth = [("authorization", admin.as_str())];

        // Admin creates a constructor draft.
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests",
            json!({
                "quest_id": "q-pub", "name": "Публикуемый", "cover": null, "steps_count": 1,
                "body": { "id": "q-pub", "meta": { "title": "Публикуемый" }, "steps": [1], "versions": [] }
            }),
            &auth,
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // A bare status flip to published/test before any snapshot is rejected —
        // exactly what made a dashboard-only "Опубликован" never reach the store.
        for s in ["published", "test"] {
            let (st, _) = post_json_h(
                &app,
                "/api/constructor/quests/q-pub/status",
                json!({ "status": s }),
                &auth,
            )
            .await;
            assert_eq!(st, StatusCode::BAD_REQUEST, "{s} needs a snapshot first");
        }
        assert!(!store_has(&app, "q-pub").await, "absent from the store before publishing");

        // Publishing via the editor path creates the snapshot AND lists it.
        let (st, _) = post_json_h(
            &app,
            "/api/quests/publish",
            json!({
                "quest_id": "q-pub", "name": "Публикуемый", "template_summary": "1 step",
                "snapshot_version": 1, "snapshot": { "steps": [] }
            }),
            &auth,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert!(store_has(&app, "q-pub").await, "a published quest appears in the store");

        // And now the dashboard status toggle works over the existing snapshot.
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-pub/status",
            json!({ "status": "test" }),
            &auth,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert!(!store_has(&app, "q-pub").await, "moving to test delists it");
    }

    /// The store (/api/quests) shows ONLY published quests: a freshly created
    /// constructor draft is absent until publish, then present under the SAME id.
    /// Proves there is no path from an unpublished draft into the marketplace and
    /// that no mock data pre-populates either surface.
    #[tokio::test]
    async fn unpublished_constructor_draft_absent_from_store_until_published() {
        let app = test_app();
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        // Nothing is seeded: both surfaces start empty.
        let (_, store) = get_json(&app, "/api/quests").await;
        assert_eq!(store.as_array().expect("array").len(), 0, "no seeded store quests");
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert_eq!(list.as_array().expect("array").len(), 0, "no seeded constructor quests");

        // Create a constructor draft.
        post_json_h(
            &app,
            "/api/constructor/quests",
            json!({
                "quest_id": "q-real",
                "name": "Настоящий квест",
                "cover": null,
                "steps_count": 2,
                "body": { "id": "q-real", "meta": { "title": "Настоящий квест" }, "steps": [1, 2], "versions": [] }
            }),
            &admin,
        )
        .await;

        // It is in the constructor list…
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert!(list.as_array().expect("array").iter().any(|q| q["quest_id"] == "q-real"));
        // …but NOT in the store — an unpublished draft is never buyable/playable.
        let (_, store) = get_json(&app, "/api/quests").await;
        assert_eq!(
            store.as_array().expect("array").len(),
            0,
            "an unpublished draft must not appear in the store"
        );

        // Publish it.
        let (st, _) = post_json_h(
            &app,
            "/api/quests/publish",
            json!({
                "quest_id": "q-real",
                "name": "Настоящий квест",
                "template_summary": "2 steps",
                "snapshot_version": 1,
                "snapshot": { "steps": [] }
            }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // The SAME id now appears in the store, and the constructor shows it published.
        let (_, store) = get_json(&app, "/api/quests").await;
        assert!(
            store.as_array().expect("array").iter().any(|q| q["quest_id"] == "q-real"),
            "a published quest appears in the store under its constructor id"
        );
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        let row = list
            .as_array()
            .expect("array")
            .iter()
            .find(|q| q["quest_id"] == "q-real")
            .expect("present");
        assert_eq!(row["status"], "published");
    }

    // === Postgres backend: full scenario suite + durability. Self-skips without
    // === DATABASE_URL (zero-infra dev/CI stays green); run `docker compose up -d`
    // === and set DATABASE_URL (see backend/.env.example) to execute.

    fn pg_app(pool: sqlx::PgPool) -> Router {
        let media_cfg = test_media_cfg();
        build_router(AppState {
            config: AppConfig {
                addr: "0.0.0.0:0".parse().expect("test addr"),
                version: "test-pg",
                admin_token: Some(TEST_ADMIN_TOKEN.to_string()),
                cors_allowed_origins: Vec::new(),
                media: media_cfg.clone(),
            },
            store: FactStores::Postgres(pg_store::PgFactStore::new(pool.clone())),
            grants: GrantStores::Postgres(pg_store::PgGrantStore::new(pool.clone())),
            auth: AuthStores::Postgres(pg_store::PgAuthStore::new(pool.clone())),
            constructor: ConstructorStores::Postgres(pg_store::PgConstructorStore::new(pool)),
            media: MediaStores::from_config(&media_cfg).expect("in-process media store"),
            payments: Arc::new(MockPaymentProvider),
        })
    }

    /// Exercises the REAL PgConstructorStore SQL end to end (create/list/get/save/
    /// status/delete + publish flipping status). Self-skips without DATABASE_URL,
    /// like pg_full_suite. Run-unique ids tolerate a shared DB and never collide
    /// with the fixed seed ids the 0006 cleanup targets.
    #[tokio::test]
    async fn pg_constructor_lifecycle() {
        dotenv().ok();
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("pg_constructor_lifecycle: skipped (DATABASE_URL not set)");
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
        let app = pg_app(pool);
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let run = store::now_secs() * 1_000_000 + (std::process::id() as u64 % 1_000_000);
        let qid = format!("q-citest-{run}");

        // create
        let (st, created) = post_json_h(
            &app,
            "/api/constructor/quests",
            json!({
                "quest_id": qid.clone(), "name": "CI quest", "cover": null, "steps_count": 2,
                "body": { "id": qid.clone(), "meta": { "title": "CI quest" }, "steps": [1, 2], "versions": [] }
            }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(created["status"], "draft");

        // list contains it
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert!(
            list.as_array()
                .expect("arr")
                .iter()
                .any(|q| q["quest_id"] == qid.as_str())
        );

        // --- Author scoping on real SQL (the `WHERE author_id` clause) ---
        // A second author (ops token + a distinct device id) is invisible to the
        // first: the foreign quest never appears in the "ops" list, and the foreign
        // author cannot fetch the "ops" author's quest (404 — existence hidden).
        let dev_id = format!("dev-citest-{run}");
        let dev: [(&str, &str); 2] =
            [("x-admin-token", TEST_ADMIN_TOKEN), ("x-player-id", dev_id.as_str())];
        let other_qid = format!("q-citest-other-{run}");
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests",
            json!({
                "quest_id": other_qid.clone(), "name": "CI other", "cover": null, "steps_count": 1,
                "body": { "id": other_qid.clone(), "meta": { "title": "CI other" }, "steps": [1], "versions": [] }
            }),
            &dev,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, ops_list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert!(
            ops_list
                .as_array()
                .expect("arr")
                .iter()
                .all(|q| q["quest_id"] != other_qid.as_str()),
            "another author's quest must not appear in the ops list"
        );
        let (st, _) = get_json_h(&app, &format!("/api/constructor/quests/{qid}"), &dev).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "cross-author get is hidden on SQL");
        // Clean up the foreign quest (shared-DB hygiene).
        let (st, _) =
            post_json_h(&app, &format!("/api/constructor/quests/{other_qid}/delete"), json!({}), &dev)
                .await;
        assert_eq!(st, StatusCode::OK);

        // get returns the full body
        let (st, full) =
            get_json_h(&app, &format!("/api/constructor/quests/{qid}"), &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(full["body"]["steps"].as_array().expect("steps").len(), 2);

        // save updates name + step count
        let (st, _) = post_json_h(
            &app,
            &format!("/api/constructor/quests/{qid}/save"),
            json!({
                "name": "CI renamed", "cover": "c.png", "steps_count": 4,
                "body": { "id": qid.clone(), "steps": [1, 2, 3, 4] }
            }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // status: the coherence guard rejects test/published before a snapshot
        // exists (real SQL path for get_published returning None).
        let (st, _) = post_json_h(
            &app,
            &format!("/api/constructor/quests/{qid}/status"),
            json!({ "status": "test" }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "test needs a snapshot first");

        // publish creates the snapshot and flips the constructor status to published
        let (st, _) = post_json_h(
            &app,
            "/api/quests/publish",
            json!({
                "quest_id": qid.clone(), "name": "CI renamed", "template_summary": "2 steps",
                "snapshot_version": 1, "snapshot_id": format!("{qid}-v1"), "snapshot": { "steps": [] }
            }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, full) = get_json_h(&app, &format!("/api/constructor/quests/{qid}"), &admin).await;
        assert_eq!(full["status"], "published");

        // with a snapshot present, the status toggle now succeeds (SQL get_published Some)
        let (st, updated) = post_json_h(
            &app,
            &format!("/api/constructor/quests/{qid}/status"),
            json!({ "status": "test" }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(updated["status"], "test");

        // delete
        let (st, _) = post_json_h(
            &app,
            &format!("/api/constructor/quests/{qid}/delete"),
            json!({}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = get_json_h(&app, &format!("/api/constructor/quests/{qid}"), &admin).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
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
        scenario_store_lists_only_published(&app, &Ids::new(&format!("vis-{run}"))).await;
        scenario_bundle_gated_by_grant(&app, &Ids::new(&format!("bundle-{run}"))).await;
        scenario_snapshot_immutability(&app, &Ids::new(&format!("frozen-{run}"))).await;
        scenario_admin_stats(&app, &Ids::new(&format!("admin-{run}"))).await;
        scenario_admin_users(&app, &Ids::new(&format!("users-{run}"))).await;
        scenario_publish_authz(&app, &Ids::new(&format!("pubauthz-{run}"))).await;
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
        assert_eq!(st, StatusCode::OK, "users table survives restart");
        let bearer = format!("Bearer {}", v["token"].as_str().expect("token"));
        let (st, me) = get_json_h(&app2, "/api/players/me", &[("authorization", &bearer)]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["registered"], true);
        assert_eq!(me["player_id"], enforce_ids.player.as_str());
    }
}
