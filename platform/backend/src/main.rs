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
mod coupons;
mod errors;
mod export;
mod facts;
mod features;
mod grants;
mod icons;
mod mailer;
mod media;
mod payments;
mod pg_store;
mod social;
mod store;
mod yookassa;

use std::sync::{Arc, Mutex};

use config::AppConfig;
use coupons::{Coupon, CouponUsage, Discount};
use errors::AppError;
use facts::{Fact, MigrationResult, ProjectedState};
use features::Feature;
use grants::{AccessGrant, GrantSource};
use media::{MediaRef, MediaStores};
use payments::{PendingPayment, PendingStatus};
use store::{
    AttemptMeta, AuthStores, ConstructorQuest, ConstructorQuestSummary, ConstructorStores,
    CouponStores, FactStores, FlagStores, GrantStores, InMemoryAuthStore, InMemoryConstructorStore,
    InMemoryCouponStore, InMemoryFactStore, InMemoryFlagStore, InMemoryGrantStore,
    InMemoryPaymentStore, PaymentStores, PublishedMeta,
};
use yookassa::YookassaGateway;

/// Shared application state.
#[derive(Clone)]
struct AppState {
    config: AppConfig,
    store: FactStores,
    grants: GrantStores,
    auth: AuthStores,
    /// Authoring-side quest registry (drafts + lifecycle) behind the constructor.
    constructor: ConstructorStores,
    /// Admin-managed discount codes + their redemption log (coupons spec).
    coupons: CouponStores,
    /// Content-addressed media blobs (Cloudflare R2 in prod; in-process otherwise).
    media: MediaStores,
    /// In-flight redirect payments (YooKassa): checkout writes, settlement flips.
    payment_rows: PaymentStores,
    /// Admin-set feature-toggle overrides (registry in `features.rs`; evaluation
    /// in [`feature_enabled`] — code default unless overridden).
    flags: FlagStores,
    /// YooKassa transport. `None` (credentials unset) → `provider=yookassa` is
    /// disabled (501, fail-closed); tests inject the scripted fake.
    yookassa: Option<YookassaGateway>,
    /// Transactional mail (§6.2/§6.3) — SMTP in prod, log fallback, recorder in tests.
    mailer: mailer::Mailer,
    /// Fixed-window rate limiter for abusable auth endpoints (§6.1 identify,
    /// §6.2 recover, §6.3 resend). Keyed by `"<scope>:<email>"`; the value is
    /// `(resets_at, count)`. See [`fixed_window_allow`].
    rate_limiter: Arc<Mutex<std::collections::HashMap<String, (u64, u32)>>>,
    /// Google ID-token verifier (holds the cached JWKS). `Some` only when
    /// `GOOGLE_CLIENT_ID` is configured; `None` disables `/api/auth/google` (501).
    google: Option<Arc<social::OidcVerifier>>,
    /// Telegram OIDC ID-token verifier (holds the cached JWKS). `Some` only when
    /// `TELEGRAM_CLIENT_ID` is configured; `None` disables `/api/auth/telegram` (501).
    telegram: Option<Arc<social::OidcVerifier>>,
}

/// Build the Google verifier when a client id is configured (fail-closed otherwise).
fn build_google_verifier(config: &AppConfig) -> Option<Arc<social::OidcVerifier>> {
    config
        .google_client_id
        .as_ref()
        .map(|id| Arc::new(social::OidcVerifier::google(id.clone())))
}

/// Build the Telegram verifier when a bot client id is configured (fail-closed).
fn build_telegram_verifier(config: &AppConfig) -> Option<Arc<social::OidcVerifier>> {
    config
        .telegram_client_id
        .as_ref()
        .map(|id| Arc::new(social::OidcVerifier::telegram(id.clone())))
}

fn in_memory_state(config: AppConfig, media: MediaStores) -> AppState {
    let mailer = mailer::Mailer::from_config(config.smtp_url.as_deref(), &config.mail_from);
    let google = build_google_verifier(&config);
    let telegram = build_telegram_verifier(&config);
    let yookassa = config.yookassa.clone().map(YookassaGateway::Http);
    AppState {
        config,
        store: FactStores::InMemory(Arc::new(Mutex::new(InMemoryFactStore::new()))),
        grants: GrantStores::InMemory(Arc::new(Mutex::new(InMemoryGrantStore::new()))),
        auth: AuthStores::InMemory(Arc::new(Mutex::new(InMemoryAuthStore::new()))),
        constructor: ConstructorStores::InMemory(Arc::new(Mutex::new(
            InMemoryConstructorStore::new(),
        ))),
        coupons: CouponStores::InMemory(Arc::new(Mutex::new(InMemoryCouponStore::new()))),
        media,
        payment_rows: PaymentStores::InMemory(Arc::new(Mutex::new(InMemoryPaymentStore::new()))),
        flags: FlagStores::InMemory(Arc::new(Mutex::new(InMemoryFlagStore::new()))),
        yookassa,
        mailer,
        rate_limiter: Arc::new(Mutex::new(std::collections::HashMap::new())),
        google,
        telegram,
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
    // One round-trip (session⋈users), not get_session then get_user — this runs on
    // the front of nearly every authenticated request.
    state.auth.account_for_session(&token).await
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

/// The runtime toggle verdict for a feature: the admin override when one is
/// stored, the code default otherwise. This is only the *toggle* half of the
/// evaluation — capability ([`feature_available`]) is enforced by the gated
/// endpoints themselves, so a flag can never enable what the deployment
/// cannot do.
async fn feature_enabled(state: &AppState, feature: Feature) -> Result<bool, AppError> {
    Ok(feature.effective(state.flags.override_for(feature.key()).await?))
}

/// The capability half: whether this deployment is configured for the feature
/// at all (credentials present). Reported to the admin panel so a switched-on
/// but unconfigured flag is visibly inert.
fn feature_available(state: &AppState, feature: Feature) -> bool {
    match feature {
        Feature::AuthGoogle => state.google.is_some(),
        Feature::AuthTelegram => state.telegram.is_some(),
        Feature::PaymentsMock => true,
        Feature::PaymentsYookassa => state.yookassa.is_some(),
    }
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

/// GET /api/media/{hash} — serve content-addressed media through the API's own
/// origin. Backs both stores: the in-process one (local dev / tests) and R2
/// (fetched from the bucket), so media is served without a public bucket domain.
/// A custom domain would instead serve R2 directly and this would 404 in prod.
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
        .route("/api/quests/{quest_id}", get(get_quest_product_handler))
        .route(
            "/api/quests/{quest_id}/icons/{icon}",
            get(get_quest_icon_handler),
        )
        // Media: upload (editor-gated, lifts the body cap to a single image) and
        // the serve route (serves in-process AND R2 media through this origin).
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
            post(save_constructor_quest_handler)
                .layer(DefaultBodyLimit::max(MAX_AUTHORING_BODY_BYTES)),
        )
        .route(
            "/api/constructor/quests/{quest_id}/status",
            post(set_constructor_status_handler),
        )
        .route(
            "/api/constructor/quests/{quest_id}/delete",
            post(delete_constructor_quest_handler),
        )
        .route(
            "/api/constructor/quests/{quest_id}/export",
            get(export_constructor_quest_handler),
        )
        .route("/api/checkout", post(checkout_handler))
        .route("/api/payments/providers", get(payment_providers_handler))
        .route(
            "/api/payments/yookassa/webhook",
            post(yookassa_webhook_handler),
        )
        .route("/api/payments/{payment_id}", get(payment_status_handler))
        .route("/api/coupons/validate", post(validate_coupon_handler))
        .route("/api/grants", get(list_grants_handler))
        .route(
            "/api/admin/coupons",
            get(list_coupons_handler).post(create_coupon_handler),
        )
        .route("/api/admin/coupons/{coupon_id}", get(get_coupon_handler))
        .route(
            "/api/admin/coupons/{coupon_id}/save",
            post(save_coupon_handler),
        )
        .route(
            "/api/admin/coupons/{coupon_id}/delete",
            post(delete_coupon_handler),
        )
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
        .route("/api/admin/features", get(list_features_handler))
        .route("/api/admin/features/{key}", post(set_feature_handler))
        .route("/api/migrate/legacy", post(run_migration_handler))
        .route("/api/measure/rates", get(get_measure_rates_handler))
        .route("/api/auth/register", post(register_handler))
        .route("/api/auth/identify", post(identify_handler))
        .route("/api/auth/recover", post(recover_handler))
        .route("/api/auth/reset", post(reset_password_handler))
        .route("/api/auth/confirm", post(confirm_email_handler))
        .route("/api/auth/confirm/resend", post(resend_confirm_handler))
        .route("/api/auth/change-password", post(change_password_handler))
        .route("/api/auth/display-name", post(set_display_name_handler))
        .route("/api/auth/delete-account", post(delete_account_handler))
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/google", post(google_auth_handler))
        .route("/api/auth/telegram", post(telegram_auth_handler))
        .route("/api/auth/unlink", post(unlink_handler))
        .route("/api/auth/providers", get(auth_providers_handler))
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
    /// Server-validated promo code; the discount lives in the coupon registry,
    /// never in the request (a client cannot name its own percentage).
    coupon_code: Option<String>,
    /// Payment provider: `"mock"` (default) settles instantly; `"yookassa"`
    /// starts a redirect flow (501 when the deployment has no credentials).
    provider: Option<String>,
}

/// Untagged: settled checkouts keep the historical `{grant, created}` shape;
/// redirect checkouts answer `{payment: {payment_id, confirmation_url}}`.
#[derive(serde::Serialize)]
#[serde(untagged)]
enum CheckoutResponse {
    Settled { grant: AccessGrant, created: bool },
    Redirect { payment: RedirectPayment },
}

/// The client's marching orders for a redirect provider: send the payer to
/// `confirmation_url`, then poll `GET /api/payments/{payment_id}` on return.
#[derive(serde::Serialize)]
struct RedirectPayment {
    payment_id: String,
    confirmation_url: String,
}

/// Checkout, dispatched per request on `provider`: the mock settles instantly,
/// YooKassa opens a redirect flow settled later by [`settle_payment`].
///
/// With a coupon code the registry is consulted: the redemption is recorded
/// atomically against the coupon's caps, and a discount that zeroes the price
/// grants as CouponRedemption bypassing every provider; a partial discount
/// still charges and grants as Payment. Idempotent (first grant + first audit
/// ref win), and a re-checkout of an owned quest never consumes a coupon.
async fn checkout_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CheckoutRequest>,
) -> Result<Json<CheckoutResponse>, AppError> {
    let player_id = resolve_player(&state, &headers, &req.player_id).await?;
    if state.grants.has_grant(&player_id, &req.quest_id).await? {
        // Already owned: return the stored grant unchanged (source is ignored
        // on an idempotent hit) without charging or spending a coupon.
        let (grant, created) = state
            .grants
            .create_grant_idemp(&player_id, &req.quest_id, GrantSource::Payment, None)
            .await?;
        return Ok(Json(CheckoutResponse::Settled { grant, created }));
    }
    let provider = req.provider.as_deref().unwrap_or("mock");
    match provider {
        "mock" => {
            require_provider_enabled(&state, Feature::PaymentsMock, provider).await?;
            mock_checkout(&state, &player_id, &req).await
        }
        "yookassa" => {
            require_provider_enabled(&state, Feature::PaymentsYookassa, provider).await?;
            yookassa_checkout(&state, &player_id, &req).await
        }
        other => Err(AppError::BadRequest(format!(
            "unknown payment provider: {other}"
        ))),
    }
}

/// Checkout gate for one payment provider's feature toggle. Same 501 as an
/// unconfigured provider — the client treats "disabled by an admin toggle"
/// and "deployment lacks credentials" identically.
async fn require_provider_enabled(
    state: &AppState,
    feature: Feature,
    provider: &str,
) -> Result<(), AppError> {
    if feature_enabled(state, feature).await? {
        Ok(())
    } else {
        Err(AppError::NotImplemented(format!(
            "payment provider {provider} is disabled on this server"
        )))
    }
}

/// The historical synchronous path: the mock settles instantly, so the coupon
/// is redeemed and the grant created in the same request.
async fn mock_checkout(
    state: &AppState,
    player_id: &str,
    req: &CheckoutRequest,
) -> Result<Json<CheckoutResponse>, AppError> {
    let (source, source_ref) = match &req.coupon_code {
        Some(raw) => {
            let code = coupons::normalize_code(raw)?;
            let price = quest_price(state, &req.quest_id).await?.ok_or_else(|| {
                AppError::Conflict(coupons::RedeemReject::NotApplicable.message().into())
            })?;
            let redemption = state
                .coupons
                .redeem(&code, player_id, &req.quest_id, price)
                .await?;
            if redemption.amount_discounted >= price {
                (GrantSource::CouponRedemption, None)
            } else {
                let payment_ref = payments::mock_payment_ref(player_id, &req.quest_id);
                (GrantSource::Payment, Some(payment_ref))
            }
        }
        None => {
            let payment_ref = payments::mock_payment_ref(player_id, &req.quest_id);
            (GrantSource::Payment, Some(payment_ref))
        }
    };
    let (grant, created) = state
        .grants
        .create_grant_idemp(player_id, &req.quest_id, source, source_ref)
        .await?;
    Ok(Json(CheckoutResponse::Settled { grant, created }))
}

/// A quest's positive price; `None` for free (0), unpriced, or unpublished.
async fn quest_price(state: &AppState, quest_id: &str) -> Result<Option<i64>, AppError> {
    Ok(state
        .grants
        .get_published(quest_id)
        .await?
        .and_then(|meta| meta.price)
        .filter(|p| *p > 0))
}

/// Quote a normalized coupon against a priced quest: preview + redeemability +
/// the priced discount. Never consumes the code. The inner `Err` is the
/// player-facing reason (unknown and deleted codes read the same, by design);
/// `Ok` carries the coupon's canonical code and the discount in rubles.
async fn quote_coupon(
    state: &AppState,
    code: &str,
    player_id: &str,
    quest_id: &str,
    price: i64,
) -> Result<Result<(String, i64), &'static str>, AppError> {
    let Some((coupon, used_total, used_by_player)) = state.coupons.preview(code, player_id).await?
    else {
        return Ok(Err("промокод не найден"));
    };
    if let Err(reject) = coupons::check_redeemable(
        &coupon,
        quest_id,
        used_total,
        used_by_player,
        &store::today_utc(),
    ) {
        return Ok(Err(reject.message()));
    }
    let discount = coupons::discount_amount(&coupon.discount, price);
    Ok(Ok((coupon.code, discount)))
}

/// The configured YooKassa transport, or 501 (fail-closed) when absent.
fn yookassa_gateway(state: &AppState) -> Result<&YookassaGateway, AppError> {
    state.yookassa.as_ref().ok_or_else(|| {
        AppError::NotImplemented("card payments are not configured on this deployment".into())
    })
}

/// The redirect path: create a YooKassa payment and answer with its payer page.
/// NOTHING settles here — the grant (and any coupon redemption) waits for a
/// verified `succeeded` in [`settle_payment`]. Free and coupon-100% orders
/// never reach the gateway (nothing to charge).
async fn yookassa_checkout(
    state: &AppState,
    player_id: &str,
    req: &CheckoutRequest,
) -> Result<Json<CheckoutResponse>, AppError> {
    let gateway = yookassa_gateway(state)?;
    // An open payment for this order is replayed instead of double-creating at
    // the gateway (the payer may have closed the tab mid-confirmation).
    if let Some(open) = state
        .payment_rows
        .find_pending_for(player_id, &req.quest_id)
        .await?
    {
        return Ok(Json(CheckoutResponse::Redirect {
            payment: RedirectPayment {
                payment_id: open.id,
                confirmation_url: open.confirmation_url,
            },
        }));
    }
    let meta = state
        .grants
        .get_published(&req.quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound("quest is not published".into()))?;
    let Some(price) = meta.price.filter(|p| *p > 0) else {
        // Free quest: nothing to charge — grant immediately, provider bypassed.
        let (grant, created) = state
            .grants
            .create_grant_idemp(player_id, &req.quest_id, GrantSource::FreeQuest, None)
            .await?;
        return Ok(Json(CheckoutResponse::Settled { grant, created }));
    };
    // A coupon prices the charge now but is redeemed only at settlement — an
    // abandoned payment must not burn the code. Coupon-100% has nothing to
    // charge, so it settles instantly through the synchronous path (redeem +
    // CouponRedemption grant), never reaching the gateway.
    let (coupon_code, amount) = match &req.coupon_code {
        Some(raw) => {
            let code = coupons::normalize_code(raw)?;
            let (_, discount) = quote_coupon(state, &code, player_id, &req.quest_id, price)
                .await?
                .map_err(|reason| AppError::Conflict(reason.into()))?;
            if discount >= price {
                return mock_checkout(state, player_id, req).await;
            }
            (Some(code), price - discount)
        }
        None => (None, price),
    };
    // Our id keys the poll endpoint, rides the return_url, and doubles as the
    // YooKassa Idempotence-Key (64 hex chars — within the 64-char cap).
    let payment_id = auth::generate_token();
    let return_url = format!(
        "{}/quest/{}/about?payment={}",
        state.config.frontend_base.trim_end_matches('/'),
        req.quest_id,
        payment_id
    );
    let body = yookassa::build_create_payment(
        amount,
        &format!("Квест «{}»", meta.name),
        &return_url,
        player_id,
        &req.quest_id,
    );
    let remote = gateway.create_payment(&payment_id, body).await?;
    let confirmation_url = remote.confirmation_url.clone().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!(
            "yookassa created payment {} without a confirmation_url",
            remote.id
        ))
    })?;
    state
        .payment_rows
        .insert(PendingPayment {
            id: payment_id.clone(),
            provider_payment_id: remote.id,
            player_id: player_id.to_string(),
            quest_id: req.quest_id.clone(),
            coupon_code,
            amount,
            price,
            confirmation_url: confirmation_url.clone(),
            status: PendingStatus::Pending,
            created_at: store::now_rfc3339(),
        })
        .await?;
    Ok(Json(CheckoutResponse::Redirect {
        payment: RedirectPayment {
            payment_id,
            confirmation_url,
        },
    }))
}

/// Re-check a pending payment against YooKassa and apply the outcome. Safe to
/// call from the webhook and the owner poll concurrently: the status flip is a
/// store CAS, the grant is `create_grant_idemp`, and only the CAS winner
/// redeems the held coupon. The notification body is never trusted — this is
/// the only place a redirect payment can mint a grant, and it always re-fetches
/// the authoritative status from the API.
async fn settle_payment(
    state: &AppState,
    row: &PendingPayment,
) -> Result<(PendingStatus, Option<AccessGrant>), AppError> {
    let status = match row.status {
        PendingStatus::Pending => {
            let remote = yookassa_gateway(state)?
                .fetch_payment(&row.provider_payment_id)
                .await?;
            match remote.status {
                yookassa::RemoteStatus::Succeeded => {
                    let won = state.payment_rows.settle_succeeded(&row.id).await?;
                    if won && let Some(code) = &row.coupon_code {
                        // The money is taken: a cap exhausted since checkout
                        // must not block the grant — log and move on.
                        if let Err(e) = state
                            .coupons
                            .redeem(code, &row.player_id, &row.quest_id, row.price)
                            .await
                        {
                            tracing::warn!(
                                payment = %row.id,
                                code,
                                error = ?e,
                                "coupon redemption failed at settlement; grant created anyway"
                            );
                        }
                    }
                    PendingStatus::Succeeded
                }
                yookassa::RemoteStatus::Canceled => {
                    state.payment_rows.mark_canceled(&row.id).await?;
                    PendingStatus::Canceled
                }
                yookassa::RemoteStatus::Pending | yookassa::RemoteStatus::WaitingForCapture => {
                    PendingStatus::Pending
                }
            }
        }
        settled => settled,
    };
    if status != PendingStatus::Succeeded {
        return Ok((status, None));
    }
    let (grant, _) = state
        .grants
        .create_grant_idemp(
            &row.player_id,
            &row.quest_id,
            GrantSource::Payment,
            Some(row.provider_payment_id.clone()),
        )
        .await?;
    Ok((PendingStatus::Succeeded, Some(grant)))
}

#[derive(serde::Serialize)]
struct PaymentStatusResponse {
    status: &'static str,
    grant: Option<AccessGrant>,
}

/// Owner poll for a redirect payment: lazily settles a still-pending row (the
/// return page lands here before the webhook on local/dev deployments).
async fn payment_status_handler(
    State(state): State<AppState>,
    Path(payment_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<PaymentStatusResponse>, AppError> {
    let claimed = claimed_from_headers(&headers);
    let player_id = resolve_player(&state, &headers, &claimed).await?;
    let row = state
        .payment_rows
        .get(&payment_id)
        .await?
        // A foreign payment reads as absent — ids must not be probeable.
        .filter(|p| p.player_id == player_id)
        .ok_or_else(|| AppError::NotFound("payment not found".into()))?;
    let (status, grant) = settle_payment(&state, &row).await?;
    Ok(Json(PaymentStatusResponse {
        status: status.as_str(),
        grant,
    }))
}

/// YooKassa HTTP notification. The body is only a pointer: settlement verifies
/// against the API, so a forged notification is harmless (and still gets 200).
/// Transient failures return 5xx so YooKassa keeps retrying (24h window).
async fn yookassa_webhook_handler(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<StatusCode, AppError> {
    let Some(provider_payment_id) = yookassa::notification_payment_id(&body) else {
        return Ok(StatusCode::OK); // not a payment event — nothing to settle
    };
    let Some(row) = state
        .payment_rows
        .find_by_provider_id(&provider_payment_id)
        .await?
    else {
        tracing::info!(payment = %provider_payment_id, "webhook for unknown payment ignored");
        return Ok(StatusCode::OK);
    };
    settle_payment(&state, &row).await?;
    Ok(StatusCode::OK)
}

/// Providers this deployment can charge through — drives the purchase sheet's
/// payment-method choice (a single entry renders no selector; an empty list
/// disables paying). A provider is listed only when it is both configured
/// (capability) and switched on (feature toggle).
async fn payment_providers_handler(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let overrides = state.flags.all_overrides().await?;
    let on =
        |f: Feature| feature_available(&state, f) && f.effective(overrides.get(f.key()).copied());
    let mut providers = Vec::new();
    if on(Feature::PaymentsMock) {
        providers.push("mock");
    }
    if on(Feature::PaymentsYookassa) {
        providers.push("yookassa");
    }
    Ok(Json(serde_json::json!({ "providers": providers })))
}

#[derive(serde::Deserialize)]
struct ValidateCouponRequest {
    player_id: String,
    quest_id: String,
    code: String,
}

/// Purchase-sheet promo preview: never mutates, always 200 with a verdict.
/// `{valid: true, ...}` carries the priced discount; `{valid: false, message}`
/// carries the player-facing reason (unknown and deleted codes read the same).
async fn validate_coupon_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ValidateCouponRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let player_id = resolve_player(&state, &headers, &req.player_id).await?;
    let invalid = |message: &str| serde_json::json!({"valid": false, "message": message});
    let Ok(code) = coupons::normalize_code(&req.code) else {
        return Ok(Json(invalid("промокод не найден")));
    };
    let Some(price) = state
        .grants
        .get_published(&req.quest_id)
        .await?
        .and_then(|meta| meta.price)
        .filter(|p| *p > 0)
    else {
        return Ok(Json(invalid(
            coupons::RedeemReject::NotApplicable.message(),
        )));
    };
    let (code, discount_amount) =
        match quote_coupon(&state, &code, &player_id, &req.quest_id, price).await? {
            Ok(quote) => quote,
            Err(reason) => return Ok(Json(invalid(reason))),
        };
    Ok(Json(serde_json::json!({
        "valid": true,
        "code": code,
        "price": price,
        "discount_amount": discount_amount,
        "final_price": price - discount_amount,
    })))
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
    /// Store description shown on the product page (§3.1); blank stays absent.
    #[serde(default)]
    description: Option<String>,
    /// Marketing padding for the public players counter (real completions + this).
    /// Negative values are clamped to 0 at publish so the count never drops below
    /// the honest completions figure.
    #[serde(default)]
    players_bonus: Option<i64>,
}

/// Content chips for the product page, derived from the frozen snapshot at
/// publish time: page count, task count (task_no/task_answer templates) and
/// whether any step sells a paid hint. Tolerates foreign snapshot shapes by
/// returning None — the UI hides chips it cannot honestly claim.
fn snapshot_chips(
    snapshot: Option<&serde_json::Value>,
) -> (Option<u32>, Option<u32>, Option<bool>) {
    let Some(steps) = snapshot
        .and_then(|v| v.get("steps"))
        .and_then(|v| v.as_array())
    else {
        return (None, None, None);
    };
    let pages = steps.len() as u32;
    let tasks = steps
        .iter()
        .filter(|st| {
            st.get("template")
                .and_then(|t| t.as_str())
                .is_some_and(|t| t == "task_no" || t == "task_answer")
        })
        .count() as u32;
    let paid_hints = steps.iter().any(|st| {
        st.get("supporting")
            .and_then(|sup| sup.get("hint"))
            .is_some_and(|h| !h.is_null())
    });
    (Some(pages), Some(tasks), Some(paid_hints))
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
    let (pages, tasks, paid_hints) = snapshot_chips(req.snapshot.as_ref());
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
        description: req.description.filter(|s| !s.trim().is_empty()),
        pages,
        tasks,
        paid_hints,
        players_bonus: req.players_bonus.unwrap_or(0).max(0),
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
        .set_status(
            &req.quest_id,
            store::CTOR_STATUS_PUBLISHED,
            store::now_secs(),
        )
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
    /// Distinct grant holders — the honest «{N} купивших» for destructive
    /// status confirms (§9.1). Count only, no identities.
    buyers: usize,
    /// Live published snapshot version, if any. None ⇒ the coherence guard will
    /// reject `test`/`published`, so the UI routes into the publish panel.
    published_version: Option<u32>,
    complexity: String,
    age_target: String,
    tags: Vec<String>,
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
    complexity: String,
    age_target: String,
    tags: Vec<String>,
    created_at: u64,
    updated_at: u64,
    body: serde_json::Value,
}

fn ctor_wire(
    s: ConstructorQuestSummary,
    completed: usize,
    buyers: usize,
    published_version: Option<u32>,
) -> ConstructorQuestWire {
    ConstructorQuestWire {
        quest_id: s.quest_id,
        name: s.name,
        author: s.author_name,
        author_id: s.author_id,
        status: s.status,
        steps: s.steps_count,
        completed,
        buyers,
        published_version,
        complexity: s.attrs.complexity,
        age_target: s.attrs.age_target,
        tags: s.attrs.tags,
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
            .or(account.email)
            .unwrap_or_else(|| account.player_id.clone());
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
async fn acting_author(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, String), AppError> {
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
    let buyers = state.grants.buyers_by_quest().await?;
    let published_versions: std::collections::HashMap<String, u32> = state
        .grants
        .list_published()
        .await?
        .into_iter()
        .map(|m| (m.quest_id, m.snapshot_version))
        .collect();
    Ok(Json(
        summaries
            .into_iter()
            .map(|s| {
                let c = completions.get(&s.quest_id).copied().unwrap_or(0);
                let b = buyers.get(&s.quest_id).copied().unwrap_or(0);
                let v = published_versions.get(&s.quest_id).copied();
                ctor_wire(s, c, b, v)
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
    let completed = state.store.completions_for_quest(&q.quest_id).await?;
    Ok(Json(ConstructorQuestFullWire {
        quest_id: q.quest_id,
        name: q.name,
        author: q.author_name,
        author_id: q.author_id,
        status: q.status,
        steps: q.steps_count,
        completed,
        cover: q.cover,
        complexity: q.attrs.complexity,
        age_target: q.attrs.age_target,
        tags: q.attrs.tags,
        created_at: q.created_at,
        updated_at: q.updated_at,
        body: q.body,
    }))
}

/// GET /api/constructor/quests/{quest_id}/export — the full quest as a
/// downloadable zip: quest record (all steps, attributes, cover — media URLs
/// rewritten to point into the archive) and the media files themselves.
/// Content only — play/rating stats are live projections, not quest content.
/// Owner-or-admin gated, same as every other per-quest constructor route.
async fn export_constructor_quest_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let quest = require_owned_constructor_quest(&state, &headers, &quest_id).await?;
    let filename = format!("quest-{}.zip", quest.quest_id);
    let zip_bytes = export::build_quest_export_zip(&state.media, quest).await?;

    axum::response::Response::builder()
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(axum::body::Body::from(zip_bytes))
        .map_err(|e| AppError::Internal(anyhow::anyhow!("export response build: {e}")))
}

/// Body for POST /api/constructor/quests. The client mints the id (the same id
/// publish later binds), so it is required here.
#[derive(serde::Deserialize)]
struct CreateConstructorQuestRequest {
    quest_id: String,
    name: String,
    cover: Option<String>,
    steps_count: u32,
    /// Attributes are optional on the wire (old clients omit them) and fall back
    /// to the neutral defaults; present values must belong to the closed sets.
    complexity: Option<String>,
    age_target: Option<String>,
    tags: Option<Vec<String>>,
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
    let attrs = store::QuestAttributes::from_wire(req.complexity, req.age_target, req.tags)?;
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
        attrs,
        created_at: now,
        updated_at: now,
        body: req.body,
    };
    let summary = state.constructor.create(quest).await?;
    // A freshly created id can still have a stale published row (re-created id);
    // report it honestly rather than assuming None.
    let published_version = state
        .grants
        .get_published(&summary.quest_id)
        .await?
        .map(|m| m.snapshot_version);
    let buyers = state.grants.buyers_for_quest(&summary.quest_id).await?;
    Ok(Json(ctor_wire(summary, 0, buyers, published_version)))
}

/// Body for POST /api/constructor/quests/{id}/save (autosave).
#[derive(serde::Deserialize)]
struct SaveConstructorQuestRequest {
    name: String,
    cover: Option<String>,
    steps_count: u32,
    /// Same optional-with-defaults contract as on create.
    complexity: Option<String>,
    age_target: Option<String>,
    tags: Option<Vec<String>>,
    body: serde_json::Value,
}

async fn save_constructor_quest_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SaveConstructorQuestRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_owned_constructor_quest(&state, &headers, &quest_id).await?;
    let attrs = store::QuestAttributes::from_wire(req.complexity, req.age_target, req.tags)?;
    let now = store::now_secs();
    let s = state
        .constructor
        .save_body(
            &quest_id,
            &req.name,
            req.cover,
            req.steps_count,
            attrs,
            req.body,
            now,
        )
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
    let published_version = state
        .grants
        .get_published(&quest_id)
        .await?
        .map(|m| m.snapshot_version);
    if req.status != store::CTOR_STATUS_DRAFT && published_version.is_none() {
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
    let completed = state.store.completions_for_quest(&updated.quest_id).await?;
    let buyers = state.grants.buyers_for_quest(&updated.quest_id).await?;
    Ok(Json(ctor_wire(
        updated,
        completed,
        buyers,
        published_version,
    )))
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
        // Catalog cover (lives in meta, not the frozen snapshot) so the client can
        // precache it for offline alongside the snapshot's media — same value the
        // store card resolves, so the precached bytes match what renders.
        "primary_comic": meta.primary_comic,
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
    /// Public players counter: real distinct completions + the author's marketing
    /// `players_bonus`. The raw bonus is never sent on its own (see PublishedMeta).
    players: i64,
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
    // Keep only visible quests: `published` status, or NO constructor row at all
    // (legacy/direct publish). A `test`/`draft` quest keeps its snapshot but leaves
    // the store.
    let visible: Vec<PublishedMeta> = published
        .into_iter()
        .filter(|meta| {
            statuses
                .get(&meta.quest_id)
                .map(String::as_str)
                .is_none_or(|s| s == store::CTOR_STATUS_PUBLISHED)
        })
        .collect();
    // Ratings for EVERY visible quest in ONE round-trip (was a per-quest
    // `get_version_stats` N+1 that dominated this endpoint's latency).
    let snap_ids: Vec<String> = visible.iter().map(|m| m.snapshot_id.clone()).collect();
    // Ratings (per snapshot) and completions (per quest) are independent aggregate
    // reads — run them concurrently. Completions is ONE GROUP BY over the whole set
    // (never a per-quest N+1), matching the ratings round-trip.
    let (ratings, completions) = tokio::join!(
        state.store.rating_stats_for_snapshots(&snap_ids),
        state.store.completions_by_quest(),
    );
    let ratings = ratings?;
    let completions = completions?;
    let out: Vec<CatalogQuest> = visible
        .into_iter()
        .map(|meta| {
            let (rating_avg, rating_count) =
                ratings.get(&meta.snapshot_id).copied().unwrap_or((0.0, 0));
            // Public players counter: real distinct completions + marketing bonus.
            let players =
                completions.get(&meta.quest_id).copied().unwrap_or(0) as i64 + meta.players_bonus;
            CatalogQuest {
                meta,
                rating_avg,
                rating_count,
                players,
            }
        })
        .collect();
    Ok(Json(out))
}

/// Product page payload (§3.1/§12.9): ONLY model data — the published card, the
/// live rating aggregates, the constructor's store description, author display
/// name + how many of their quests are on sale, and snapshot-derived content
/// chips. Visibility matches the catalog: a delisted quest 404s here too.
#[derive(serde::Serialize)]
struct ProductPageWire {
    #[serde(flatten)]
    meta: PublishedMeta,
    rating_avg: f64,
    rating_count: usize,
    /// Public players counter: real distinct completions + marketing `players_bonus`.
    players: i64,
    /// Author display label from the constructor row; None for legacy/direct
    /// publishes that have no constructor lifecycle.
    author_name: Option<String>,
    /// How many of this author's quests are currently on sale.
    author_published_count: u32,
    /// §11 reviews v1: newest-first, first page of 10.
    reviews: Vec<ReviewWire>,
    /// Total ratings that carry text («{M} с отзывом»).
    reviews_total: usize,
}

/// §11: one public review — author FIRST NAME only (display name's first word;
/// anonymous → «Игрок»), never an email; month-precision timestamp client-side.
#[derive(serde::Serialize)]
struct ReviewWire {
    author: String,
    rating: i64,
    text: String,
    created_at: u64,
}

/// First word of the display name; accounts without one (and anonymous
/// players) are «Игрок». Emails never leak into reviews.
fn review_author_label(display_name: Option<&str>) -> String {
    display_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.split_whitespace().next())
        .unwrap_or("Игрок")
        .to_string()
}

async fn get_quest_product_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
) -> Result<Json<ProductPageWire>, AppError> {
    let not_found = || AppError::NotFound(format!("quest '{quest_id}' not found"));
    let meta = state
        .grants
        .get_published(&quest_id)
        .await?
        .ok_or_else(not_found)?;
    // Same visibility rule as the catalog: the authoritative lifecycle status
    // hides test/draft quests; a missing constructor row means a legacy/direct
    // publish and stays visible.
    let ctor = state.constructor.get(&quest_id).await?;
    if ctor
        .as_ref()
        .is_some_and(|q| q.status != store::CTOR_STATUS_PUBLISHED)
    {
        return Err(not_found());
    }
    let stats = state.store.get_version_stats(&meta.snapshot_id, 0).await?;
    let (author_name, author_published_count) = match &ctor {
        None => (None, 0),
        Some(q) => {
            let published = state
                .constructor
                .list_summaries_for_author(&q.author_id)
                .await?
                .into_iter()
                .filter(|s| s.status == store::CTOR_STATUS_PUBLISHED)
                .count() as u32;
            (Some(q.author_name.clone()), published)
        }
    };
    // §11 reviews: last quest_rated WITH text per attempt, newest first.
    let review_rows = state.store.reviews_for_quest(&quest_id, 1000).await?;
    let reviews_total = review_rows.len();
    let page: Vec<store::ReviewRow> = review_rows.into_iter().take(10).collect();
    // Author display names in ONE round-trip (was one get_user per review — an N+1).
    let author_ids: Vec<String> = page.iter().map(|r| r.player_id.clone()).collect();
    let authors = state.auth.get_users_by_ids(&author_ids).await?;
    let reviews: Vec<ReviewWire> = page
        .into_iter()
        .map(|r| ReviewWire {
            author: review_author_label(
                authors
                    .get(&r.player_id)
                    .and_then(|a| a.display_name.as_deref()),
            ),
            rating: r.rating,
            text: r.text,
            created_at: r.created_at,
        })
        .collect();
    // Public players counter: real distinct completions + marketing bonus, same
    // basis as the store card so the two never disagree.
    let players = state.store.completions_for_quest(&quest_id).await? as i64 + meta.players_bonus;
    Ok(Json(ProductPageWire {
        meta,
        rating_avg: stats.rating_avg,
        rating_count: stats.rating_count,
        players,
        author_name,
        author_published_count,
        reviews,
        reviews_total,
    }))
}

/// §5/§12.7 — GET /api/quests/{id}/icons/{192|512}.png: the per-quest PWA
/// home-screen icon, composed from the published cover (center-crop, maskable
/// padding on brand navy). Immutable per published version — the manifest keys
/// the URL with ?v={snapshot_version}, so far-future caching is safe.
async fn get_quest_icon_handler(
    State(state): State<AppState>,
    Path((quest_id, icon)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let size: u32 = match icon.as_str() {
        "192.png" => 192,
        "512.png" => 512,
        _ => return Err(AppError::NotFound(format!("icon '{icon}' not found"))),
    };
    let meta = state
        .grants
        .get_published(&quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("quest '{quest_id}' not found")))?;
    let cover = meta
        .primary_comic
        .as_deref()
        .ok_or_else(|| AppError::NotFound("quest has no cover".into()))?;
    let bytes: Vec<u8> = if let Some(data) = icons::cover_data_uri_bytes(cover) {
        data
    } else if let Some(hash) = media::media_hash_in_ref(cover) {
        state
            .media
            .get(hash)
            .await?
            .ok_or_else(|| AppError::NotFound("cover media not found".into()))?
            .bytes
            .to_vec()
    } else {
        return Err(AppError::NotFound(
            "cover is not a resolvable media ref".into(),
        ));
    };
    let png = icons::compose_icon(&bytes, size)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("icon compose failed: {e}")))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png".to_string()),
            (
                header::CACHE_CONTROL,
                "public, max-age=31536000, immutable".to_string(),
            ),
        ],
        png,
    ))
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
    /// Login email — `null` for a social-only account (Telegram, or Google before
    /// an email is attached). The client shows the display name in that case.
    email: Option<String>,
    display_name: Option<String>,
    /// Access role (admin/editor/player) — drives the admin-surface nav/gate client-side.
    role: String,
    token: String,
}

async fn register_handler(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let email = auth::normalize_email(&req.email);
    auth::validate_credentials(&email, &req.password)?;
    if req.player_id.is_empty() {
        return Err(AppError::BadRequest("player_id is required".into()));
    }
    let password_hash = auth::hash_password(&req.password)?;
    let account = state
        .auth
        .register_user(&req.player_id, &email, &password_hash, req.display_name)
        .await?;
    let token = auth::generate_token();
    state
        .auth
        .create_session(&token, &account.player_id)
        .await?;
    // §6.3 soft confirmation: the account works immediately; the mail is
    // best-effort and the Profile banner offers a resend.
    send_confirm_email(&state, &account.player_id, &email).await?;
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
        .find_by_email(&auth::normalize_email(&req.email))
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

// ============ Social sign-in (Google, Telegram) ============

/// A verified provider identity, provider-agnostic, ready for link-or-create.
struct SocialIdentity {
    provider: &'static str,
    subject: String,
    /// Provider-supplied email, canonicalized. `None` for Telegram.
    email: Option<String>,
    /// Whether the provider vouches for the email (Google `email_verified`). Only
    /// a verified email may auto-link to an existing same-email account.
    email_verified: bool,
    display_name: Option<String>,
}

/// POST /api/auth/google — `{credential, player_id}` where `credential` is a
/// Google Identity Services ID token. Fail-closed (501) when unconfigured.
#[derive(serde::Deserialize)]
struct GoogleAuthRequest {
    credential: String,
    player_id: String,
}

async fn google_auth_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<GoogleAuthRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    if !feature_enabled(&state, Feature::AuthGoogle).await? {
        return Err(AppError::NotImplemented(
            "google sign-in is disabled on this server".into(),
        ));
    }
    let verifier = state.google.clone().ok_or_else(|| {
        AppError::NotImplemented("google sign-in is not configured on this server".into())
    })?;
    let token = verifier.verify(&req.credential, store::now_secs()).await?;
    let claims = social::GoogleClaims::from_claims(token)?;
    let ident = SocialIdentity {
        provider: auth::PROVIDER_GOOGLE,
        subject: claims.sub,
        email: claims.email,
        email_verified: claims.email_verified,
        display_name: claims.name,
    };
    complete_social_login(&state, &headers, &req.player_id, ident)
        .await
        .map(Json)
}

/// POST /api/auth/telegram — `{id_token, player_id}` where `id_token` is the OIDC
/// JWT that `telegram-login.js` returns. Fail-closed (501) when unconfigured.
#[derive(serde::Deserialize)]
struct TelegramAuthRequest {
    id_token: String,
    player_id: String,
}

async fn telegram_auth_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TelegramAuthRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    if !feature_enabled(&state, Feature::AuthTelegram).await? {
        return Err(AppError::NotImplemented(
            "telegram login is disabled on this server".into(),
        ));
    }
    let verifier = state.telegram.clone().ok_or_else(|| {
        AppError::NotImplemented("telegram login is not configured on this server".into())
    })?;
    let token = verifier.verify(&req.id_token, store::now_secs()).await?;
    let claims = social::TelegramClaims::from_claims(token)?;
    let ident = SocialIdentity {
        provider: auth::PROVIDER_TELEGRAM,
        subject: claims.subject(),
        email: None,
        email_verified: false,
        display_name: claims.display_name(),
    };
    complete_social_login(&state, &headers, &req.player_id, ident)
        .await
        .map(Json)
}

/// Link a verified social identity to an account and return a fresh session,
/// preserving the caller's anonymous player_id where possible (player-identity
/// spec): (1) an already-linked identity logs into its account; (2) a logged-in
/// caller links it to their account; (3) a Google-verified email links to the
/// matching existing account; (4) otherwise it attaches to the anonymous id,
/// creating an account there so prior coins/grants survive.
async fn complete_social_login(
    state: &AppState,
    headers: &HeaderMap,
    claimed_player_id: &str,
    ident: SocialIdentity,
) -> Result<AuthResponse, AppError> {
    // 1. Existing identity → login to that account (any device).
    if let Some(pid) = state
        .auth
        .find_identity(ident.provider, &ident.subject)
        .await?
    {
        return issue_session_for(state, &pid).await;
    }

    // Choose the account to attach the NEW identity to.
    let target = if let Some(account) = session_account(state, headers).await? {
        // 2. Logged-in caller → link to their account.
        account.player_id
    } else if ident.email_verified
        && let Some(email) = ident.email.as_ref()
        && let Some(record) = state.auth.find_by_email(email).await?
    {
        // 3. Verified provider email matches an existing account → link to it.
        record.account.player_id
    } else {
        // 4. Attach to the caller's anonymous id (creating an account there).
        create_social_on_claimed(state, headers, claimed_player_id, &ident).await?
    };

    // Link the identity. A concurrent duplicate is absorbed as a login below.
    match state
        .auth
        .create_identity(store::AuthIdentity {
            provider: ident.provider.to_string(),
            subject: ident.subject.clone(),
            player_id: target.clone(),
            email: ident.email.clone(),
            created_at: store::now_secs(),
        })
        .await
    {
        Ok(()) => {}
        // Racing request already linked this identity — fall through to a session.
        Err(AppError::Conflict(_)) => {}
        Err(e) => return Err(e),
    }

    // A verified Google email gives an emailless account (Telegram-created, or a
    // fresh anon account) a real email login — best-effort; a collision is ignored.
    if ident.email_verified
        && let Some(email) = ident.email.as_ref()
    {
        let _ = state
            .auth
            .attach_email(&target, email, store::now_secs())
            .await;
    }

    issue_session_for(state, &target).await
}

/// Attach step (4): resolve the anonymous claim (rejecting a registered id with no
/// token — the exact resolve_player invariant), then create a social account keyed
/// to it so prior grants/coins survive. A taken Google email degrades to no email.
async fn create_social_on_claimed(
    state: &AppState,
    headers: &HeaderMap,
    claimed_player_id: &str,
    ident: &SocialIdentity,
) -> Result<String, AppError> {
    let pid = resolve_player(state, headers, claimed_player_id).await?;
    if state.auth.get_user(&pid).await?.is_some() {
        // Already an account we're authorized to act as (bearer path) — link to it.
        return Ok(pid);
    }
    let email = if ident.email_verified {
        ident.email.clone()
    } else {
        None
    };
    let confirmed = email.as_ref().map(|_| store::now_secs());
    match state
        .auth
        .create_social_account(&pid, email.clone(), ident.display_name.clone(), confirmed)
        .await
    {
        Ok(account) => Ok(account.player_id),
        // The Google email is taken by another account — create without an email;
        // the identity still links, so the user reaches a working account.
        Err(AppError::Conflict(_)) if email.is_some() => {
            let account = state
                .auth
                .create_social_account(&pid, None, ident.display_name.clone(), None)
                .await?;
            Ok(account.player_id)
        }
        Err(e) => Err(e),
    }
}

/// Mint a session for an existing account and shape the standard `AuthResponse`.
async fn issue_session_for(state: &AppState, player_id: &str) -> Result<AuthResponse, AppError> {
    let account = state
        .auth
        .get_user(player_id)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("account not found after link")))?;
    let token = auth::generate_token();
    state.auth.create_session(&token, player_id).await?;
    Ok(AuthResponse {
        player_id: account.player_id,
        email: account.email,
        display_name: account.display_name,
        role: account.role,
        token,
    })
}

/// GET /api/auth/providers — which social buttons the client should render, and
/// the PUBLIC client ids they need (Google client id for GIS, Telegram bot client
/// id for `Telegram.Login.init`). `null` when unconfigured OR switched off by
/// the admin feature toggle — either way the UI hides the button.
async fn auth_providers_handler(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let overrides = state.flags.all_overrides().await?;
    let on = |f: Feature| f.effective(overrides.get(f.key()).copied());
    Ok(Json(serde_json::json!({
        "google_client_id": on(Feature::AuthGoogle)
            .then(|| state.config.google_client_id.clone())
            .flatten(),
        "telegram_client_id": on(Feature::AuthTelegram)
            .then(|| state.config.telegram_client_id.clone())
            .flatten(),
    })))
}

/// POST /api/auth/unlink — `{provider}`. Removes a linked social provider from the
/// current account, refusing to remove the LAST sign-in method (so the account can
/// never become unreachable).
#[derive(serde::Deserialize)]
struct UnlinkRequest {
    provider: String,
}

async fn unlink_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<UnlinkRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    auth::validate_provider(&req.provider)?;
    let account = session_account(&state, &headers)
        .await?
        .ok_or_else(|| AppError::Unauthorized("login required".into()))?;
    let identities = state.auth.identities_for_player(&account.player_id).await?;
    // Not-linked is a 404 regardless of the method count — checked first so a
    // no-op unlink never masquerades as the "last method" conflict.
    if !identities.iter().any(|i| i.provider == req.provider) {
        return Err(AppError::NotFound("этот способ входа не подключён".into()));
    }
    // Sign-in methods = the email/password login (if any) + each linked provider.
    let methods = identities.len() + usize::from(account.email.is_some());
    if methods <= 1 {
        return Err(AppError::Conflict(
            "нельзя отвязать единственный способ входа".into(),
        ));
    }
    state
        .auth
        .delete_identity(&req.provider, &account.player_id)
        .await?;
    Ok(Json(serde_json::json!({ "status": "unlinked" })))
}

// ============ Auth v2 (§6/§12.1–5) ============

/// Password-reset link TTL (30 minutes — stated in the «Письмо ушло» copy).
const RESET_TOKEN_TTL_SECS: u64 = 30 * 60;
/// Email-confirmation link TTL (7 days — soft confirmation, no urgency).
const CONFIRM_TOKEN_TTL_SECS: u64 = 7 * 24 * 3600;
/// §6.1 identify rate limit: requests per fixed window, per email.
const IDENTIFY_LIMIT: u32 = 10;
const IDENTIFY_WINDOW_SECS: u64 = 60;
/// §6.2/§6.3 mail-sending rate limit (recover, resend-confirm), per email.
/// The server is the boundary — the UI cooldown is advisory only.
const MAIL_SEND_LIMIT: u32 = 5;
const MAIL_SEND_WINDOW_SECS: u64 = 3600;
/// Above this many limiter keys, expired windows are evicted before insert so
/// an attacker spraying unique emails cannot grow memory without bound.
const RATE_LIMITER_MAX_KEYS: usize = 100_000;

/// Fixed-window rate limit: up to `limit` hits per `window_secs` for `key`
/// (`"<scope>:<email>"`); over the limit is a 429.
fn fixed_window_allow(
    state: &AppState,
    key: String,
    window_secs: u64,
    limit: u32,
) -> Result<(), AppError> {
    let now = store::now_secs();
    let mut lim = state
        .rate_limiter
        .lock()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("limiter poisoned: {e}")))?;
    if lim.len() >= RATE_LIMITER_MAX_KEYS && !lim.contains_key(&key) {
        lim.retain(|_, (resets_at, _)| *resets_at > now);
    }
    let entry = lim.entry(key).or_insert((now + window_secs, 0));
    if entry.0 <= now {
        *entry = (now + window_secs, 0);
    }
    entry.1 += 1;
    if entry.1 > limit {
        return Err(AppError::TooManyRequests(
            "too many attempts — try again later".into(),
        ));
    }
    Ok(())
}

/// Mint a single-use (token, 6-digit code) pair sharing ONE store row —
/// consuming either credential kills both — and return the RAW pair
/// (mail-only); only hashes are stored. Issuing invalidates prior unused
/// tokens of the same kind (latest mail wins).
async fn issue_auth_token(
    state: &AppState,
    player_id: &str,
    kind: &str,
    ttl_secs: u64,
) -> Result<(String, String), AppError> {
    let token = auth::generate_token();
    let code = auth::generate_reset_code();
    state
        .auth
        .create_auth_token(
            &media::sha256_hex(token.as_bytes()),
            store::AuthTokenRecord {
                player_id: player_id.to_string(),
                kind: kind.to_string(),
                code_hash: media::sha256_hex(code.as_bytes()),
                expires_at: store::now_secs() + ttl_secs,
                used_at: None,
                attempts: 0,
            },
        )
        .await?;
    Ok((token, code))
}

/// Best-effort transactional mail — a down SMTP must not fail the parent flow.
async fn send_mail_best_effort(state: &AppState, to: &str, subject: &str, body: &str) {
    if let Err(e) = state.mailer.send(to, subject, body).await {
        tracing::error!(to, subject, "transactional mail failed: {e}");
    }
}

async fn send_confirm_email(
    state: &AppState,
    player_id: &str,
    email: &str,
) -> Result<(), AppError> {
    // Confirmation is link-only (§6.3 is soft, nobody types codes for it) —
    // the minted code is simply never mailed, so it is unusable.
    let (token, _code) = issue_auth_token(
        state,
        player_id,
        store::TOKEN_KIND_CONFIRM,
        CONFIRM_TOKEN_TTL_SECS,
    )
    .await?;
    let link = format!("{}/auth/confirm?token={token}", state.config.frontend_base);
    send_mail_best_effort(
        state,
        email,
        "Подтвердите почту — GEOHOD QUEST",
        &format!(
            "Здравствуйте!\n\nПодтвердите почту для аккаунта GEOHOD QUEST — откройте ссылку:\n{link}\n\nЕсли вы не создавали аккаунт, просто игнорируйте это письмо."
        ),
    )
    .await;
    Ok(())
}

/// Body for POST /api/auth/identify (§6.1): the email-first step.
#[derive(serde::Deserialize)]
struct IdentifyRequest {
    email: String,
}

/// §6.1 — does this email have an account? Drives the single-form flow (the
/// 409 «already registered» class disappears by construction). Rate-limited
/// per email (fixed window) — it is intentionally an existence oracle for the
/// form, so it must not become a cheap mass-enumeration endpoint.
async fn identify_handler(
    State(state): State<AppState>,
    Json(req): Json<IdentifyRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let email = auth::normalize_email(&req.email);
    if email.len() < 3 || !email.contains('@') {
        return Err(AppError::BadRequest("invalid email".into()));
    }
    fixed_window_allow(
        &state,
        format!("identify:{email}"),
        IDENTIFY_WINDOW_SECS,
        IDENTIFY_LIMIT,
    )?;
    let record = state.auth.find_by_email(&email).await?;
    Ok(Json(serde_json::json!({
        "exists": record.is_some(),
        "confirmed": record
            .map(|r| r.account.email_confirmed_at.is_some())
            .unwrap_or(false),
    })))
}

/// Body for POST /api/auth/recover (§6.2): request a reset link.
#[derive(serde::Deserialize)]
struct RecoverRequest {
    email: String,
}

/// §6.2 — issue a password-reset link. The response is IDENTICAL whether or
/// not the email exists (no user enumeration). Reset links are only sent to
/// CONFIRMED emails; an unconfirmed account gets a fresh confirmation mail
/// instead (§6.3 — the UI explains this via identify.confirmed).
async fn recover_handler(
    State(state): State<AppState>,
    Json(req): Json<RecoverRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let email = auth::normalize_email(&req.email);
    fixed_window_allow(
        &state,
        format!("recover:{email}"),
        MAIL_SEND_WINDOW_SECS,
        MAIL_SEND_LIMIT,
    )?;
    if let Some(record) = state.auth.find_by_email(&email).await? {
        if record.account.email_confirmed_at.is_some() {
            let (token, code) = issue_auth_token(
                &state,
                &record.account.player_id,
                store::TOKEN_KIND_RESET,
                RESET_TOKEN_TTL_SECS,
            )
            .await?;
            let link = format!("{}/auth/reset?token={token}", state.config.frontend_base);
            // The code goes FIRST so it shows in mail notification previews —
            // typable without leaving the app (§6.2 R2); the link is the
            // desktop-friendly R1 path. Both die in 30 minutes.
            send_mail_best_effort(
                &state,
                &email,
                "Восстановление пароля — GEOHOD QUEST",
                &format!(
                    "Здравствуйте!\n\nКод для смены пароля: {code}\n\nВведите его на странице восстановления или откройте ссылку:\n{link}\n\nКод и ссылка действуют 30 минут. Если вы не запрашивали смену пароля, просто игнорируйте это письмо."
                ),
            )
            .await;
        } else {
            send_confirm_email(&state, &record.account.player_id, &email).await?;
        }
    }
    Ok(Json(serde_json::json!({
        "status": "sent",
        "masked": mailer::mask_email(&email),
    })))
}

/// Body for POST /api/auth/reset (§6.2): finish recovery with the mailed link
/// token (R1) or with the mailed 6-digit code + email (R2 — typed in-app, so
/// mobile users never leave their browsing context).
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum ResetPasswordRequest {
    ByToken {
        token: String,
        password: String,
    },
    ByCode {
        email: String,
        code: String,
        password: String,
    },
}

/// §6.2 — consume the reset credential (link token or email-scoped code), set
/// the new password and SIGN IN (the flow ends with the user in their account,
/// per spec). Failures are ONE opaque 400 — wrong code, unknown email, expired
/// or spent credential are indistinguishable (no enumeration). Code guessing
/// is bounded by the store: `MAX_CODE_ATTEMPTS` per token, and recover itself
/// is mail-rate-limited, so no extra limiter is needed here.
async fn reset_password_handler(
    State(state): State<AppState>,
    Json(req): Json<ResetPasswordRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let password = match &req {
        ResetPasswordRequest::ByToken { password, .. }
        | ResetPasswordRequest::ByCode { password, .. } => password.clone(),
    };
    if password.len() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }
    let now = store::now_secs();
    let player_id = match req {
        ResetPasswordRequest::ByToken { token, .. } => {
            state
                .auth
                .consume_auth_token(
                    &media::sha256_hex(token.as_bytes()),
                    store::TOKEN_KIND_RESET,
                    now,
                )
                .await?
        }
        ResetPasswordRequest::ByCode { email, code, .. } => {
            match state
                .auth
                .find_by_email(&auth::normalize_email(&email))
                .await?
            {
                Some(record) => {
                    state
                        .auth
                        .consume_auth_token_by_code(
                            &record.account.player_id,
                            store::TOKEN_KIND_RESET,
                            &media::sha256_hex(code.trim().as_bytes()),
                            now,
                        )
                        .await?
                }
                None => None,
            }
        }
    }
    .ok_or_else(|| {
        AppError::BadRequest("код или ссылка недействительны или устарели — запросите новые".into())
    })?;
    state
        .auth
        .set_password(&player_id, &auth::hash_password(&password)?)
        .await?;
    // Using a valid reset credential also proves mailbox ownership (§6.3).
    let account = state.auth.confirm_email(&player_id, now).await?;
    let token = auth::generate_token();
    state.auth.create_session(&token, &player_id).await?;
    Ok(Json(AuthResponse {
        player_id: account.player_id,
        email: account.email,
        display_name: account.display_name,
        role: account.role,
        token,
    }))
}

/// Body for POST /api/auth/confirm (§6.3): the mailed confirmation token.
#[derive(serde::Deserialize)]
struct ConfirmEmailRequest {
    token: String,
}

async fn confirm_email_handler(
    State(state): State<AppState>,
    Json(req): Json<ConfirmEmailRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let player_id = state
        .auth
        .consume_auth_token(
            &media::sha256_hex(req.token.as_bytes()),
            store::TOKEN_KIND_CONFIRM,
            store::now_secs(),
        )
        .await?
        .ok_or_else(|| {
            AppError::BadRequest("ссылка недействительна или устарела — запросите новую".into())
        })?;
    let account = state
        .auth
        .confirm_email(&player_id, store::now_secs())
        .await?;
    Ok(Json(
        serde_json::json!({ "status": "confirmed", "email": account.email }),
    ))
}

/// §6.3 — resend the confirmation mail (Profile banner «Ещё раз»). Session-only.
async fn resend_confirm_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let account = session_account(&state, &headers)
        .await?
        .ok_or_else(|| AppError::Unauthorized("login required".into()))?;
    // A social-only account (Telegram / Google-without-email) has no address to
    // confirm — treat as already-confirmed (nothing to send).
    let Some(email) = account.email.clone() else {
        return Ok(Json(serde_json::json!({ "status": "already-confirmed" })));
    };
    if account.email_confirmed_at.is_some() {
        return Ok(Json(serde_json::json!({ "status": "already-confirmed" })));
    }
    fixed_window_allow(
        &state,
        format!("confirm:{email}"),
        MAIL_SEND_WINDOW_SECS,
        MAIL_SEND_LIMIT,
    )?;
    send_confirm_email(&state, &account.player_id, &email).await?;
    Ok(Json(serde_json::json!({ "status": "sent" })))
}

/// Body for POST /api/auth/display-name (§7.3 «Изменить имя»).
#[derive(serde::Deserialize)]
struct SetDisplayNameRequest {
    display_name: Option<String>,
}

async fn set_display_name_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SetDisplayNameRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let account = session_account(&state, &headers)
        .await?
        .ok_or_else(|| AppError::Unauthorized("login required".into()))?;
    let name = req
        .display_name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    if name.as_deref().is_some_and(|n| n.chars().count() > 60) {
        return Err(AppError::BadRequest("name is too long (max 60)".into()));
    }
    let updated = state
        .auth
        .set_display_name(&account.player_id, name)
        .await?;
    Ok(Json(serde_json::json!({
        "status": "ok",
        "display_name": updated.display_name,
    })))
}

/// Body for POST /api/auth/change-password (§7.3).
#[derive(serde::Deserialize)]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

async fn change_password_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let account = session_account(&state, &headers)
        .await?
        .ok_or_else(|| AppError::Unauthorized("login required".into()))?;
    // Only email/password accounts have a password to change; a social-only
    // account (no email) must add an email/password first (not modelled here).
    let email = account.email.clone().ok_or_else(|| {
        AppError::BadRequest("этот аккаунт входит через провайдера — пароль не задан".into())
    })?;
    let record = state
        .auth
        .find_by_email(&email)
        .await?
        .ok_or_else(|| AppError::Unauthorized("login required".into()))?;
    if !auth::verify_password(&record.password_hash, &req.current_password) {
        return Err(AppError::Unauthorized("неверный текущий пароль".into()));
    }
    if req.new_password.len() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }
    state
        .auth
        .set_password(&account.player_id, &auth::hash_password(&req.new_password)?)
        .await?;
    Ok(Json(serde_json::json!({ "status": "changed" })))
}

/// §7.4 — delete the account and its data, irreversibly. Editors with quests
/// still ON SALE are blocked (409): buyers keep access through the published
/// snapshot + grants, but an account that owns live store listings must delist
/// them first — otherwise the store would sell orphaned quests.
async fn delete_account_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let account = session_account(&state, &headers)
        .await?
        .ok_or_else(|| AppError::Unauthorized("login required".into()))?;
    let published = state
        .constructor
        .list_summaries_for_author(&account.player_id)
        .await?
        .into_iter()
        .filter(|q| q.status == store::CTOR_STATUS_PUBLISHED)
        .count();
    if published > 0 {
        return Err(AppError::Conflict(format!(
            "published quests block deletion: {published}"
        )));
    }
    // Play data first, identity last — a crash in between leaves a still-working
    // account with less data, never a deleted account with orphaned identity.
    state.store.delete_player_data(&account.player_id).await?;
    state
        .grants
        .delete_grants_for_player(&account.player_id)
        .await?;
    state.auth.delete_user(&account.player_id).await?;
    Ok(Json(serde_json::json!({ "status": "deleted" })))
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
        Some(a) => {
            // Sign-in methods for the profile: "email" (when set) + each linked
            // social provider, so the client shows/links/unlinks them honestly.
            let identities = state.auth.identities_for_player(&a.player_id).await?;
            let mut methods: Vec<&str> = Vec::new();
            if a.email.is_some() {
                methods.push(auth::METHOD_EMAIL);
            }
            for i in &identities {
                if i.provider == auth::PROVIDER_GOOGLE {
                    methods.push(auth::PROVIDER_GOOGLE);
                } else if i.provider == auth::PROVIDER_TELEGRAM {
                    methods.push(auth::PROVIDER_TELEGRAM);
                }
            }
            serde_json::json!({
                "player_id": a.player_id, "registered": true,
                "email": a.email, "display_name": a.display_name, "role": a.role,
                "email_confirmed_at": a.email_confirmed_at,
                "methods": methods,
            })
        }
        None => serde_json::json!({
            "player_id": player_id, "registered": false,
            "email": null, "display_name": null, "role": null,
            "methods": [],
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
    /// `null` for a social-only account (no login email).
    email: Option<String>,
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
/// Query for GET /api/admin/users: `?page=1` (1-based) opts into pagination
/// (§10.2 — 25 per page, newest first); without it the legacy full array is
/// returned so older clients keep working.
#[derive(serde::Deserialize)]
struct ListUsersQuery {
    page: Option<u32>,
}

const ADMIN_USERS_PER_PAGE: usize = 25;

async fn list_users_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<ListUsersQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let users = state.auth.list_users().await?;
    match q.page {
        None => Ok(Json(serde_json::json!(
            users
                .into_iter()
                .map(AdminUserWire::from)
                .collect::<Vec<_>>()
        ))),
        Some(page) => {
            let page = page.max(1) as usize;
            let total = users.len();
            let start = (page - 1) * ADMIN_USERS_PER_PAGE;
            let slice: Vec<AdminUserWire> = users
                .into_iter()
                .skip(start)
                .take(ADMIN_USERS_PER_PAGE)
                .map(AdminUserWire::from)
                .collect();
            Ok(Json(serde_json::json!({
                "users": slice,
                "total": total,
                "page": page,
                "per_page": ADMIN_USERS_PER_PAGE,
            })))
        }
    }
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

/// One feature-toggle row for the admin panel: the registry facts (key,
/// default) plus the runtime state (override, effective toggle) and whether
/// the deployment is configured for it at all.
#[derive(serde::Serialize)]
struct FeatureWire {
    key: &'static str,
    default_enabled: bool,
    /// The stored admin override; `null` = the code default applies.
    #[serde(rename = "override")]
    override_enabled: Option<bool>,
    /// The toggle verdict (`override ?? default`) — what the gated endpoints
    /// enforce. Independent of `available`.
    effective: bool,
    /// Capability: credentials configured. `effective && !available` means the
    /// switch is on but the feature is inert on this deployment.
    available: bool,
}

/// Assemble one wire row from an already-fetched override (callers own the
/// store read: the list handler fetches all overrides once, the mutation
/// already holds the value it just wrote).
fn feature_wire(state: &AppState, feature: Feature, override_enabled: Option<bool>) -> FeatureWire {
    FeatureWire {
        key: feature.key(),
        default_enabled: feature.default_enabled(),
        override_enabled,
        effective: feature.effective(override_enabled),
        available: feature_available(state, feature),
    }
}

/// GET /api/admin/features — every registered feature with its runtime state.
async fn list_features_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<FeatureWire>>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let overrides = state.flags.all_overrides().await?;
    let rows = Feature::ALL
        .into_iter()
        .map(|f| feature_wire(&state, f, overrides.get(f.key()).copied()))
        .collect();
    Ok(Json(rows))
}

/// Body for the feature-toggle mutation: `enabled: true|false` stores an
/// override, `enabled: null` clears it (back to the code default).
#[derive(serde::Deserialize)]
struct SetFeatureRequest {
    enabled: Option<bool>,
}

/// POST /api/admin/features/{key} — set or clear a feature override. Unknown
/// keys are 404 (the registry lives in code; nothing to create).
async fn set_feature_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetFeatureRequest>,
) -> Result<Json<FeatureWire>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let feature = Feature::parse(&key)
        .ok_or_else(|| AppError::NotFound(format!("unknown feature: {key}")))?;
    match req.enabled {
        Some(enabled) => state.flags.set_override(feature.key(), enabled).await?,
        None => state.flags.clear_override(feature.key()).await?,
    }
    Ok(Json(feature_wire(&state, feature, req.enabled)))
}

/// Body for coupon create/save: the editable fields exactly as the admin form
/// collects them. `quest_ids: null` = «Все квесты»; a list = «Выбранные».
#[derive(serde::Deserialize)]
struct CouponPayload {
    code: String,
    #[serde(flatten)]
    discount: Discount,
    valid_until: Option<String>,
    max_redemptions: Option<u32>,
    per_user_limit: Option<u32>,
    quest_ids: Option<Vec<String>>,
    #[serde(default)]
    paused: bool,
}

impl CouponPayload {
    /// Validate every field and build the stored record. `coupon_id` and
    /// `created_at` come from the caller: fresh for create, preserved for save.
    fn into_coupon(self, coupon_id: String, created_at: String) -> Result<Coupon, AppError> {
        let code = coupons::normalize_code(&self.code)?;
        coupons::validate_discount(&self.discount)?;
        if let Some(date) = &self.valid_until {
            coupons::validate_date(date)?;
        }
        if self.max_redemptions == Some(0) || self.per_user_limit == Some(0) {
            return Err(AppError::BadRequest(
                "лимит использований должен быть больше нуля".into(),
            ));
        }
        if self.quest_ids.as_ref().is_some_and(|q| q.is_empty()) {
            return Err(AppError::BadRequest(
                "выберите хотя бы один квест или переключитесь на «Все квесты»".into(),
            ));
        }
        Ok(Coupon {
            coupon_id,
            code,
            discount: self.discount,
            valid_until: self.valid_until,
            max_redemptions: self.max_redemptions,
            per_user_limit: self.per_user_limit,
            quest_ids: self.quest_ids,
            paused: self.paused,
            created_at,
        })
    }
}

/// One coupon as served to the admin UI: the stored record plus the DERIVED
/// status and the usage fold (never persisted — always честный пересчёт).
#[derive(serde::Serialize)]
struct AdminCouponWire {
    #[serde(flatten)]
    coupon: Coupon,
    status: coupons::CouponStatus,
    #[serde(flatten)]
    usage: CouponUsage,
}

impl AdminCouponWire {
    fn build(coupon: Coupon, usage: CouponUsage, today: &str) -> Self {
        let status = coupons::coupon_status(&coupon, usage.used, today);
        Self {
            coupon,
            status,
            usage,
        }
    }
}

/// Admin coupon list, newest first, each with derived status + usage.
async fn list_coupons_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminCouponWire>>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let today = store::today_utc();
    let rows = state.coupons.list_with_usage().await?;
    Ok(Json(
        rows.into_iter()
            .map(|(c, u)| AdminCouponWire::build(c, u, &today))
            .collect(),
    ))
}

/// Create a coupon. 400 on any invalid field, 409 on a duplicate code.
async fn create_coupon_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CouponPayload>,
) -> Result<Json<AdminCouponWire>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let coupon_id = format!("cpn-{}", &auth::generate_token()[..12]);
    let coupon = payload.into_coupon(coupon_id, store::now_rfc3339())?;
    let created = state.coupons.create(coupon).await?;
    Ok(Json(AdminCouponWire::build(
        created,
        CouponUsage::default(),
        &store::today_utc(),
    )))
}

/// One coupon with usage (admin editor).
async fn get_coupon_handler(
    State(state): State<AppState>,
    Path(coupon_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<AdminCouponWire>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let (coupon, usage) = state
        .coupons
        .get_with_usage(&coupon_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("unknown coupon '{coupon_id}'")))?;
    Ok(Json(AdminCouponWire::build(
        coupon,
        usage,
        &store::today_utc(),
    )))
}

/// Save every editable field of a coupon (identity and created_at preserved;
/// the redemption log is untouched, so usage stats survive edits and pauses).
async fn save_coupon_handler(
    State(state): State<AppState>,
    Path(coupon_id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<CouponPayload>,
) -> Result<Json<AdminCouponWire>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let existing = state
        .coupons
        .get(&coupon_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("unknown coupon '{coupon_id}'")))?;
    let coupon = payload.into_coupon(existing.coupon_id, existing.created_at)?;
    let updated = state.coupons.update(coupon).await?;
    let (_, usage) = state
        .coupons
        .get_with_usage(&coupon_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("unknown coupon '{coupon_id}'")))?;
    Ok(Json(AdminCouponWire::build(
        updated,
        usage,
        &store::today_utc(),
    )))
}

/// Delete a coupon and its redemption log. Already-granted quests stay owned
/// («удаление необратимо; уже применённые скидки сохраняются»).
async fn delete_coupon_handler(
    State(state): State<AppState>,
    Path(coupon_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    require_admin_actor(&state, &headers).await?;
    state.coupons.delete(&coupon_id).await?;
    Ok(StatusCode::NO_CONTENT)
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
            tracing::info!(
                max_connections,
                "storage: PostgreSQL (migrations up to date)"
            );
            let google = build_google_verifier(&config);
            let telegram = build_telegram_verifier(&config);
            AppState {
                config: config.clone(),
                store: FactStores::Postgres(pg_store::PgFactStore::new(pool.clone())),
                grants: GrantStores::Postgres(pg_store::PgGrantStore::new(pool.clone())),
                auth: AuthStores::Postgres(pg_store::PgAuthStore::new(pool.clone())),
                constructor: ConstructorStores::Postgres(pg_store::PgConstructorStore::new(
                    pool.clone(),
                )),
                coupons: CouponStores::Postgres(pg_store::PgCouponStore::new(pool.clone())),
                media,
                payment_rows: PaymentStores::Postgres(pg_store::PgPaymentStore::new(pool.clone())),
                flags: FlagStores::Postgres(pg_store::PgFlagStore::new(pool)),
                yookassa: config.yookassa.clone().map(YookassaGateway::Http),
                mailer: mailer::Mailer::from_config(config.smtp_url.as_deref(), &config.mail_from),
                rate_limiter: Arc::new(Mutex::new(std::collections::HashMap::new())),
                google,
                telegram,
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
            smtp_url: None,
            mail_from: "test@geohod.test".to_string(),
            frontend_base: "http://localhost:3000".to_string(),
            google_client_id: None,
            telegram_client_id: None,
            yookassa: None,
        }))
    }

    /// Router + captured outbox — flows that need the mailed token (§6).
    fn test_app_with_mail() -> (Router, std::sync::Arc<Mutex<Vec<mailer::OutgoingMail>>>) {
        let mut state = test_state(AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            version: "test-0.0.0",
            admin_token: Some(TEST_ADMIN_TOKEN.to_string()),
            cors_allowed_origins: Vec::new(),
            media: test_media_cfg(),
            smtp_url: None,
            mail_from: "test@geohod.test".to_string(),
            frontend_base: "http://localhost:3000".to_string(),
            google_client_id: None,
            telegram_client_id: None,
            yookassa: None,
        });
        let (m, outbox) = mailer::Mailer::recorder();
        state.mailer = m;
        (build_router(state), outbox)
    }

    /// Router with NO admin secret configured — admin surfaces must fail closed.
    fn test_app_no_admin() -> Router {
        build_router(test_state(AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            version: "test-0.0.0",
            admin_token: None,
            cors_allowed_origins: Vec::new(),
            media: test_media_cfg(),
            smtp_url: None,
            mail_from: "test@geohod.test".to_string(),
            frontend_base: "http://localhost:3000".to_string(),
            google_client_id: None,
            telegram_client_id: None,
            yookassa: None,
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
            smtp_url: None,
            mail_from: "test@geohod.test".to_string(),
            frontend_base: "http://localhost:3000".to_string(),
            google_client_id: None,
            telegram_client_id: None,
            yookassa: None,
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
        let (st, _) = get_json_h(&app, "/api/admin/users", &[("x-admin-token", "anything")]).await;
        assert_eq!(st, StatusCode::FORBIDDEN);
    }

    // ===== Social sign-in (Telegram end-to-end; Google verifier unit-tested in
    // ===== social.rs, its route shares complete_social_login with Telegram) =====

    /// Router with Telegram configured via a seeded OIDC verifier (Google stays off
    /// — its verifier needs live JWKS, covered by unit tests). The verifier's JWKS
    /// cache is pre-seeded with a local key so `telegram_id_token`s verify offline
    /// over the REAL signature/aud/iss/exp path. Mirrors `test_app` otherwise.
    fn test_app_social() -> Router {
        let mut state = test_state(AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            version: "test-0.0.0",
            admin_token: Some(TEST_ADMIN_TOKEN.to_string()),
            cors_allowed_origins: Vec::new(),
            media: test_media_cfg(),
            smtp_url: None,
            mail_from: "test@geohod.test".to_string(),
            frontend_base: "http://localhost:3000".to_string(),
            google_client_id: None,
            telegram_client_id: Some(social::test_support::TELEGRAM_CLIENT_ID.to_string()),
            yookassa: None,
        });
        state.telegram = Some(Arc::new(social::test_support::seeded_telegram_verifier()));
        build_router(state)
    }

    /// A `/api/auth/telegram` request body: a locally-signed OIDC id_token (name is
    /// the profile display name) plus the caller's claimed player_id.
    fn tg_payload(player_id: &str, id: i64, name: &str) -> Value {
        json!({
            "player_id": player_id,
            "id_token": social::test_support::telegram_id_token(id, name, None, 3600),
        })
    }

    #[tokio::test]
    async fn telegram_disabled_when_unconfigured() {
        // test_app() has no telegram verifier → fail-closed 501, no account effect.
        let app = test_app();
        let (st, _) = post_json(&app, "/api/auth/telegram", tg_payload("dev:x", 1, "A")).await;
        assert_eq!(st, StatusCode::NOT_IMPLEMENTED);
    }

    #[tokio::test]
    async fn google_disabled_when_unconfigured() {
        let app = test_app_social(); // google intentionally off
        let (st, _) = post_json(
            &app,
            "/api/auth/google",
            json!({ "credential": "x.y.z", "player_id": "dev:x" }),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_IMPLEMENTED);
    }

    #[tokio::test]
    async fn telegram_invalid_token_is_rejected() {
        // A structurally-broken / unsigned token never verifies against the JWKS.
        let app = test_app_social();
        let payload = json!({ "player_id": "dev:a", "id_token": "not.a.valid.jwt" });
        let (st, _) = post_json(&app, "/api/auth/telegram", payload).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn telegram_expired_token_is_rejected() {
        // A correctly-signed token whose exp has passed is rejected (replay window).
        let app = test_app_social();
        let payload = json!({
            "player_id": "dev:a",
            "id_token": social::test_support::telegram_id_token(7, "Old", None, -3600),
        });
        let (st, _) = post_json(&app, "/api/auth/telegram", payload).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn telegram_creates_account_on_anonymous_id_preserving_it() {
        let app = test_app_social();
        let (st, body) = post_json(
            &app,
            "/api/auth/telegram",
            tg_payload("dev:keep-me", 500, "Ann"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        // The account is keyed to the SAME anonymous id (coins/grants survive).
        assert_eq!(body["player_id"], "dev:keep-me");
        assert!(body["email"].is_null(), "telegram account has no email");
        assert_eq!(body["display_name"], "Ann");
        let token = body["token"].as_str().expect("token");

        // /me reports the telegram method and no email.
        let (st, me) = get_json_h(
            &app,
            "/api/players/me",
            &[("authorization", &format!("Bearer {token}"))],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["registered"], true);
        assert!(me["email"].is_null());
        let methods: Vec<String> = serde_json::from_value(me["methods"].clone()).expect("methods");
        assert_eq!(methods, vec!["telegram".to_string()]);
    }

    #[tokio::test]
    async fn telegram_same_user_from_second_device_returns_first_account() {
        let app = test_app_social();
        let (_, first) = post_json(
            &app,
            "/api/auth/telegram",
            tg_payload("dev:one", 900, "Ann"),
        )
        .await;
        assert_eq!(first["player_id"], "dev:one");
        // A different anonymous device signs in with the SAME telegram id.
        let (st, second) = post_json(
            &app,
            "/api/auth/telegram",
            tg_payload("dev:two", 900, "Ann"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        // It resolves to the existing account, not a new one on dev:two.
        assert_eq!(second["player_id"], "dev:one");
    }

    #[tokio::test]
    async fn telegram_links_to_logged_in_email_account_and_unlink_guards_last_method() {
        let app = test_app_social();
        // Register an email account.
        let (st, reg) = post_json(
            &app,
            "/api/auth/register",
            json!({ "player_id": "dev:acct", "email": "u@example.com", "password": "supersecret" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let token = reg["token"].as_str().expect("token").to_string();
        let bearer = format!("Bearer {token}");

        // Link Telegram to the logged-in account (Bearer present).
        let (st, linked) = post_json_h(
            &app,
            "/api/auth/telegram",
            tg_payload("dev:acct", 4242, "Ann"),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(linked["player_id"], "dev:acct"); // same account
        assert_eq!(linked["email"], "u@example.com");

        // /me lists BOTH methods now.
        let (_, me) = get_json_h(&app, "/api/players/me", &[("authorization", &bearer)]).await;
        let mut methods: Vec<String> =
            serde_json::from_value(me["methods"].clone()).expect("methods");
        methods.sort();
        assert_eq!(methods, vec!["email".to_string(), "telegram".to_string()]);

        // Telegram login from another device now reaches the email account.
        let (_, elsewhere) = post_json(
            &app,
            "/api/auth/telegram",
            tg_payload("dev:other", 4242, "Ann"),
        )
        .await;
        assert_eq!(elsewhere["player_id"], "dev:acct");

        // Unlink telegram is allowed (email remains).
        let (st, _) = post_json_h(
            &app,
            "/api/auth/unlink",
            json!({ "provider": "telegram" }),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Unlinking the LAST method (email) is refused (409) — but email isn't a
        // provider; unlinking telegram again now fails as not-linked (404).
        let (st, _) = post_json_h(
            &app,
            "/api/auth/unlink",
            json!({ "provider": "telegram" }),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn telegram_only_account_cannot_unlink_its_sole_method() {
        let app = test_app_social();
        let (_, acct) = post_json(
            &app,
            "/api/auth/telegram",
            tg_payload("dev:solo", 77, "Solo"),
        )
        .await;
        let token = acct["token"].as_str().expect("token");
        let (st, _) = post_json_h(
            &app,
            "/api/auth/unlink",
            json!({ "provider": "telegram" }),
            &[("authorization", &format!("Bearer {token}"))],
        )
        .await;
        assert_eq!(
            st,
            StatusCode::CONFLICT,
            "sole sign-in method must not be removable"
        );
    }

    #[tokio::test]
    async fn providers_endpoint_reports_configuration() {
        let app = test_app_social();
        let (st, body) = get_json_h(&app, "/api/auth/providers", &[]).await;
        assert_eq!(st, StatusCode::OK);
        assert!(body["google_client_id"].is_null());
        assert_eq!(
            body["telegram_client_id"],
            social::test_support::TELEGRAM_CLIENT_ID
        );
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
        post_json_h(
            app,
            "/api/quests/publish",
            body,
            &[("authorization", &bearer)],
        )
        .await
    }

    /// Grants + publishes ids.quest (v1, ids.snap1) and creates an attempt.
    /// Returns the attempt_id.
    async fn grant_publish_attempt(app: &Router, ids: &Ids) -> String {
        let (st, _) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest, "coupon_code": null}),
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

    /// The public players counter = real distinct completions + the author's
    /// marketing `players_bonus`, on BOTH the catalog card and the product page.
    /// The raw bonus is never serialized on its own (it would reveal the padding),
    /// and a negative bonus clamps to 0 so the count never drops below the honest
    /// completions figure.
    #[tokio::test]
    async fn players_counter_is_completions_plus_bonus_and_hides_raw_bonus() {
        let app = test_app();
        let ids = Ids::new("players-counter");

        // One real completion: grant → publish → attempt → CompletionBonus fact.
        let attempt = grant_publish_attempt(&app, &ids).await;
        let bonus = json!({"facts": [fact_json(FactKind::CompletionBonus, 3, 5, "device-a")]});
        let (st, fv) = post_json(&app, &format!("/api/attempts/{attempt}/facts"), bonus).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(fv["accepted"].as_array().expect("accepted").len(), 1);

        // Re-publish the SAME quest with a marketing bonus of 1000.
        let (st, _) = publish(
            &app,
            &ids,
            json!({
                "quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                "snapshot_version": 1, "snapshot_id": ids.snap1, "players_bonus": 1000,
            }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Catalog: players = 1 real completion + 1000 bonus; raw bonus never ships.
        let (_, list) = get_json(&app, "/api/quests").await;
        let card = list
            .as_array()
            .expect("array")
            .iter()
            .find(|q| q["quest_id"] == ids.quest)
            .expect("quest in store");
        assert_eq!(card["players"], 1001);
        assert!(
            card.get("players_bonus").is_none(),
            "raw marketing bonus must not be serialized"
        );

        // Product page agrees with the card (same basis).
        let (_, prod) = get_json(&app, &format!("/api/quests/{}", ids.quest)).await;
        assert_eq!(prod["players"], 1001);
        assert!(prod.get("players_bonus").is_none());

        // Negative bonus clamps to 0 → players falls back to honest completions.
        let (st, _) = publish(
            &app,
            &ids,
            json!({
                "quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                "snapshot_version": 1, "snapshot_id": ids.snap1, "players_bonus": -50,
            }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, list) = get_json(&app, "/api/quests").await;
        let card = list
            .as_array()
            .expect("array")
            .iter()
            .find(|q| q["quest_id"] == ids.quest)
            .expect("quest in store");
        assert_eq!(card["players"], 1);
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
            json!({"player_id": ids.player, "quest_id": ids.quest, "coupon_code": null}),
        )
        .await;
        assert_eq!(v1["created"], true);
        assert_eq!(v1["grant"]["source"], "Payment");

        // Re-checkout of an owned quest is idempotent and never consumes a
        // coupon — the code is not even looked up.
        let (_, v2) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest, "coupon_code": "GHOST-1"}),
        )
        .await;
        assert_eq!(v2["created"], false, "idempotent");
        assert_eq!(v2["grant"]["source"], "Payment", "first source preserved");

        // A full-discount coupon on a paid published quest bypasses the provider.
        let other_quest = format!("{}-coupon", ids.quest);
        let (st, _) = publish(
            app,
            ids,
            json!({"quest_id": other_quest, "name": "QC", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": format!("{}-c", ids.snap1),
                   "price": 300}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        // Code derived from the run-unique quest id so the shared-Postgres
        // suite never collides with an earlier run's coupon.
        let code = format!("{}-FULL", ids.quest.to_ascii_uppercase());
        let (st, _) = post_json_h(
            app,
            "/api/admin/coupons",
            json!({"code": code, "discount_type": "percent", "discount_value": 100}),
            &[("x-admin-token", TEST_ADMIN_TOKEN)],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, v3) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": other_quest,
                   "coupon_code": code.to_ascii_lowercase()}),
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
        assert!(
            store_has(app, &ids.quest).await,
            "a published quest is listed"
        );

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
                   "primary_comic": "https://api.test/api/media/coverhash",
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
        // The envelope carries the list cover so the client can precache it for offline
        // (it lives in the catalog meta, not the frozen play snapshot).
        assert_eq!(
            body["primary_comic"],
            "https://api.test/api/media/coverhash"
        );
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

        // One mailbox is one account regardless of casing: a mixed-case
        // duplicate is still a 409 (the API must enforce this itself — the UI
        // lowercasing is not a security boundary).
        let (st, _) = post_json(
            app,
            "/api/auth/register",
            json!({"player_id": format!("{}-case", ids.player),
                   "email": email.to_uppercase(), "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT, "mixed-case duplicate email");

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
        let (st, v) = post_json(
            app,
            "/api/auth/login",
            json!({"email": email.to_uppercase(), "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "login is email-case-insensitive");
        assert_eq!(v["player_id"], ids.player.as_str());
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
        let (st, _) = get_json_h(app, "/api/admin/users", &[("authorization", &bob_bearer)]).await;
        assert_eq!(
            st,
            StatusCode::FORBIDDEN,
            "a player session cannot list users"
        );

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
        let (st, ub) = post_json_h(
            app,
            &role_uri(&bob),
            json!({"role": "editor"}),
            &admin_session,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(ub["role"], "editor");
        let (_, me_b) = get_json_h(app, "/api/players/me", &[("authorization", &bob_bearer)]).await;
        assert_eq!(me_b["role"], "editor", "bob sees his new role");

        // Anti-lockout: a session-admin cannot change their OWN role...
        let (st, _) = post_json_h(
            app,
            &role_uri(&alice),
            json!({"role": "player"}),
            &admin_session,
        )
        .await;
        assert_eq!(
            st,
            StatusCode::CONFLICT,
            "an admin cannot self-demote via a session"
        );
        // ...but the shared-secret ops path can (the recovery path has no "self").
        let (st, _) = post_json_h(
            app,
            &role_uri(&alice),
            json!({"role": "player"}),
            &admin_hdr,
        )
        .await;
        assert_eq!(st, StatusCode::OK, "ops path may change any role");

        // Validation + existence guards.
        let (st, _) = post_json_h(
            app,
            &role_uri(&bob),
            json!({"role": "superuser"}),
            &admin_hdr,
        )
        .await;
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

        // A coupon that zeroes the price bypasses the provider: no ref.
        let coupon_quest = format!("{}-coupon", ids.quest);
        let (st, _) = publish(
            app,
            ids,
            json!({"quest_id": coupon_quest, "name": "QC", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": format!("{}-audit-c", ids.snap1),
                   "price": 200}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let code = format!("{}-A300", ids.quest.to_ascii_uppercase());
        let (st, _) = post_json_h(
            app,
            "/api/admin/coupons",
            json!({"code": code, "discount_type": "fixed", "discount_value": 300}),
            &[("x-admin-token", TEST_ADMIN_TOKEN)],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, v2) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": coupon_quest, "coupon_code": code}),
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

    /// Admin coupon CRUD: create → list → get → save → delete, with the
    /// derived status and validation/conflict/gating guards along the way.
    /// Codes derive from the run-unique quest id (shared-Postgres safe).
    async fn scenario_admin_coupons(app: &Router, ids: &Ids) {
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let code = ids.quest.to_ascii_uppercase();

        // Gating: no credential → opaque 403 on every verb.
        let (st, _) = get_json(app, "/api/admin/coupons").await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        let (st, _) = post_json(
            app,
            "/api/admin/coupons",
            json!({"code": "X-10", "discount_type": "percent", "discount_value": 10}),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);

        // Validation: bad code, bad percent, bad date, zero limit, empty quest list.
        for bad in [
            json!({"code": "ab", "discount_type": "percent", "discount_value": 10}),
            json!({"code": code, "discount_type": "percent", "discount_value": 0}),
            json!({"code": code, "discount_type": "percent", "discount_value": 101}),
            json!({"code": code, "discount_type": "fixed", "discount_value": 0}),
            json!({"code": code, "discount_type": "percent", "discount_value": 10, "valid_until": "31.08.2026"}),
            json!({"code": code, "discount_type": "percent", "discount_value": 10, "max_redemptions": 0}),
            json!({"code": code, "discount_type": "percent", "discount_value": 10, "quest_ids": []}),
        ] {
            let (st, _) = post_json_h(app, "/api/admin/coupons", bad, &admin).await;
            assert_eq!(st, StatusCode::BAD_REQUEST);
        }

        // Create normalizes the code and derives an Active status.
        let (st, created) = post_json_h(
            app,
            "/api/admin/coupons",
            json!({"code": format!("  {} ", code.to_ascii_lowercase()),
                   "discount_type": "percent", "discount_value": 20,
                   "valid_until": "2099-08-31", "max_redemptions": 100, "per_user_limit": 1}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(created["code"], code.as_str());
        assert_eq!(created["status"], "active");
        assert_eq!(created["used"], 0);
        let id = created["coupon_id"].as_str().expect("id").to_string();

        // Duplicate code → 409.
        let (st, _) = post_json_h(
            app,
            "/api/admin/coupons",
            json!({"code": code.to_ascii_lowercase(), "discount_type": "fixed", "discount_value": 300}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);

        // List contains it; get agrees.
        let (st, list) = get_json_h(app, "/api/admin/coupons", &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert!(
            list.as_array()
                .expect("array")
                .iter()
                .any(|c| c["coupon_id"] == id.as_str()),
            "created coupon listed"
        );
        let (st, one) = get_json_h(app, &format!("/api/admin/coupons/{id}"), &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(one["code"], code.as_str());

        // Save: pause + switch to a fixed discount; identity/created_at survive.
        let (st, saved) = post_json_h(
            app,
            &format!("/api/admin/coupons/{id}/save"),
            json!({"code": code, "discount_type": "fixed", "discount_value": 300,
                   "paused": true}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(saved["coupon_id"], id.as_str());
        assert_eq!(saved["status"], "paused");
        assert_eq!(saved["created_at"], created["created_at"]);

        // A past valid_until derives "expired" (paused loses to expired).
        let (st, expired) = post_json_h(
            app,
            &format!("/api/admin/coupons/{id}/save"),
            json!({"code": code, "discount_type": "fixed", "discount_value": 300,
                   "valid_until": "2020-01-01", "paused": true}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(expired["status"], "expired");

        // Delete, then 404 on every follow-up.
        let (st, _) = post_json_h(
            app,
            &format!("/api/admin/coupons/{id}/delete"),
            json!({}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::NO_CONTENT);
        let (st, _) = get_json_h(app, &format!("/api/admin/coupons/{id}"), &admin).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _) = post_json_h(
            app,
            &format!("/api/admin/coupons/{id}/delete"),
            json!({}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn admin_coupons_crud_validation_and_gating() {
        scenario_admin_coupons(&test_app(), &Ids::new("cpn-crud")).await;
    }

    /// The purchase-sheet preview: always 200, verdict in the body; the priced
    /// discount matches what checkout will actually apply.
    async fn scenario_coupon_validate(app: &Router, ids: &Ids) {
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let code = ids.quest.to_ascii_uppercase();
        let player = format!("dev:{}-preview", ids.player);
        let (st, _) = publish(
            app,
            ids,
            json!({"quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": ids.snap1, "price": 900}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json_h(
            app,
            "/api/admin/coupons",
            json!({"code": code, "discount_type": "percent", "discount_value": 20,
                   "per_user_limit": 1}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Valid: 20% off 900 → 720.
        let (st, v) = post_json(
            app,
            "/api/coupons/validate",
            json!({"player_id": player, "quest_id": ids.quest, "code": code.to_ascii_lowercase()}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["valid"], true);
        assert_eq!(v["price"], 900);
        assert_eq!(v["discount_amount"], 180);
        assert_eq!(v["final_price"], 720);

        // Unknown code and malformed code read the same.
        for unknown in ["NOPE-1", "нет"] {
            let (st, v) = post_json(
                app,
                "/api/coupons/validate",
                json!({"player_id": player, "quest_id": ids.quest, "code": unknown}),
            )
            .await;
            assert_eq!(st, StatusCode::OK);
            assert_eq!(v["valid"], false);
            assert_eq!(v["message"], "промокод не найден");
        }

        // Unpublished (or free) quest: the coupon does not apply.
        let (_, v) = post_json(
            app,
            "/api/coupons/validate",
            json!({"player_id": player, "quest_id": "ghost-quest", "code": code}),
        )
        .await;
        assert_eq!(v["valid"], false);

        // Preview does not consume: checkout with the code still succeeds,
        // and only then does the per-user limit bite the NEXT quest.
        let (st, out) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": player, "quest_id": ids.quest, "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            out["grant"]["source"], "Payment",
            "partial discount still charges"
        );

        let other = format!("{}-b", ids.quest);
        let (st, _) = publish(
            app,
            ids,
            json!({"quest_id": other, "name": "Q2", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": format!("{}-b", ids.snap1),
                   "price": 500}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, v) = post_json(
            app,
            "/api/coupons/validate",
            json!({"player_id": player, "quest_id": other, "code": code}),
        )
        .await;
        assert_eq!(v["valid"], false);
        assert_eq!(v["message"], "Вы уже использовали этот промокод");
    }

    #[tokio::test]
    async fn coupon_validate_previews_without_consuming() {
        scenario_coupon_validate(&test_app(), &Ids::new("cpn-preview")).await;
    }

    /// Checkout + coupons end to end: caps enforced atomically, usage recorded
    /// for the admin stats, quest restriction honored, retries idempotent.
    async fn scenario_coupon_redeem(app: &Router, ids: &Ids) {
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let code = ids.quest.to_ascii_uppercase();
        let p = |n: &str| format!("dev:{}-{n}", ids.player);
        let quest_a = ids.quest.clone();
        let quest_b = format!("{}-b", ids.quest);
        for (quest, snap, price) in [
            (&quest_a, ids.snap1.clone(), 900),
            (&quest_b, format!("{}-b", ids.snap1), 200),
        ] {
            let (st, _) = publish(
                app,
                ids,
                json!({"quest_id": quest, "name": "Q", "template_summary": "demo",
                       "snapshot_version": 1, "snapshot_id": snap, "price": price}),
            )
            .await;
            assert_eq!(st, StatusCode::OK);
        }
        // Fixed 300 ₽, total cap 2, restricted to quest_a and quest_b.
        let (st, created) = post_json_h(
            app,
            "/api/admin/coupons",
            json!({"code": code, "discount_type": "fixed", "discount_value": 300,
                   "max_redemptions": 2, "quest_ids": [quest_a, quest_b]}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let coupon_id = created["coupon_id"].as_str().expect("id").to_string();

        // Not applicable to a foreign quest.
        let quest_c = format!("{}-c", ids.quest);
        let (st, _) = publish(
            app,
            ids,
            json!({"quest_id": quest_c, "name": "Q", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": format!("{}-c", ids.snap1),
                   "price": 100}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, body) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": p("r1"), "quest_id": quest_c, "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);
        assert_eq!(body["error"], "Промокод не действует на этот квест");

        // Partial discount on quest_a charges the provider (Payment)...
        let (st, out) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": p("r1"), "quest_id": quest_a, "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(out["grant"]["source"], "Payment");
        // ...while a clamped full discount on quest_b bypasses it entirely.
        let (st, out) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": p("r2"), "quest_id": quest_b, "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(out["grant"]["source"], "CouponRedemption");

        // Cap of 2 reached → third player gets the exhausted message.
        let (st, body) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": p("r3"), "quest_id": quest_a, "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);
        assert_eq!(
            body["error"],
            "Промокод больше не действует — лимит исчерпан"
        );

        // Usage folded for the admin: 2 uses, 300 + clamped 200 saved.
        let (st, one) = get_json_h(app, &format!("/api/admin/coupons/{coupon_id}"), &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(one["used"], 2);
        assert_eq!(one["total_discounted"], 500);
        assert_eq!(one["status"], "exhausted");
        assert!(one["last_redeemed_at"].is_string());

        // A paused coupon refuses new redemptions with its own message.
        let (st, _) = post_json_h(
            app,
            &format!("/api/admin/coupons/{coupon_id}/save"),
            json!({"code": code, "discount_type": "fixed", "discount_value": 300,
                   "quest_ids": [quest_a, quest_b], "paused": true}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, body) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": p("r4"), "quest_id": quest_a, "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);
        assert_eq!(body["error"], "Промокод временно не действует");

        // Unknown code on a paid quest → 404 with the player-facing message.
        let (st, body) = post_json(
            app,
            "/api/checkout",
            json!({"player_id": p("r5"), "quest_id": quest_a, "coupon_code": "NOPE-9"}),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "промокод не найден");
    }

    #[tokio::test]
    async fn checkout_redeems_coupons_with_limits_and_stats() {
        scenario_coupon_redeem(&test_app(), &Ids::new("cpn-redeem")).await;
    }

    /// v2 spec §9.1/§12.6 — the owner reports the dashboard status control fails
    /// on EVERY transition. The dashboard drives POST
    /// /api/constructor/quests/{id}/status with an EDITOR SESSION (Bearer), not
    /// the ops token that constructor_full_lifecycle uses — and until now the
    /// Postgres store never ran ANY constructor scenario. This walks the real
    /// user path over the full transition matrix on both stores.
    async fn scenario_ctor_status_lifecycle(app: &Router, ids: &Ids) {
        let bearer = editor_bearer(app, &ids.player).await;
        let h = [("authorization", bearer.as_str())];
        let quest = ids.quest.as_str();

        // Create a draft quest as the editor (session-authored, not ops-authored).
        let (st, created) = post_json_h(
            app,
            "/api/constructor/quests",
            json!({
                "quest_id": quest,
                "name": "Статусный квест",
                "cover": null,
                "steps_count": 1,
                "body": { "id": quest, "meta": { "title": "Статусный квест" }, "steps": [1], "versions": [] }
            }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK, "editor session can create: {created}");
        assert_eq!(created["status"], "draft");
        // §9.1 honest numbers for the status-change confirm dialog: the wire
        // carries the distinct-buyer count and the published snapshot version.
        assert_eq!(created["buyers"], 0, "fresh quest has no buyers");
        assert!(created["published_version"].is_null(), "no snapshot yet");

        let status_uri = format!("/api/constructor/quests/{quest}/status");

        // No published snapshot yet: test/published are rejected, draft is allowed.
        for s in ["test", "published"] {
            let (st, v) = post_json_h(app, &status_uri, json!({ "status": s }), &h).await;
            assert_eq!(st, StatusCode::BAD_REQUEST, "'{s}' needs a snapshot: {v}");
        }
        let (st, v) = post_json_h(app, &status_uri, json!({ "status": "draft" }), &h).await;
        assert_eq!(st, StatusCode::OK, "draft is always allowed: {v}");
        assert_eq!(v["status"], "draft");

        // Publish a version (editor session) — registers the frozen snapshot.
        let (st, pv) = post_json_h(
            app,
            "/api/quests/publish",
            json!({
                "quest_id": quest,
                "name": "Статусный квест",
                "template_summary": "1 step",
                "snapshot_version": 1,
                "snapshot_id": ids.snap1,
                "snapshot": { "steps": [] }
            }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK, "editor session can publish: {pv}");

        // A buyer appears in the wire counts (idempotent per player).
        let buyer = format!("buyer-{}", ids.player);
        for _ in 0..2 {
            let (st, _) = post_json(
                app,
                "/api/checkout",
                json!({ "player_id": buyer, "quest_id": quest }),
            )
            .await;
            assert_eq!(st, StatusCode::OK);
        }

        // With a snapshot present the FULL matrix the dashboard offers must work,
        // and store visibility must track `published`.
        for (next, visible) in [
            ("test", false),
            ("published", true),
            ("draft", false),
            ("test", false),
            ("published", true),
        ] {
            let (st, v) = post_json_h(app, &status_uri, json!({ "status": next }), &h).await;
            assert_eq!(st, StatusCode::OK, "'{next}' transition must succeed: {v}");
            assert_eq!(v["status"], next);
            assert_eq!(v["buyers"], 1, "one distinct buyer");
            assert_eq!(v["published_version"], 1, "snapshot v1 is live");
            let (_, list) = get_json(app, "/api/quests").await;
            let in_store = list
                .as_array()
                .expect("catalog array")
                .iter()
                .any(|q| q["quest_id"] == quest);
            assert_eq!(in_store, visible, "store visibility after '{next}'");
        }

        // The production shape: the OWNER acts as an ADMIN session on a quest
        // authored by SOMEONE ELSE (e.g. a bubble-imported author id that matches
        // no account). Admin is the superuser — every transition must work the
        // same as for the author.
        let admin_bearer = role_bearer(app, "adm", &ids.player, "admin").await;
        let ah = [("authorization", admin_bearer.as_str())];
        for next in ["draft", "test", "published"] {
            let (st, v) = post_json_h(app, &status_uri, json!({ "status": next }), &ah).await;
            assert_eq!(
                st,
                StatusCode::OK,
                "admin '{next}' on another author's quest: {v}"
            );
            assert_eq!(v["status"], next);
        }
    }

    /// §3.1/§12.9 — the product page endpoint returns ONLY model data: card
    /// meta + description, author attribution with on-sale count, and chips
    /// derived from the frozen snapshot. Visibility matches the catalog.
    async fn scenario_product_page(app: &Router, ids: &Ids) {
        let bearer = editor_bearer(app, &format!("pp-{}", ids.player)).await;
        let h = [("authorization", bearer.as_str())];
        let quest = ids.quest.as_str();

        let (st, _) = post_json_h(
            app,
            "/api/constructor/quests",
            json!({
                "quest_id": quest,
                "name": "Продуктовый квест",
                "cover": null,
                "steps_count": 3,
                "body": { "id": quest, "meta": { "title": "Продуктовый квест" }, "steps": [1, 2, 3], "versions": [] }
            }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Unpublished ⇒ the product page does not exist.
        let (st, _) = get_json(app, &format!("/api/quests/{quest}")).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "no product page before publish");

        let (st, _) = post_json_h(
            app,
            "/api/quests/publish",
            json!({
                "quest_id": quest,
                "name": "Продуктовый квест",
                "template_summary": "start, task_answer, congrats",
                "snapshot_version": 1,
                "snapshot_id": ids.snap1,
                "city": "Белград",
                "duration": "2–3 часа",
                "price": 890,
                "description": "Прогулка по кварталам, которых нет на открытках.",
                "snapshot": { "steps": [
                    { "template": "start", "supporting": { "is_start": true } },
                    { "template": "task_answer", "supporting": { "hint": { "cost_coins": 5, "reveal_text": "x" } } },
                    { "template": "congrats", "supporting": { "terminal": true } }
                ] }
            }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        let (st, v) = get_json(app, &format!("/api/quests/{quest}")).await;
        assert_eq!(st, StatusCode::OK, "product page after publish: {v}");
        assert_eq!(v["name"], "Продуктовый квест");
        assert_eq!(v["city"], "Белград");
        assert_eq!(v["price"], 890);
        assert_eq!(
            v["description"],
            "Прогулка по кварталам, которых нет на открытках."
        );
        assert_eq!(v["pages"], 3, "chips derive from the snapshot");
        assert_eq!(v["tasks"], 1);
        assert_eq!(v["paid_hints"], true);
        assert_eq!(v["rating_count"], 0);
        assert!(
            v["author_name"].as_str().is_some(),
            "author attribution present"
        );
        assert_eq!(v["author_published_count"], 1);

        // §5/§12.7: the cover→icon endpoint serves exact-size PNGs for the
        // per-quest PWA manifest (data-URI cover here; media-hash covers reuse
        // the same store the media endpoint serves).
        {
            use base64::Engine;
            let img = image::RgbaImage::from_pixel(64, 48, image::Rgba([200, 40, 40, 255]));
            let mut buf = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(img)
                .write_to(&mut buf, image::ImageFormat::Png)
                .expect("encode cover");
            let cover_uri = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
            );
            let (st, _) = post_json_h(
                app,
                "/api/quests/publish",
                json!({
                    "quest_id": quest,
                    "name": "Продуктовый квест",
                    "primary_comic": cover_uri,
                    "template_summary": "start, task_answer, congrats",
                    "snapshot_version": 1,
                    "snapshot_id": ids.snap1,
                    "snapshot": null
                }),
                &h,
            )
            .await;
            assert_eq!(st, StatusCode::OK, "republish same version with cover");
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/quests/{quest}/icons/192.png"))
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(resp.status(), StatusCode::OK, "icon serves");
            assert_eq!(
                resp.headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok()),
                Some("image/png")
            );
            let png = resp.into_body().collect().await.expect("body").to_bytes();
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n".as_slice(), "png signature");
            let (st, _) = get_json(app, &format!("/api/quests/{quest}/icons/64.png")).await;
            assert_eq!(st, StatusCode::NOT_FOUND, "only 192/512 exist");
        }

        // §11 reviews: a buyer plays, rates WITH text → the product page shows
        // the review (author first name from the display name; no email leak).
        {
            let buyer = format!("rev-{}", ids.player);
            let (st, _) = post_json(
                app,
                "/api/checkout",
                json!({ "player_id": buyer, "quest_id": quest }),
            )
            .await;
            assert_eq!(st, StatusCode::OK);
            let (st, att) = post_json(
                app,
                "/api/attempts",
                json!({ "player_id": buyer, "quest_id": quest }),
            )
            .await;
            assert_eq!(st, StatusCode::OK, "attempt: {att}");
            let attempt_id = att["attempt_id"].as_str().expect("attempt id");
            let rated = json!({ "facts": [{
                "type": "quest_rated", "step_position": 2, "submitted_value": "5",
                "local_is_correct": true, "coins_delta": 0,
                "note": "Прошли вдвоём за вечер, финал — мурашки.", "device_id": "d1"
            }] });
            let (st, _) = post_json(app, &format!("/api/attempts/{attempt_id}/facts"), rated).await;
            assert_eq!(st, StatusCode::OK);

            let (st, v) = get_json(app, &format!("/api/quests/{quest}")).await;
            assert_eq!(st, StatusCode::OK);
            assert_eq!(v["reviews_total"], 1, "one review with text: {v}");
            assert_eq!(v["reviews"][0]["rating"], 5);
            assert_eq!(
                v["reviews"][0]["text"],
                "Прошли вдвоём за вечер, финал — мурашки."
            );
            assert_eq!(
                v["reviews"][0]["author"], "Игрок",
                "anonymous buyer → «Игрок»"
            );
            assert!(
                v["reviews"][0].get("email").is_none(),
                "no email in the wire"
            );

            // A rating WITHOUT text is counted in rating_count but is not a review.
            assert_eq!(v["rating_count"], 1);
        }

        // Delisting hides the product page exactly like the catalog.
        let (st, _) = post_json_h(
            app,
            &format!("/api/constructor/quests/{quest}/status"),
            json!({ "status": "test" }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = get_json(app, &format!("/api/quests/{quest}")).await;
        assert_eq!(
            st,
            StatusCode::NOT_FOUND,
            "delisted quest has no product page"
        );
    }

    /// Pull the freshest emailed token for `to` out of the recorded outbox.
    fn mailed_token(mails: &Mutex<Vec<mailer::OutgoingMail>>, to: &str) -> String {
        let mails = mails.lock().expect("outbox lock");
        let mail = mails
            .iter()
            .rev()
            .find(|m| m.to == to)
            .expect("mail for recipient");
        let idx = mail.body.find("token=").expect("token link in mail");
        mail.body[idx + 6..idx + 6 + 64].to_string()
    }

    /// Pull the freshest emailed 6-digit reset code for `to` out of the outbox.
    fn mailed_code(mails: &Mutex<Vec<mailer::OutgoingMail>>, to: &str) -> String {
        let mails = mails.lock().expect("outbox lock");
        let mail = mails
            .iter()
            .rev()
            .find(|m| m.to == to)
            .expect("mail for recipient");
        let marker = "Код для смены пароля: ";
        let idx = mail.body.find(marker).expect("reset code in mail") + marker.len();
        mail.body[idx..idx + 6].to_string()
    }

    /// §6/§12.1–5 — auth v2 end to end: identify → register (+confirm mail) →
    /// confirm → recover → reset (signs in) → change password → delete account
    /// (with the editor-published block).
    async fn scenario_auth_v2(app: &Router, mails: &Mutex<Vec<mailer::OutgoingMail>>, ids: &Ids) {
        let player = ids.player.as_str();
        let email = format!("{player}@example.com");

        // 1) identify: unknown email.
        let (st, v) = post_json(app, "/api/auth/identify", json!({ "email": email })).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["exists"], false);

        // 2) register → session + confirmation mail (soft: account works now).
        let (_, token) = register(app, player).await;
        let bearer = format!("Bearer {token}");
        let (st, v) = post_json(app, "/api/auth/identify", json!({ "email": email })).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["exists"], true);
        assert_eq!(v["confirmed"], false, "soft confirmation: not yet");

        // 3) recover for an UNCONFIRMED email: uniform response, but the mail
        // that goes out is a fresh confirmation, not a reset link.
        let n_before = mails.lock().expect("lock").len();
        let (st, v) = post_json(app, "/api/auth/recover", json!({ "email": email })).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["status"], "sent");
        assert!(v["masked"].as_str().expect("masked").contains("***@"));
        assert!(
            mails.lock().expect("lock").len() > n_before,
            "confirmation resent"
        );
        assert!(
            mails
                .lock()
                .expect("lock")
                .last()
                .expect("mail")
                .subject
                .contains("Подтвердите"),
            "unconfirmed accounts get a confirmation, never a reset link"
        );

        // 4) confirm via the mailed token; reuse must fail.
        let confirm_token = mailed_token(mails, &email);
        let (st, _) = post_json(app, "/api/auth/confirm", json!({ "token": confirm_token })).await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json(app, "/api/auth/confirm", json!({ "token": confirm_token })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "single-use token");
        let (_, v) = post_json(app, "/api/auth/identify", json!({ "email": email })).await;
        assert_eq!(v["confirmed"], true);

        // 5) recovery now issues a reset link; enumeration-safe for strangers.
        let (st, v) = post_json(
            app,
            "/api/auth/recover",
            json!({ "email": "ghost@nowhere.example" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["status"], "sent", "same answer for unknown email");
        let (st, _) = post_json(app, "/api/auth/recover", json!({ "email": email })).await;
        assert_eq!(st, StatusCode::OK);
        let reset_token = mailed_token(mails, &email);

        // 6) reset: short password rejected; good one signs in; token single-use.
        let (st, _) = post_json(
            app,
            "/api/auth/reset",
            json!({ "token": reset_token, "password": "short" }),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, v) = post_json(
            app,
            "/api/auth/reset",
            json!({ "token": reset_token, "password": "newpass-12345" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "reset succeeds: {v}");
        assert_eq!(v["player_id"], player);
        assert_eq!(v["token"].as_str().map(str::len), Some(64), "signed in");
        let (st, _) = post_json(
            app,
            "/api/auth/reset",
            json!({ "token": reset_token, "password": "another-12345" }),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "reset token single-use");
        let (st, _) = post_json(
            app,
            "/api/auth/login",
            json!({ "email": email, "password": "hunter2hunter2" }),
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED, "old password is gone");
        let (st, lv) = post_json(
            app,
            "/api/auth/login",
            json!({ "email": email, "password": "newpass-12345" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let bearer2 = format!("Bearer {}", lv["token"].as_str().expect("token"));

        // 6.5) display name (§7.3 «Изменить имя»): set + trim + clear.
        let h2pre = [("authorization", bearer2.as_str())];
        let (st, v) = post_json_h(
            app,
            "/api/auth/display-name",
            json!({ "display_name": "  Анна  " }),
            &h2pre,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["display_name"], "Анна");

        // 7) change password (session): wrong current 401, right one works.
        let h2 = [("authorization", bearer2.as_str())];
        let (st, _) = post_json_h(
            app,
            "/api/auth/change-password",
            json!({ "current_password": "wrong-current", "new_password": "changed-12345" }),
            &h2,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        let (st, _) = post_json_h(
            app,
            "/api/auth/change-password",
            json!({ "current_password": "newpass-12345", "new_password": "changed-12345" }),
            &h2,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json(
            app,
            "/api/auth/login",
            json!({ "email": email, "password": "changed-12345" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // 8) delete-account: an author with a quest ON SALE is blocked.
        let admin_hdr = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let (st, _) = post_json_h(
            app,
            &format!("/api/admin/users/{player}/role"),
            json!({"role": "editor"}),
            &admin_hdr,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let quest = format!("{}-own", ids.quest);
        let (st, _) = post_json_h(app, "/api/constructor/quests", json!({
            "quest_id": quest, "name": "Мой квест", "cover": null, "steps_count": 1,
            "body": { "id": quest, "meta": { "title": "Мой квест" }, "steps": [1], "versions": [] }
        }), &h2).await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json_h(app, "/api/quests/publish", json!({
            "quest_id": quest, "name": "Мой квест", "template_summary": "1",
            "snapshot_version": 1, "snapshot_id": format!("{}-own-v1", ids.snap1), "snapshot": { "steps": [] }
        }), &h2).await;
        assert_eq!(st, StatusCode::OK);
        let (st, v) = post_json_h(app, "/api/auth/delete-account", json!({}), &h2).await;
        assert_eq!(
            st,
            StatusCode::CONFLICT,
            "published quest blocks deletion: {v}"
        );
        // Delist → deletion proceeds; the account and its session die.
        let (st, _) = post_json_h(
            app,
            &format!("/api/constructor/quests/{quest}/status"),
            json!({ "status": "draft" }),
            &h2,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json_h(app, "/api/auth/delete-account", json!({}), &h2).await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json(
            app,
            "/api/auth/login",
            json!({ "email": email, "password": "changed-12345" }),
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED, "account is gone");
        let (st, _) = get_json_h(
            app,
            "/api/players/me",
            &[("authorization", bearer.as_str())],
        )
        .await;
        // The pre-delete session must be dead too (claims fall back to anonymous or 401).
        assert_ne!(st, StatusCode::INTERNAL_SERVER_ERROR);
        let (_, v) = post_json(app, "/api/auth/identify", json!({ "email": email })).await;
        assert_eq!(v["exists"], false, "email is free again");
    }

    #[tokio::test]
    async fn publish_requires_editor_role() {
        scenario_publish_authz(&test_app(), &Ids::new("pubauthz")).await;
    }

    #[tokio::test]
    async fn ctor_status_lifecycle_editor_session() {
        scenario_ctor_status_lifecycle(&test_app(), &Ids::new("ctorstatus")).await;
    }

    #[tokio::test]
    async fn product_page_payload() {
        scenario_product_page(&test_app(), &Ids::new("product")).await;
    }

    #[tokio::test]
    async fn auth_v2_full_flow() {
        let (app, mails) = test_app_with_mail();
        scenario_auth_v2(&app, &mails, &Ids::new("authv2")).await;
    }

    /// §10.2/§12.10 — admin users pagination: ?page= opts in (25/page, newest
    /// first), no param keeps the legacy array shape.
    #[tokio::test]
    async fn admin_users_pagination() {
        let app = test_app();
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        for i in 0..27 {
            register(&app, &format!("pg-user-{i:02}")).await;
        }
        let (st, legacy) = get_json_h(&app, "/api/admin/users", &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(legacy.as_array().expect("legacy array").len(), 27);

        let (st, p1) = get_json_h(&app, "/api/admin/users?page=1", &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(p1["total"], 27);
        assert_eq!(p1["per_page"], 25);
        assert_eq!(p1["users"].as_array().expect("page 1").len(), 25);
        let (st, p2) = get_json_h(&app, "/api/admin/users?page=2", &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(p2["users"].as_array().expect("page 2").len(), 2);
        // Newest-first: page 1's head registered no earlier than page 2's tail.
        let first = p1["users"][0]["created_at"].as_u64().expect("created_at");
        let last = p2["users"][1]["created_at"].as_u64().expect("created_at");
        assert!(first >= last, "newest first across pages");
    }

    /// §6.1 — identify is rate-limited per email (fixed window).
    #[tokio::test]
    async fn identify_rate_limited() {
        let app = test_app();
        let body = json!({ "email": "probe@example.com" });
        for _ in 0..10 {
            let (st, _) = post_json(&app, "/api/auth/identify", body.clone()).await;
            assert_eq!(st, StatusCode::OK);
        }
        let (st, _) = post_json(&app, "/api/auth/identify", body.clone()).await;
        assert_eq!(
            st,
            StatusCode::TOO_MANY_REQUESTS,
            "11th probe in the window"
        );
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

    /// The mail-sending endpoints must be rate-limited server-side (per email):
    /// without this, a loop over /api/auth/recover mail-bombs the victim and
    /// burns the SMTP quota — the UI cooldown is not a boundary.
    #[tokio::test]
    async fn mail_endpoints_are_rate_limited_per_email() {
        let app = test_app();
        let ids = Ids::new("ratelimit");
        let (email, token) = register(&app, &ids.player).await;

        for i in 0..MAIL_SEND_LIMIT {
            let (st, _) = post_json(&app, "/api/auth/recover", json!({"email": email})).await;
            assert_eq!(st, StatusCode::OK, "recover #{i} within the window");
        }
        let (st, _) = post_json(&app, "/api/auth/recover", json!({"email": email})).await;
        assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "recover over the limit");

        // Resend-confirm has its own budget (separate limiter scope).
        let bearer = format!("Bearer {token}");
        for i in 0..MAIL_SEND_LIMIT {
            let (st, _) = post_json_h(
                &app,
                "/api/auth/confirm/resend",
                json!({}),
                &[("authorization", &bearer)],
            )
            .await;
            assert_eq!(st, StatusCode::OK, "resend #{i} within the window");
        }
        let (st, _) = post_json_h(
            &app,
            "/api/auth/confirm/resend",
            json!({}),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "resend over the limit");
    }

    /// §6.2 R2 — reset by emailed 6-digit code alongside the R1 link: the code
    /// is email-scoped, dies after MAX_CODE_ATTEMPTS verify attempts, and a
    /// fresh recover invalidates BOTH prior credentials (latest mail wins —
    /// with codes in play, N outstanding credentials would be N× guessable).
    async fn scenario_reset_by_code(
        app: &Router,
        mails: &Mutex<Vec<mailer::OutgoingMail>>,
        ids: &Ids,
    ) {
        let (email, _) = register(app, &ids.player).await;

        // Confirm the email — reset mail goes only to confirmed accounts.
        let confirm_token = mailed_token(mails, &email);
        let (st, _) = post_json(app, "/api/auth/confirm", json!({ "token": confirm_token })).await;
        assert_eq!(st, StatusCode::OK);

        // Recover: ONE mail carries both the link token and the code.
        let (st, _) = post_json(app, "/api/auth/recover", json!({ "email": email })).await;
        assert_eq!(st, StatusCode::OK);
        let old_token = mailed_token(mails, &email);
        let code = mailed_code(mails, &email);
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));

        // The code is scoped to its email: another account's email rejects it.
        let other = Ids::new(&format!("{}-other", ids.player));
        let (other_email, _) = register(app, &other.player).await;
        let (st, _) = post_json(
            app,
            "/api/auth/reset",
            json!({ "email": other_email, "code": code, "password": "newpass-12345" }),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "code is email-scoped");

        // Wrong guesses burn the per-token attempt budget; after that even the
        // RIGHT code is dead (low-entropy codes must not be brute-forceable).
        for i in 0..store::MAX_CODE_ATTEMPTS {
            let (st, _) = post_json(
                app,
                "/api/auth/reset",
                json!({ "email": email, "code": "000000", "password": "newpass-12345" }),
            )
            .await;
            assert_eq!(st, StatusCode::BAD_REQUEST, "wrong code #{i}");
        }
        let (st, _) = post_json(
            app,
            "/api/auth/reset",
            json!({ "email": email, "code": code, "password": "newpass-12345" }),
        )
        .await;
        assert_eq!(
            st,
            StatusCode::BAD_REQUEST,
            "exhausted budget kills the code"
        );

        // A fresh recover invalidates the PREVIOUS link token too.
        let (st, _) = post_json(app, "/api/auth/recover", json!({ "email": email })).await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json(
            app,
            "/api/auth/reset",
            json!({ "token": old_token, "password": "newpass-12345" }),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "new issue kills the old link");

        // The fresh code works (email case-insensitively): signs in, sets the
        // password; single-use.
        let code = mailed_code(mails, &email);
        let (st, v) = post_json(
            app,
            "/api/auth/reset",
            json!({ "email": email.to_uppercase(), "code": code, "password": "bycode-12345" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "reset by code: {v}");
        assert_eq!(v["player_id"], ids.player.as_str());
        assert_eq!(v["token"].as_str().map(str::len), Some(64), "signed in");
        let (st, _) = post_json(
            app,
            "/api/auth/login",
            json!({ "email": email, "password": "bycode-12345" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "new password works");
        let (st, _) = post_json(
            app,
            "/api/auth/reset",
            json!({ "email": email, "code": code, "password": "again-12345" }),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "code is single-use");
    }

    #[tokio::test]
    async fn reset_by_code_alongside_link() {
        let (app, mails) = test_app_with_mail();
        scenario_reset_by_code(&app, &mails, &Ids::new("resetcode")).await;
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
        let (st, _) = get_json_h(
            &app,
            "/api/constructor/quests",
            &[("x-admin-token", TEST_ADMIN_TOKEN)],
        )
        .await;
        assert_eq!(
            st,
            StatusCode::OK,
            "ops token authorizes the editor surface"
        );
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
        let (st, created) = post_json_h(&app, "/api/constructor/quests", body, &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(created["status"], "draft");
        assert_eq!(created["steps"], 2);
        assert_eq!(created["completed"], 0);
        assert_eq!(
            created["author"], "Оператор",
            "ops path is labeled generically"
        );

        // List shows it.
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert_eq!(list.as_array().expect("array").len(), 1);
        assert_eq!(list[0]["quest_id"], "q-test");

        // Get returns the full body.
        let (st, full) = get_json_h(&app, "/api/constructor/quests/q-test", &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(full["body"]["steps"].as_array().expect("steps").len(), 2);

        // Save updates name + step count.
        let save = json!({
            "name": "Переименован",
            "cover": "cover.png",
            "steps_count": 5,
            "body": { "id": "q-test", "steps": [1, 2, 3, 4, 5] }
        });
        let (st, _) = post_json_h(&app, "/api/constructor/quests/q-test/save", save, &admin).await;
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
        assert_eq!(
            st,
            StatusCode::BAD_REQUEST,
            "test needs a published snapshot first"
        );
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
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-test/delete",
            json!({}),
            &admin,
        )
        .await;
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

    /// GET .../export bundles `manifest.json` + `quest.json` (media URLs
    /// rewritten to zip-relative paths, wherever they appear in the body) +
    /// the media files themselves, download headers included. Content only —
    /// no play/rating stats. Owner-or-admin gated like every other per-quest
    /// constructor route.
    #[tokio::test]
    async fn constructor_export_bundles_quest_and_media() {
        let app = test_app();
        let owner: [(&str, &str); 2] = [
            ("x-admin-token", TEST_ADMIN_TOKEN),
            ("x-player-id", "dev-owner"),
        ];
        let other: [(&str, &str); 2] = [
            ("x-admin-token", TEST_ADMIN_TOKEN),
            ("x-player-id", "dev-other"),
        ];

        // Upload the cover image the quest body will reference.
        let img_bytes = vec![137u8, 80, 78, 71, 9, 9, 9];
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/media")
                    .header("x-admin-token", TEST_ADMIN_TOKEN)
                    .header("content-type", "image/png")
                    .body(Body::from(img_bytes.clone()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(res.status(), StatusCode::OK);
        let media_bytes = res.into_body().collect().await.unwrap().to_bytes();
        let media_ref: Value = serde_json::from_slice(&media_bytes).unwrap();
        let cover_url = media_ref["url"].as_str().expect("url").to_string();
        let hash = media_ref["hash"].as_str().expect("hash").to_string();

        let body = json!({
            "quest_id": "q-export",
            "name": "Экспорт квест",
            "cover": cover_url,
            "steps_count": 1,
            "body": {
                "id": "q-export",
                "meta": { "title": "Экспорт квест", "cover": cover_url },
                "steps": [{ "image": cover_url }],
            }
        });
        let (st, _) = post_json_h(&app, "/api/constructor/quests", body, &owner).await;
        assert_eq!(st, StatusCode::OK);

        // A different author gets the same opaque 404 as the rest of the constructor surface.
        let (st, _) = get_json_h(&app, "/api/constructor/quests/q-export/export", &other).await;
        assert_eq!(
            st,
            StatusCode::NOT_FOUND,
            "cannot export another author's quest"
        );

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/constructor/quests/q-export/export")
                    .header("x-admin-token", TEST_ADMIN_TOKEN)
                    .header("x-player-id", "dev-owner")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get("content-type").unwrap(),
            "application/zip"
        );
        assert_eq!(
            res.headers().get("content-disposition").unwrap(),
            "attachment; filename=\"quest-q-export.zip\""
        );
        let zip_bytes = res.into_body().collect().await.unwrap().to_bytes();

        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes.to_vec())).unwrap();
        let expected_media_path = format!("media/{hash}.png");
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "manifest.json".to_string(),
                expected_media_path.clone(),
                "quest.json".to_string(),
            ]
        );

        let mut manifest_entry = archive.by_name("manifest.json").unwrap();
        let mut manifest_str = String::new();
        std::io::Read::read_to_string(&mut manifest_entry, &mut manifest_str).unwrap();
        let manifest: Value = serde_json::from_str(&manifest_str).unwrap();
        assert_eq!(manifest["quest_id"], "q-export");
        assert_eq!(manifest["format_version"], export::FORMAT_VERSION);
        drop(manifest_entry);

        let mut quest_entry = archive.by_name("quest.json").unwrap();
        let mut quest_str = String::new();
        std::io::Read::read_to_string(&mut quest_entry, &mut quest_str).unwrap();
        let quest_value: Value = serde_json::from_str(&quest_str).unwrap();
        assert_eq!(quest_value["cover"], expected_media_path);
        assert_eq!(quest_value["body"]["meta"]["cover"], expected_media_path);
        assert_eq!(
            quest_value["body"]["steps"][0]["image"],
            expected_media_path
        );
        drop(quest_entry);

        let mut media_entry = archive.by_name(&expected_media_path).unwrap();
        let mut media_out = Vec::new();
        std::io::Read::read_to_end(&mut media_entry, &mut media_out).unwrap();
        assert_eq!(media_out, img_bytes);
    }

    /// Quest attributes (complexity / age target / tags): neutral defaults when the
    /// client omits them (old clients keep working), full round-trip via save on
    /// both the list row and GET-one, tag normalization, and closed-set rejection.
    #[tokio::test]
    async fn constructor_quest_attributes() {
        let app = test_app();
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        // Create WITHOUT attributes → neutral defaults.
        let (st, created) = post_json_h(
            &app,
            "/api/constructor/quests",
            json!({
                "quest_id": "q-attrs",
                "name": "Квест",
                "cover": null,
                "steps_count": 2,
                "body": { "id": "q-attrs", "meta": {}, "steps": [], "versions": [] }
            }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(created["complexity"], "medium");
        assert_eq!(created["age_target"], "everyone");
        assert_eq!(created["tags"], json!([]));

        // Save with explicit attributes → the list row carries them (the dashboard
        // filters on list rows, so they must be there, not only in the body).
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-attrs/save",
            json!({
                "name": "Квест",
                "cover": null,
                "steps_count": 2,
                "complexity": "high",
                "age_target": "18plus",
                "tags": ["хоррор", "  юмор  ", "", "хоррор"],
                "body": { "id": "q-attrs", "steps": [] }
            }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert_eq!(list[0]["complexity"], "high");
        assert_eq!(list[0]["age_target"], "18plus");
        assert_eq!(
            list[0]["tags"],
            json!(["хоррор", "юмор"]),
            "tags come back trimmed, de-blanked, deduped"
        );

        // GET-one carries them too (the builder re-opens saved values).
        let (_, full) = get_json_h(&app, "/api/constructor/quests/q-attrs", &admin).await;
        assert_eq!(full["complexity"], "high");
        assert_eq!(full["age_target"], "18plus");
        assert_eq!(full["tags"], json!(["хоррор", "юмор"]));

        // Closed sets are enforced on save…
        let bad_save = json!({
            "name": "Квест", "cover": null, "steps_count": 2,
            "complexity": "extreme",
            "body": { "id": "q-attrs", "steps": [] }
        });
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-attrs/save",
            bad_save,
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        // …and on create.
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests",
            json!({
                "quest_id": "q-attrs-2", "name": "Квест", "cover": null, "steps_count": 1,
                "age_target": "adults",
                "body": { "id": "q-attrs-2", "steps": [] }
            }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        // A rejected save must not have clobbered the stored attributes.
        let (_, full) = get_json_h(&app, "/api/constructor/quests/q-attrs", &admin).await;
        assert_eq!(full["complexity"], "high");

        // Create WITH attributes works end-to-end.
        let (st, created) = post_json_h(
            &app,
            "/api/constructor/quests",
            json!({
                "quest_id": "q-attrs-3", "name": "Детский", "cover": null, "steps_count": 1,
                "complexity": "low",
                "age_target": "kids",
                "tags": ["приключения"],
                "body": { "id": "q-attrs-3", "steps": [] }
            }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(created["complexity"], "low");
        assert_eq!(created["age_target"], "kids");
        assert_eq!(created["tags"], json!(["приключения"]));
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
        let a: [(&str, &str); 2] = [
            ("x-admin-token", TEST_ADMIN_TOKEN),
            ("x-player-id", "dev-a"),
        ];
        let b: [(&str, &str); 2] = [
            ("x-admin-token", TEST_ADMIN_TOKEN),
            ("x-player-id", "dev-b"),
        ];

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
        assert_eq!(
            st,
            StatusCode::NOT_FOUND,
            "cannot get another author's quest"
        );
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-a/save",
            json!({ "name": "захват", "cover": null, "steps_count": 1, "body": {} }),
            &b,
        )
        .await;
        assert_eq!(
            st,
            StatusCode::NOT_FOUND,
            "cannot save another author's quest"
        );
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests/q-a/status",
            json!({ "status": "published" }),
            &b,
        )
        .await;
        assert_eq!(
            st,
            StatusCode::NOT_FOUND,
            "cannot restatus another author's quest"
        );
        let (st, _) = post_json_h(&app, "/api/constructor/quests/q-a/delete", json!({}), &b).await;
        assert_eq!(
            st,
            StatusCode::NOT_FOUND,
            "cannot delete another author's quest"
        );

        // A's quest survived every B attempt, unchanged, and A still owns it.
        let (st, full) = get_json_h(&app, "/api/constructor/quests/q-a", &a).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            full["name"], "Квест А",
            "A's quest is untouched by B's attempts"
        );
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
        let (_, la) = get_json_h(
            &app,
            "/api/constructor/quests",
            &[("authorization", a.as_str())],
        )
        .await;
        let la = la.as_array().expect("array");
        assert_eq!(la.len(), 1, "an editor sees only their own quests");
        assert_eq!(la[0]["quest_id"], "q-eda");

        // The admin sees BOTH authors' quests.
        let (_, all) = get_json_h(
            &app,
            "/api/constructor/quests",
            &[("authorization", admin.as_str())],
        )
        .await;
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
        assert!(
            !store_has(&app, "q-pub").await,
            "absent from the store before publishing"
        );

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
        assert!(
            store_has(&app, "q-pub").await,
            "a published quest appears in the store"
        );

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
        assert_eq!(
            store.as_array().expect("array").len(),
            0,
            "no seeded store quests"
        );
        let (_, list) = get_json_h(&app, "/api/constructor/quests", &admin).await;
        assert_eq!(
            list.as_array().expect("array").len(),
            0,
            "no seeded constructor quests"
        );

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
        assert!(
            list.as_array()
                .expect("array")
                .iter()
                .any(|q| q["quest_id"] == "q-real")
        );
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
            store
                .as_array()
                .expect("array")
                .iter()
                .any(|q| q["quest_id"] == "q-real"),
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

    fn pg_app(pool: sqlx::PgPool) -> (Router, std::sync::Arc<Mutex<Vec<mailer::OutgoingMail>>>) {
        let media_cfg = test_media_cfg();
        let (m, outbox) = mailer::Mailer::recorder();
        let router = build_router(AppState {
            config: AppConfig {
                addr: "0.0.0.0:0".parse().expect("test addr"),
                version: "test-pg",
                admin_token: Some(TEST_ADMIN_TOKEN.to_string()),
                cors_allowed_origins: Vec::new(),
                media: media_cfg.clone(),
                smtp_url: None,
                mail_from: "test@geohod.test".to_string(),
                frontend_base: "http://localhost:3000".to_string(),
                google_client_id: None,
                telegram_client_id: None,
                yookassa: None,
            },
            store: FactStores::Postgres(pg_store::PgFactStore::new(pool.clone())),
            grants: GrantStores::Postgres(pg_store::PgGrantStore::new(pool.clone())),
            auth: AuthStores::Postgres(pg_store::PgAuthStore::new(pool.clone())),
            constructor: ConstructorStores::Postgres(pg_store::PgConstructorStore::new(
                pool.clone(),
            )),
            coupons: CouponStores::Postgres(pg_store::PgCouponStore::new(pool.clone())),
            media: MediaStores::from_config(&media_cfg).expect("in-process media store"),
            payment_rows: PaymentStores::Postgres(pg_store::PgPaymentStore::new(pool.clone())),
            flags: FlagStores::Postgres(pg_store::PgFlagStore::new(pool)),
            yookassa: None,
            mailer: m,
            rate_limiter: Arc::new(Mutex::new(std::collections::HashMap::new())),
            google: None,
            telegram: None,
        });
        (router, outbox)
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
        let (app, _mails) = pg_app(pool);
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
        let dev: [(&str, &str); 2] = [
            ("x-admin-token", TEST_ADMIN_TOKEN),
            ("x-player-id", dev_id.as_str()),
        ];
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
        assert_eq!(
            st,
            StatusCode::NOT_FOUND,
            "cross-author get is hidden on SQL"
        );
        // Clean up the foreign quest (shared-DB hygiene).
        let (st, _) = post_json_h(
            &app,
            &format!("/api/constructor/quests/{other_qid}/delete"),
            json!({}),
            &dev,
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // get returns the full body
        let (st, full) = get_json_h(&app, &format!("/api/constructor/quests/{qid}"), &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(full["body"]["steps"].as_array().expect("steps").len(), 2);

        // save updates name + step count + attributes (real SQL round-trip for the
        // TEXT + CHECK columns and the TEXT[] tags)
        let (st, _) = post_json_h(
            &app,
            &format!("/api/constructor/quests/{qid}/save"),
            json!({
                "name": "CI renamed", "cover": "c.png", "steps_count": 4,
                "complexity": "high", "age_target": "18plus", "tags": ["хоррор", "юмор"],
                "body": { "id": qid.clone(), "steps": [1, 2, 3, 4] }
            }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, full) = get_json_h(&app, &format!("/api/constructor/quests/{qid}"), &admin).await;
        assert_eq!(full["complexity"], "high");
        assert_eq!(full["age_target"], "18plus");
        assert_eq!(full["tags"], json!(["хоррор", "юмор"]));

        // export must work against the REAL SQL store — the in-memory suite
        // cannot surface PG-only failures (an early version 500'd here on a
        // negative LIMIT produced by an `as i64` cast in a store query).
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/constructor/quests/{qid}/export"))
                    .header("x-admin-token", TEST_ADMIN_TOKEN)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(res.status(), StatusCode::OK, "export on the PG store");

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
        let (app, pg_mails) = pg_app(pool.clone());

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
        scenario_admin_coupons(&app, &Ids::new(&format!("cpncrud-{run}"))).await;
        scenario_coupon_validate(&app, &Ids::new(&format!("cpnprev-{run}"))).await;
        scenario_coupon_redeem(&app, &Ids::new(&format!("cpnrdm-{run}"))).await;
        scenario_publish_authz(&app, &Ids::new(&format!("pubauthz-{run}"))).await;
        scenario_ctor_status_lifecycle(&app, &Ids::new(&format!("ctorstatus-{run}"))).await;
        scenario_product_page(&app, &Ids::new(&format!("product-{run}"))).await;
        scenario_auth_v2(&app, &pg_mails, &Ids::new(&format!("authv2-{run}"))).await;
        scenario_reset_by_code(&app, &pg_mails, &Ids::new(&format!("resetcode-{run}"))).await;
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
        let (app2, _mails2) = pg_app(pool2);
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
    // ===== YooKassa redirect flow (scripted fake gateway — the real API is
    // ===== never called from tests) =====

    /// `test_app` + the scripted YooKassa fake injected into state.
    fn test_app_yookassa() -> (Router, std::sync::Arc<Mutex<yookassa::FakeYookassa>>) {
        let mut state = test_state(AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            version: "test-0.0.0",
            admin_token: Some(TEST_ADMIN_TOKEN.to_string()),
            cors_allowed_origins: Vec::new(),
            media: test_media_cfg(),
            smtp_url: None,
            mail_from: "test@geohod.test".to_string(),
            frontend_base: "http://localhost:3000".to_string(),
            google_client_id: None,
            telegram_client_id: None,
            yookassa: None,
        });
        let (gateway, fake) = YookassaGateway::fake();
        state.yookassa = Some(gateway);
        (build_router(state), fake)
    }

    /// Start a yookassa checkout for a freshly published paid quest; returns
    /// `(our_payment_id, provider_payment_id, confirmation_url)`.
    async fn start_yookassa_checkout(
        app: &Router,
        ids: &Ids,
        price: i64,
        coupon_code: Option<&str>,
    ) -> (String, String, String) {
        let (st, _) = publish(
            app,
            ids,
            json!({"quest_id": ids.quest, "name": "Платный квест", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": ids.snap1, "price": price}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let mut body = json!({"player_id": ids.player, "quest_id": ids.quest,
                              "provider": "yookassa"});
        if let Some(code) = coupon_code {
            body["coupon_code"] = json!(code);
        }
        let (st, v) = post_json(app, "/api/checkout", body).await;
        assert_eq!(st, StatusCode::OK);
        assert!(v.get("grant").is_none(), "no grant before settlement: {v}");
        let payment_id = v["payment"]["payment_id"]
            .as_str()
            .expect("payment_id")
            .to_string();
        let confirmation_url = v["payment"]["confirmation_url"]
            .as_str()
            .expect("confirmation_url")
            .to_string();
        // The fake mints sequential yk-N ids; extract from the confirmation URL.
        let provider_id = confirmation_url.rsplit('/').next().expect("id").to_string();
        (payment_id, provider_id, confirmation_url)
    }

    /// Owner poll for a payment (X-Player-Id identity, as the return page does).
    async fn poll_payment(app: &Router, player: &str, payment_id: &str) -> (StatusCode, Value) {
        get_json_h(
            app,
            &format!("/api/payments/{payment_id}"),
            &[("x-player-id", player)],
        )
        .await
    }

    #[tokio::test]
    async fn yookassa_checkout_pends_reuses_and_poll_settles() {
        let (app, fake) = test_app_yookassa();
        let ids = Ids::new("yk-flow");
        let (payment_id, provider_id, confirmation_url) =
            start_yookassa_checkout(&app, &ids, 300, None).await;
        assert!(confirmation_url.starts_with("https://yookassa.test/confirm/"));

        // The create body priced the full amount and pointed back at the quest.
        let body = fake
            .lock()
            .expect("fake")
            .last_create_body
            .clone()
            .expect("create body");
        assert_eq!(body["amount"]["value"], "300.00");
        assert_eq!(body["capture"], true);
        assert_eq!(
            body["confirmation"]["return_url"],
            format!(
                "http://localhost:3000/quest/{}/about?payment={payment_id}",
                ids.quest
            )
        );

        // Pending: the poll reports it, and no grant exists yet.
        let (st, v) = poll_payment(&app, &ids.player, &payment_id).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["status"], "pending");
        assert!(v["grant"].is_null());
        let (_, grants) = get_json_h(
            &app,
            &format!("/api/grants?player_id={}", ids.player),
            &[("x-player-id", ids.player.as_str())],
        )
        .await;
        assert_eq!(
            grants.as_array().map(Vec::len),
            Some(0),
            "no grant while pending"
        );

        // A repeat checkout replays the SAME payment — no duplicate at the gateway.
        let (st, v) = post_json(
            &app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest, "provider": "yookassa"}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["payment"]["payment_id"], payment_id.as_str());

        // A foreign player cannot probe the payment id.
        let (st, _) = poll_payment(&app, "player-intruder", &payment_id).await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        // The payer pays; the poll settles and mints the audited grant.
        fake.lock()
            .expect("fake")
            .set_status(&provider_id, yookassa::RemoteStatus::Succeeded);
        let (st, v) = poll_payment(&app, &ids.player, &payment_id).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["status"], "succeeded");
        assert_eq!(v["grant"]["source"], "Payment");
        assert_eq!(v["grant"]["source_ref"], provider_id.as_str());

        // Poll again: stable (idempotent), and checkout now short-circuits owned.
        let (_, v) = poll_payment(&app, &ids.player, &payment_id).await;
        assert_eq!(v["status"], "succeeded");
        let (_, v) = post_json(
            &app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest, "provider": "yookassa"}),
        )
        .await;
        assert_eq!(v["created"], false, "owned quest returns the stored grant");
    }

    #[tokio::test]
    async fn yookassa_webhook_settles_but_forgery_is_harmless() {
        let (app, fake) = test_app_yookassa();
        let ids = Ids::new("yk-hook");
        let (payment_id, provider_id, _) = start_yookassa_checkout(&app, &ids, 500, None).await;

        let notification = json!({
            "type": "notification", "event": "payment.succeeded",
            "object": {"id": provider_id, "status": "succeeded"}
        });
        // Forged: the remote payment is still pending — the webhook re-checks
        // the API, changes nothing, and still answers 200.
        let (st, _) = post_json(&app, "/api/payments/yookassa/webhook", notification.clone()).await;
        assert_eq!(st, StatusCode::OK);
        let (_, v) = poll_payment(&app, &ids.player, &payment_id).await;
        assert_eq!(
            v["status"], "pending",
            "forged notification must not settle"
        );

        // Genuine: remote succeeded — the same notification now settles.
        fake.lock()
            .expect("fake")
            .set_status(&provider_id, yookassa::RemoteStatus::Succeeded);
        let (st, _) = post_json(&app, "/api/payments/yookassa/webhook", notification).await;
        assert_eq!(st, StatusCode::OK);
        let (_, v) = poll_payment(&app, &ids.player, &payment_id).await;
        assert_eq!(v["status"], "succeeded");
        assert_eq!(v["grant"]["source_ref"], provider_id.as_str());

        // Unknown payment and non-payment events are acknowledged and dropped.
        let (st, _) = post_json(
            &app,
            "/api/payments/yookassa/webhook",
            json!({"type": "notification", "event": "payment.succeeded",
                   "object": {"id": "yk-ghost", "status": "succeeded"}}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json(
            &app,
            "/api/payments/yookassa/webhook",
            json!({"type": "notification", "event": "refund.succeeded", "object": {"id": "r-1"}}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
    }

    #[tokio::test]
    async fn yookassa_canceled_grants_nothing_and_frees_a_retry() {
        let (app, fake) = test_app_yookassa();
        let ids = Ids::new("yk-cancel");
        let (payment_id, provider_id, _) = start_yookassa_checkout(&app, &ids, 300, None).await;

        fake.lock()
            .expect("fake")
            .set_status(&provider_id, yookassa::RemoteStatus::Canceled);
        let (st, v) = poll_payment(&app, &ids.player, &payment_id).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["status"], "canceled");
        assert!(v["grant"].is_null());

        // A fresh checkout starts a NEW payment (the canceled one is closed).
        let (_, v) = post_json(
            &app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest, "provider": "yookassa"}),
        )
        .await;
        let second = v["payment"]["payment_id"].as_str().expect("payment_id");
        assert_ne!(second, payment_id, "canceled payment is not replayed");
    }

    #[tokio::test]
    async fn yookassa_coupon_prices_now_but_redeems_only_on_success() {
        let (app, fake) = test_app_yookassa();
        let ids = Ids::new("yk-promo");
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let code = format!("{}-HALF", ids.quest.to_ascii_uppercase());
        let (st, coupon) = post_json_h(
            &app,
            "/api/admin/coupons",
            json!({"code": code, "discount_type": "percent", "discount_value": 50}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let coupon_id = coupon["coupon_id"].as_str().expect("coupon_id").to_string();

        // Initiation charges the discounted amount but does NOT redeem.
        let (payment_id, provider_id, _) =
            start_yookassa_checkout(&app, &ids, 300, Some(&code)).await;
        let body = fake
            .lock()
            .expect("fake")
            .last_create_body
            .clone()
            .expect("create body");
        assert_eq!(body["amount"]["value"], "150.00", "50% off 300");
        let (_, usage) = get_json_h(&app, &format!("/api/admin/coupons/{coupon_id}"), &admin).await;
        assert_eq!(usage["used"], 0, "not redeemed at initiation");

        // Canceled: the code survives untouched.
        fake.lock()
            .expect("fake")
            .set_status(&provider_id, yookassa::RemoteStatus::Canceled);
        let (_, v) = poll_payment(&app, &ids.player, &payment_id).await;
        assert_eq!(v["status"], "canceled");
        let (_, usage) = get_json_h(&app, &format!("/api/admin/coupons/{coupon_id}"), &admin).await;
        assert_eq!(usage["used"], 0, "canceled payment must not burn the code");

        // Retry succeeds: settlement redeems exactly once (repeat polls stay 1).
        let (st, v) = post_json(
            &app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest,
                   "provider": "yookassa", "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let retry_id = v["payment"]["payment_id"]
            .as_str()
            .expect("payment_id")
            .to_string();
        let retry_provider = v["payment"]["confirmation_url"]
            .as_str()
            .expect("url")
            .rsplit('/')
            .next()
            .expect("id")
            .to_string();
        fake.lock()
            .expect("fake")
            .set_status(&retry_provider, yookassa::RemoteStatus::Succeeded);
        let (_, v) = poll_payment(&app, &ids.player, &retry_id).await;
        assert_eq!(v["status"], "succeeded");
        let (_, usage) = get_json_h(&app, &format!("/api/admin/coupons/{coupon_id}"), &admin).await;
        assert_eq!(usage["used"], 1, "settlement winner redeems once");
        let (_, v) = poll_payment(&app, &ids.player, &retry_id).await;
        assert_eq!(v["status"], "succeeded");
        let (_, usage) = get_json_h(&app, &format!("/api/admin/coupons/{coupon_id}"), &admin).await;
        assert_eq!(usage["used"], 1, "repeat settle does not double-redeem");
    }

    #[tokio::test]
    async fn yookassa_full_coupon_and_free_quest_bypass_the_gateway() {
        let (app, fake) = test_app_yookassa();
        let ids = Ids::new("yk-bypass");
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let (st, _) = publish(
            &app,
            &ids,
            json!({"quest_id": ids.quest, "name": "Q", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": ids.snap1, "price": 300}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let code = format!("{}-FULL", ids.quest.to_ascii_uppercase());
        let (st, _) = post_json_h(
            &app,
            "/api/admin/coupons",
            json!({"code": code, "discount_type": "percent", "discount_value": 100}),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, v) = post_json(
            &app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest,
                   "provider": "yookassa", "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            v["grant"]["source"], "CouponRedemption",
            "settled instantly"
        );
        assert!(
            fake.lock().expect("fake").last_create_body.is_none(),
            "gateway untouched"
        );

        // Free quest through the yookassa arm: granted immediately, no payment.
        let free_quest = format!("{}-free", ids.quest);
        let (st, _) = publish(
            &app,
            &ids,
            json!({"quest_id": free_quest, "name": "F", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": format!("{}-f", ids.snap1), "price": 0}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, v) = post_json(
            &app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": free_quest, "provider": "yookassa"}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["grant"]["source"], "FreeQuest");
        assert!(
            fake.lock().expect("fake").last_create_body.is_none(),
            "gateway untouched"
        );
    }

    #[tokio::test]
    async fn yookassa_unconfigured_fails_closed_and_unknown_provider_rejected() {
        let app = test_app();
        let ids = Ids::new("yk-off");
        let (st, _) = post_json(
            &app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest, "provider": "yookassa"}),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_IMPLEMENTED);
        let (st, _) = post_json(
            &app,
            "/api/checkout",
            json!({"player_id": ids.player, "quest_id": ids.quest, "provider": "paypal"}),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn payment_providers_reflect_deployment_config() {
        let (st, v) = get_json(&test_app(), "/api/payments/providers").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["providers"], json!(["mock"]));
        let (app, _) = test_app_yookassa();
        let (_, v) = get_json(&app, "/api/payments/providers").await;
        assert_eq!(v["providers"], json!(["mock", "yookassa"]));
    }

    // ---- feature toggles (features.rs + /api/admin/features) ----------------

    #[tokio::test]
    async fn features_admin_gated_and_lists_registry_defaults() {
        let app = test_app();
        // No credential and a fail-closed (no ADMIN_TOKEN) deployment both 403.
        let (st, _) = get_json(&app, "/api/admin/features").await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        let (st, _) = get_json_h(&test_app_no_admin(), "/api/admin/features", &[]).await;
        assert_eq!(st, StatusCode::FORBIDDEN);

        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let (st, v) = get_json_h(&app, "/api/admin/features", &admin).await;
        assert_eq!(st, StatusCode::OK);
        let rows = v.as_array().expect("feature list");
        assert_eq!(rows.len(), features::Feature::ALL.len());
        for row in rows {
            // No overrides stored: every flag sits on its code default.
            assert_eq!(row["override"], Value::Null);
            assert_eq!(row["effective"], row["default_enabled"]);
        }
        // Capability on this unconfigured test app: only the mock is available.
        let available: Vec<(&str, bool)> = rows
            .iter()
            .map(|r| {
                (
                    r["key"].as_str().expect("key"),
                    r["available"].as_bool().expect("available"),
                )
            })
            .collect();
        assert_eq!(
            available,
            vec![
                ("auth_google", false),
                ("auth_telegram", false),
                ("payments_mock", true),
                ("payments_yookassa", false),
            ]
        );
    }

    #[tokio::test]
    async fn feature_mutation_rejects_unknown_key_and_requires_admin() {
        let app = test_app();
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let (st, _) = post_json_h(
            &app,
            "/api/admin/features/payments_paypal",
            json!({ "enabled": false }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _) = post_json(
            &app,
            "/api/admin/features/payments_mock",
            json!({ "enabled": false }),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn disabling_mock_provider_gates_checkout_and_provider_list() {
        let app = test_app();
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        let (st, row) = post_json_h(
            &app,
            "/api/admin/features/payments_mock",
            json!({ "enabled": false }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(row["override"], json!(false));
        assert_eq!(row["effective"], json!(false));

        // The only configured provider is off: the list is empty and checkout 501s.
        let (_, v) = get_json(&app, "/api/payments/providers").await;
        assert_eq!(v["providers"], json!([]));
        let (st, _) = post_json(
            &app,
            "/api/checkout",
            json!({"player_id": "dev:ft", "quest_id": "q-ft", "coupon_code": null}),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_IMPLEMENTED);

        // `enabled: null` clears the override — back to the code default (on).
        let (st, row) = post_json_h(
            &app,
            "/api/admin/features/payments_mock",
            json!({ "enabled": null }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(row["override"], Value::Null);
        assert_eq!(row["effective"], json!(true));
        let (_, v) = get_json(&app, "/api/payments/providers").await;
        assert_eq!(v["providers"], json!(["mock"]));
        let (st, _) = post_json(
            &app,
            "/api/checkout",
            json!({"player_id": "dev:ft", "quest_id": "q-ft", "coupon_code": null}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
    }

    #[tokio::test]
    async fn disabling_social_auth_hides_provider_and_blocks_login() {
        let app = test_app_social(); // telegram configured + seeded verifier
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        // Configured and on by default: the client id is public.
        let (_, v) = get_json(&app, "/api/auth/providers").await;
        assert!(v["telegram_client_id"].is_string());

        let (st, _) = post_json_h(
            &app,
            "/api/admin/features/auth_telegram",
            json!({ "enabled": false }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Off: the button hides (null id) and a direct login POST is refused
        // with the same 501 an unconfigured deployment answers.
        let (_, v) = get_json(&app, "/api/auth/providers").await;
        assert_eq!(v["telegram_client_id"], Value::Null);
        let (st, _) = post_json(&app, "/api/auth/telegram", tg_payload("dev:ft", 7, "Ann")).await;
        assert_eq!(st, StatusCode::NOT_IMPLEMENTED);

        // Back on: login works end to end again.
        let (st, _) = post_json_h(
            &app,
            "/api/admin/features/auth_telegram",
            json!({ "enabled": true }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json(&app, "/api/auth/telegram", tg_payload("dev:ft", 7, "Ann")).await;
        assert_eq!(st, StatusCode::OK);
    }

    /// Exercises the REAL PgFlagStore SQL (upsert / read / delete) through the
    /// admin API. Self-skips without DATABASE_URL, like the other pg tests.
    /// Feature keys are global (no run-unique ids possible), so the test always
    /// restores the default by clearing the override it set.
    #[tokio::test]
    async fn pg_feature_override_round_trip() {
        dotenv().ok();
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("pg_feature_override_round_trip: skipped (DATABASE_URL not set)");
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
        let (app, _mails) = pg_app(pool);
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        // Set an override, twice (second write exercises the upsert path).
        for _ in 0..2 {
            let (st, row) = post_json_h(
                &app,
                "/api/admin/features/payments_mock",
                json!({ "enabled": false }),
                &admin,
            )
            .await;
            assert_eq!(st, StatusCode::OK);
            assert_eq!(row["override"], json!(false));
            assert_eq!(row["effective"], json!(false));
        }
        let (st, v) = get_json_h(&app, "/api/admin/features", &admin).await;
        assert_eq!(st, StatusCode::OK);
        let row = v
            .as_array()
            .expect("list")
            .iter()
            .find(|r| r["key"] == "payments_mock")
            .expect("payments_mock row");
        assert_eq!(row["override"], json!(false));

        // Clear: the row is deleted and the default applies again.
        let (st, row) = post_json_h(
            &app,
            "/api/admin/features/payments_mock",
            json!({ "enabled": null }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(row["override"], Value::Null);
        assert_eq!(row["effective"], json!(true));
    }
}
