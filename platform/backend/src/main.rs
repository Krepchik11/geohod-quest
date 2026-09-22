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
    http::{StatusCode, header},
};
use dotenvy::dotenv;

use tokio::net::TcpListener;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod admin_stats;
mod auth;
mod authz;
mod backfill;
mod config;
mod coupons;
mod errors;
mod export;
mod facts;
mod features;
mod grants;
mod handlers;
mod icons;
mod mailer;
mod media;
mod payments;
mod pg_store;
mod settings;
mod snapshot;
mod social;
mod store;
mod yookassa;

use std::sync::{Arc, Mutex};

use config::AppConfig;
use media::MediaStores;
use store::{
    AuthStores, ConstructorStores, CouponStores, FactStores, FlagStores, GrantStores,
    ModerationStores, PaymentStores, SettingsStores, Storage,
};
use yookassa::YookassaGateway;

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub store: FactStores,
    pub grants: GrantStores,
    pub auth: AuthStores,
    /// Authoring-side quest registry (drafts + lifecycle) behind the constructor.
    pub constructor: ConstructorStores,
    /// Admin-managed discount codes + their redemption log (coupons spec).
    pub coupons: CouponStores,
    /// Content-addressed media blobs (Cloudflare R2 in prod; in-process otherwise).
    pub media: MediaStores,
    /// In-flight redirect payments (YooKassa): checkout writes, settlement flips.
    pub payment_rows: PaymentStores,
    /// Admin-set feature-toggle overrides (registry in `features.rs`; evaluation
    /// in [`feature_enabled`] — code default unless overridden).
    pub flags: FlagStores,
    /// Admin-set runtime string settings (registry in `settings.rs`; no row =
    /// unset — settings have no compiled-in default values).
    pub settings: SettingsStores,
    /// Mutable moderation overlay (content-moderation) — hidden reviews +
    /// feedback resolution watermarks, kept entirely separate from the immutable
    /// fact log. Admin-only reads/writes; the read-side folds consult it.
    pub moderation: ModerationStores,
    /// YooKassa transport. `None` (credentials unset) → `provider=yookassa` is
    /// disabled (501, fail-closed); tests inject the scripted fake.
    pub yookassa: Option<YookassaGateway>,
    /// Transactional mail (§6.2/§6.3) — SMTP in prod, log fallback, recorder in tests.
    pub mailer: mailer::Mailer,
    /// Fixed-window rate limiter for abusable auth endpoints (§6.1 identify,
    /// §6.2 recover, §6.3 resend). Keyed by `"<scope>:<email>"`; the value is
    /// `(resets_at, count)`. See [`fixed_window_allow`].
    pub rate_limiter: Arc<Mutex<std::collections::HashMap<String, (u64, u32)>>>,
    /// Google ID-token verifier (holds the cached JWKS). `Some` only when
    /// `GOOGLE_CLIENT_ID` is configured; `None` disables `/api/auth/google` (501).
    pub google: Option<Arc<social::OidcVerifier>>,
    /// Telegram OIDC ID-token verifier (holds the cached JWKS). `Some` only when
    /// `TELEGRAM_CLIENT_ID` is configured; `None` disables `/api/auth/telegram` (501).
    pub telegram: Option<Arc<social::OidcVerifier>>,
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

/// Assemble the shared state from a backing [`Storage`] — the ONE place every
/// field is wired, so the in-memory and Postgres branches cannot drift.
fn app_state(config: AppConfig, media: MediaStores, storage: Storage) -> AppState {
    let mailer = mailer::Mailer::from_config(config.smtp_url.as_deref(), &config.mail_from);
    let google = build_google_verifier(&config);
    let telegram = build_telegram_verifier(&config);
    let yookassa = config.yookassa.clone().map(YookassaGateway::Http);
    AppState {
        config,
        store: storage.facts,
        grants: storage.grants,
        auth: storage.auth,
        constructor: storage.constructor,
        coupons: storage.coupons,
        media,
        payment_rows: storage.payments,
        flags: storage.flags,
        settings: storage.settings,
        moderation: storage.moderation,
        yookassa,
        mailer,
        rate_limiter: Arc::new(Mutex::new(std::collections::HashMap::new())),
        google,
        telegram,
    }
}

/// Build the application router (extracted for oneshot testing).
fn build_router(state: AppState) -> Router {
    Router::new()
        .merge(handlers::player::router())
        .merge(handlers::media::router())
        .merge(handlers::constructor::router())
        .merge(handlers::payments::router())
        .merge(handlers::admin::router())
        .merge(handlers::auth::router())
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
/// `X-User-Id` headers, not cookies, so there is no ambient credential to ride.
fn build_cors_layer(allowed: &[String]) -> CorsLayer {
    use axum::http::{HeaderName, Method};
    use tower_http::cors::AllowOrigin;

    let methods = [Method::GET, Method::POST, Method::OPTIONS];
    let headers = [
        header::CONTENT_TYPE,
        header::AUTHORIZATION,
        HeaderName::from_static("x-user-id"),
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
            app_state(config.clone(), media, Storage::postgres(pool))
        }
        Err(_) => {
            tracing::warn!(
                "DATABASE_URL not set — using in-memory storage; ALL DATA IS LOST ON RESTART"
            );
            app_state(config.clone(), media, Storage::in_memory())
        }
    };

    tracing::info!(addr = %config.addr, build_id = %config.build_id, "starting geohod-backend");

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
    use crate::handlers::auth::MAIL_SEND_LIMIT;
    use crate::store::{ConstructorQuest, PublishedMeta};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use facts::{Fact, FactKind};
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    /// The committed wire contract (frontend/lib/generated/) must equal what
    /// the serde structs export TODAY — a backend change that alters the wire
    /// fails here unless the regenerated types land in the same commit
    /// (issue #66). This test is ALSO the generator — regenerate with:
    ///   UPDATE_WIRE=1 cargo test wire_bindings_are_committed
    #[test]
    fn wire_bindings_are_committed() {
        use ts_rs::TS;
        let update = std::env::var("UPDATE_WIRE").is_ok();
        let committed = std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../frontend/lib/generated"
        ));
        let tmp = if update {
            let _ = std::fs::remove_dir_all(&committed);
            committed.clone()
        } else {
            std::env::temp_dir().join(format!("geohod-wire-{}", std::process::id()))
        };
        let _ = std::fs::remove_dir_all(&tmp);
        macro_rules! export_all {
            ($($t:ty),* $(,)?) => { $(<$t as TS>::export_all_to(&tmp).expect("export");)* }
        }
        export_all!(
            payments::CheckoutResponse,
            handlers::payments::PaymentStatusResponse,
            handlers::payments::CouponVerdict,
            snapshot::StartPointWire,
            handlers::constructor::ConstructorQuestWire,
            handlers::constructor::ConstructorQuestFullWire,
            handlers::constructor::ConstructorAuthorWire,
            snapshot::ThemeWire,
            handlers::player::BundleWire,
            handlers::player::QuestBonusesWire,
            handlers::player::CatalogQuest,
            handlers::player::ProductPageWire,
            handlers::player::ReviewWire,
            handlers::player::ReviewsPageWire,
            handlers::admin::AdminIdentityWire,
            handlers::admin::AdminReviewWire,
            handlers::admin::AdminReviewsResponse,
            handlers::admin::ReviewHideRequest,
            handlers::admin::AdminReportWire,
            handlers::admin::AdminFeedbackGroupWire,
            handlers::admin::AdminFeedbackResponse,
            handlers::admin::FeedbackResolveRequest,
            handlers::auth::AuthProviders,
            handlers::auth::Me,
            handlers::admin::AdminUserWire,
            handlers::admin::FeatureWire,
            handlers::player::PublicFeaturesResponse,
            handlers::admin::SettingWire,
            handlers::admin::CouponPayload,
            handlers::admin::AdminCouponWire,
            store::AttemptMeta,
            facts::PlayerStats,
            crate::grants::AccessGrant,
            crate::media::MediaRef,
            admin_stats::StatsTotals,
            admin_stats::DailyPoint,
            admin_stats::QuestStatsRow,
            admin_stats::OverviewResponse,
            admin_stats::FunnelStep,
            admin_stats::QuestStatsResponse,
        );
        let list = |dir: &std::path::Path| -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(dir)
                .expect("read dir")
                .map(|e| e.expect("entry").file_name().into_string().expect("utf8"))
                .filter(|n| n.ends_with(".ts") && n != "index.ts")
                .collect();
            names.sort();
            names
        };
        let fresh = list(&tmp);
        let index: String = fresh
            .iter()
            .map(|n| {
                let t = n.trim_end_matches(".ts");
                format!("export type {{ {t} }} from './{t}';\n")
            })
            .collect();
        if update {
            std::fs::write(committed.join("index.ts"), index).expect("write index.ts");
            return;
        }
        assert_eq!(
            fresh,
            list(&committed),
            "generated type set drifted — rerun with UPDATE_WIRE=1"
        );
        for name in &fresh {
            let a = std::fs::read_to_string(tmp.join(name)).expect("fresh");
            let b = std::fs::read_to_string(committed.join(name)).expect("committed");
            assert_eq!(a, b, "{name} drifted — rerun with UPDATE_WIRE=1");
        }
        let committed_index =
            std::fs::read_to_string(committed.join("index.ts")).expect("index.ts");
        assert_eq!(
            committed_index, index,
            "index.ts drifted — rerun with UPDATE_WIRE=1"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Admin secret wired into the test app so admin-gated scenarios can
    /// authenticate (and assert that the wrong/absent token is rejected).
    const TEST_ADMIN_TOKEN: &str = "test-admin-secret";

    /// In-process media config for tests (uploads served via `/api/media/{hash}`).
    fn test_media_cfg() -> config::MediaConfig {
        config::MediaConfig::Local {
            public_base: "http://test.local/api/media".to_string(),
        }
    }

    /// The features a flow test needs switched on. Every flag ships OFF
    /// (`features::Feature::default_enabled`) and nothing seeds overrides, so a
    /// test that exercises a gated flow must enable its feature — exactly as a
    /// real deployment's admin does after first boot. Declaring that here, once,
    /// is why no test depends on seeded data.
    const TEST_ENABLED_FLAGS: [features::Feature; 4] = [
        features::Feature::AuthGoogle,
        features::Feature::AuthTelegram,
        features::Feature::PaymentsMock,
        features::Feature::PaymentsYookassa,
    ];

    /// Captured outbox of the recorder mailer (§6 flows read the mailed token).
    type Outbox = std::sync::Arc<Mutex<Vec<mailer::OutgoingMail>>>;

    /// The one in-memory test scaffold — every knob the old per-scenario helpers
    /// hardcoded is a field, and [`TestApp::build`] is the single shared body.
    struct TestApp {
        /// Admin secret configured ([`TEST_ADMIN_TOKEN`]); off => admin surfaces
        /// must fail closed.
        admin_token: bool,
        /// Seed [`TEST_ENABLED_FLAGS`]; off => a deployment that has never been
        /// configured, so every flag reads its code default.
        seeded_flags: bool,
        /// Swap in the recorder mailer and hand back the outbox.
        mail_recorder: bool,
    }

    impl Default for TestApp {
        fn default() -> Self {
            Self {
                admin_token: true,
                seeded_flags: true,
                mail_recorder: false,
            }
        }
    }

    impl TestApp {
        /// Build the `AppState` under the given config — the media store comes
        /// from the config, mirroring how `main()` builds it once and injects it.
        /// Exposed separately for tests that also drive the stores directly.
        fn state_with(self, mut config: AppConfig) -> (AppState, Option<Outbox>) {
            if !self.admin_token {
                config.admin_token = None;
            }
            let media = MediaStores::from_config(&config.media).expect("test media store");
            let mut state = app_state(config, media, Storage::in_memory());
            if self.seeded_flags {
                let mut flags = store::InMemoryFlagStore::new();
                for f in TEST_ENABLED_FLAGS {
                    flags.set(f.key(), true);
                }
                state.flags = Arc::new(Mutex::new(flags));
            }
            let outbox = self.mail_recorder.then(|| {
                let (m, outbox) = mailer::Mailer::recorder();
                state.mailer = m;
                outbox
            });
            (state, outbox)
        }

        fn build(self) -> (Router, Option<Outbox>) {
            let (state, outbox) = self.state_with(test_config());
            (build_router(state), outbox)
        }
    }

    /// The shared test config (admin secret set) — helpers tweak fields off it.
    fn test_config() -> AppConfig {
        AppConfig {
            addr: "0.0.0.0:0".parse().expect("test addr"),
            build_id: "test-build".to_string(),
            admin_token: Some(TEST_ADMIN_TOKEN.to_string()),
            cors_allowed_origins: Vec::new(),
            media: test_media_cfg(),
            smtp_url: None,
            mail_from: "test@geohod.test".to_string(),
            frontend_base: "http://localhost:3000".to_string(),
            google_client_id: None,
            telegram_client_id: None,
            yookassa: None,
        }
    }

    /// Router with the [`TestApp`] defaults — the common case.
    fn test_app() -> Router {
        TestApp::default().build().0
    }

    /// State with the flag baseline on — for tests that drive stores directly.
    fn test_state(config: AppConfig) -> AppState {
        TestApp::default().state_with(config).0
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
        let mut config = test_config();
        config.admin_token = None;
        config.cors_allowed_origins = vec!["https://app.geohod.ru".to_string()];
        let app = build_router(test_state(config));

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
        let app = TestApp {
            admin_token: false,
            ..TestApp::default()
        }
        .build()
        .0;
        // Even with a token header, an unset ADMIN_TOKEN disables the surface.
        let (st, _) = get_json_h(
            &app,
            "/api/admin/versions/whatever/stats",
            &[("x-admin-token", "anything")],
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        for path in ["/api/migrate/legacy", "/api/migrate/media"] {
            let (st, _) =
                post_json_h(&app, path, json!({}), &[("x-admin-token", "anything")]).await;
            assert_eq!(st, StatusCode::FORBIDDEN, "{path}");
        }
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
    /// State with the Telegram verifier seeded (offline JWKS). Returned (not just a
    /// Router) so a test can also inspect the shared Arc<Mutex> stores after driving
    /// the handler — e.g. read back a persisted identity handle.
    fn social_state() -> AppState {
        let mut config = test_config();
        config.telegram_client_id = Some(social::test_support::TELEGRAM_CLIENT_ID.to_string());
        let mut state = test_state(config);
        state.telegram = Some(Arc::new(social::test_support::seeded_telegram_verifier()));
        state
    }

    fn test_app_social() -> Router {
        build_router(social_state())
    }

    /// A `/api/auth/telegram` request body: a locally-signed OIDC id_token (name is
    /// the profile display name) plus the caller's claimed user_id.
    fn tg_payload(user_id: &str, id: i64, name: &str) -> Value {
        json!({
            "user_id": user_id,
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
            json!({ "credential": "x.y.z", "user_id": "dev:x" }),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_IMPLEMENTED);
    }

    #[tokio::test]
    async fn telegram_invalid_token_is_rejected() {
        // A structurally-broken / unsigned token never verifies against the JWKS.
        let app = test_app_social();
        let payload = json!({ "user_id": "dev:a", "id_token": "not.a.valid.jwt" });
        let (st, _) = post_json(&app, "/api/auth/telegram", payload).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn telegram_expired_token_is_rejected() {
        // A correctly-signed token whose exp has passed is rejected (replay window).
        let app = test_app_social();
        let payload = json!({
            "user_id": "dev:a",
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
        assert_eq!(body["user_id"], "dev:keep-me");
        assert!(body["email"].is_null(), "telegram account has no email");
        assert_eq!(body["display_name"], "Ann");
        let token = body["token"].as_str().expect("token");

        // /me reports the telegram method and no email.
        let (st, me) = get_json_h(
            &app,
            "/api/users/me",
            &[("authorization", &format!("Bearer {token}"))],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["registered"], true);
        assert!(me["email"].is_null());
        let methods: Vec<String> = serde_json::from_value(me["methods"].clone()).expect("methods");
        assert_eq!(methods, vec!["telegram".to_string()]);
        assert_eq!(
            me["needs_email_confirmation"], false,
            "no email — nothing to confirm, no banner"
        );
    }

    /// §6.3 — the confirm-email banner verdict is the SERVER's, like can_unlink:
    /// pending only while an email exists and is unconfirmed.
    #[tokio::test]
    async fn me_reports_needs_email_confirmation() {
        let (state, _) = TestApp::default().state_with(test_config());
        let app = build_router(state.clone());
        let (_, token) = register(&app, "dev:nec").await;
        let bearer = format!("Bearer {token}");
        let (_, me) = get_json_h(&app, "/api/users/me", &[("authorization", &bearer)]).await;
        assert_eq!(me["needs_email_confirmation"], true, "email unconfirmed");
        state
            .auth
            .confirm_email("dev:nec", 42)
            .await
            .expect("confirm");
        let (_, me) = get_json_h(&app, "/api/users/me", &[("authorization", &bearer)]).await;
        assert_eq!(me["needs_email_confirmation"], false, "confirmed");
        let (_, me) = get_json_h(&app, "/api/users/me", &[("x-user-id", "dev:anon-nec")]).await;
        assert_eq!(me["needs_email_confirmation"], false, "anonymous");
    }

    /// A Google-created account carries a verified email but NO password: the
    /// email is contact data, not a working sign-in method — `methods` must not
    /// claim "email" until a password is actually set.
    #[tokio::test]
    async fn email_without_password_is_not_a_sign_in_method() {
        let state = social_state();
        let app = build_router(state.clone());
        state
            .auth
            .create_social_account("dev:g", Some("g@x.io".into()), Some("G".into()), Some(1))
            .await
            .expect("social account");
        state
            .auth
            .create_identity(store::AuthIdentity {
                method: auth::PROVIDER_GOOGLE.into(),
                identifier: "sub-g".into(),
                user_id: "dev:g".into(),
                handle: None,
                created_at: 1,
            })
            .await
            .expect("identity");
        state
            .auth
            .create_session("tok-g", "dev:g")
            .await
            .expect("session");
        let (st, me) =
            get_json_h(&app, "/api/users/me", &[("authorization", "Bearer tok-g")]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["email"], "g@x.io", "contact email still reported");
        let methods: Vec<String> = serde_json::from_value(me["methods"].clone()).expect("methods");
        assert_eq!(
            methods,
            vec!["google".to_string()],
            "no phantom email method"
        );
        // Reachable two ways (google + recoverable email) → unlink allowed.
        assert_eq!(me["can_unlink"], true, "server serves the unlink verdict");
    }

    #[tokio::test]
    async fn telegram_handle_is_captured_and_refreshed() {
        let state = social_state();
        let app = build_router(state.clone());

        // 1. Sign in with a @username → it is captured on the identity.
        let (st, body) = post_json(
            &app,
            "/api/auth/telegram",
            json!({
                "user_id": "dev:tg-user",
                "id_token": social::test_support::telegram_id_token(900, "Milan", Some("milan_bg"), 3600),
            }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let pid = body["user_id"].as_str().expect("user_id").to_string();
        let ids = state
            .auth
            .identities_for_user(&pid)
            .await
            .expect("identities");
        assert_eq!(ids.len(), 1);
        assert_eq!(ids[0].handle.as_deref(), Some("milan_bg"));

        // 2. Re-sign-in with a CHANGED handle → the stored handle is refreshed.
        let (st, _) = post_json(
            &app,
            "/api/auth/telegram",
            json!({
                "user_id": "dev:tg-user",
                "id_token": social::test_support::telegram_id_token(900, "Milan", Some("milan_new"), 3600),
            }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let ids = state.auth.identities_for_user(&pid).await.expect("ids");
        assert_eq!(
            ids[0].handle.as_deref(),
            Some("milan_new"),
            "a changed handle overwrites the stored one"
        );

        // 3. Re-sign-in with NO handle → the prior value is left untouched.
        let (st, _) = post_json(
            &app,
            "/api/auth/telegram",
            json!({
                "user_id": "dev:tg-user",
                "id_token": social::test_support::telegram_id_token(900, "Milan", None, 3600),
            }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let ids = state.auth.identities_for_user(&pid).await.expect("ids");
        assert_eq!(
            ids[0].handle.as_deref(),
            Some("milan_new"),
            "an absent claim leaves the prior value untouched"
        );
    }

    #[tokio::test]
    async fn telegram_handleless_user_has_no_handle() {
        let state = social_state();
        let app = build_router(state.clone());
        let (st, body) = post_json(
            &app,
            "/api/auth/telegram",
            json!({
                "user_id": "dev:no-handle",
                "id_token": social::test_support::telegram_id_token(901, "Guest", None, 3600),
            }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let pid = body["user_id"].as_str().expect("user_id").to_string();
        let ids = state.auth.identities_for_user(&pid).await.expect("ids");
        assert_eq!(ids.len(), 1);
        assert_eq!(ids[0].handle, None, "no handle → no stored handle");
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
        assert_eq!(first["user_id"], "dev:one");
        // A different anonymous device signs in with the SAME telegram id.
        let (st, second) = post_json(
            &app,
            "/api/auth/telegram",
            tg_payload("dev:two", 900, "Ann"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        // It resolves to the existing account, not a new one on dev:two.
        assert_eq!(second["user_id"], "dev:one");
    }

    #[tokio::test]
    async fn telegram_links_to_logged_in_email_account_and_unlink_guards_last_method() {
        let app = test_app_social();
        // Register an email account.
        let (st, reg) = post_json(
            &app,
            "/api/auth/register",
            json!({ "user_id": "dev:acct", "email": "u@example.com", "password": "supersecret" }),
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
        assert_eq!(linked["user_id"], "dev:acct"); // same account
        assert_eq!(linked["email"], "u@example.com");

        // /me lists BOTH methods now.
        let (_, me) = get_json_h(&app, "/api/users/me", &[("authorization", &bearer)]).await;
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
        assert_eq!(elsewhere["user_id"], "dev:acct");

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
    async fn linking_identity_bound_to_another_account_is_a_conflict_not_a_switch() {
        let app = test_app_social();
        // Account A: telegram-only, created from an anonymous device.
        let (_, a) = post_json(&app, "/api/auth/telegram", tg_payload("dev:a", 555, "Ann")).await;
        assert_eq!(a["user_id"], "dev:a");

        // Account B: email-registered and logged in.
        let (_, reg) = post_json(
            &app,
            "/api/auth/register",
            json!({ "user_id": "dev:b", "email": "b@example.com", "password": "supersecret" }),
        )
        .await;
        let bearer = format!("Bearer {}", reg["token"].as_str().expect("token"));

        // B tries to add the SAME telegram id from the profile. It must NOT
        // silently switch B's session to account A — that reads as "bound" in
        // the UI while B's account gains nothing.
        let (st, body) = post_json_h(
            &app,
            "/api/auth/telegram",
            tg_payload("dev:b", 555, "Ann"),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT, "got: {body}");

        // B's methods are unchanged (email only) — nothing was moved or lost.
        let (_, me) = get_json_h(&app, "/api/users/me", &[("authorization", &bearer)]).await;
        let methods: Vec<String> = serde_json::from_value(me["methods"].clone()).expect("methods");
        assert_eq!(methods, vec!["email".to_string()]);

        // A still logs in with telegram.
        let (st, again) =
            post_json(&app, "/api/auth/telegram", tg_payload("dev:c", 555, "Ann")).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(again["user_id"], "dev:a");
    }

    #[tokio::test]
    async fn relinking_own_identity_while_logged_in_is_idempotent() {
        let app = test_app_social();
        let (_, acct) =
            post_json(&app, "/api/auth/telegram", tg_payload("dev:me", 888, "Me")).await;
        let bearer = format!("Bearer {}", acct["token"].as_str().expect("token"));
        let (st, body) = post_json_h(
            &app,
            "/api/auth/telegram",
            tg_payload("dev:me", 888, "Me"),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["user_id"], "dev:me");
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
            json!({"user_id": id, "email": email, "password": "hunter2hunter2"}),
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
    /// role-gated by [`require_editor_actor`].
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
            json!({"user_id": ids.player, "quest_id": ids.quest, "coupon_code": null}),
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
            json!({"user_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        meta["attempt_id"].as_str().expect("attempt id").to_string()
    }

    // === Shared scenarios: executed against the in-memory backend below and the
    // === Postgres backend via the `scenarios!` list (same behavior on both —
    // === persistence spec). One row there registers a scenario for BOTH backends.

    async fn scenario_attempt_gating(app: &Router, ids: &Ids) {
        let (st, body) = post_json(
            app,
            "/api/attempts",
            json!({"user_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        assert!(body["error"].as_str().expect("error").contains("grant"));

        let _ = post_json(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        let (st, _) = post_json(
            app,
            "/api/attempts",
            json!({"user_id": ids.player, "quest_id": ids.quest}),
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

    /// §11 rating rewards: 5 coins for the stars, 5 for the comment — each at
    /// most once EVER per (player, quest), enforced at append time like the
    /// completion bonus, so a replayed quest can't farm them.
    async fn scenario_rating_rewards(app: &Router, ids: &Ids) {
        let attempt1 = grant_publish_attempt(app, ids).await;
        let rate_facts = |stars: &str, note: Option<&str>| {
            json!({ "facts": [
                { "type": "quest_rated", "step_position": 0, "submitted_value": stars,
                  "local_is_correct": true, "coins_delta": 0, "note": note, "device_id": "d1" },
                { "type": "rating_bonus", "step_position": 0, "submitted_value": null,
                  "local_is_correct": true, "coins_delta": 5, "note": null, "device_id": "d1" },
                { "type": "comment_bonus", "step_position": 0, "submitted_value": null,
                  "local_is_correct": true, "coins_delta": 5, "note": null, "device_id": "d1" }
            ]})
        };
        let (st, v) = post_json(
            app,
            &format!("/api/attempts/{attempt1}/facts"),
            rate_facts("5", Some("Класс!")),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "bonuses accepted: {v}");
        assert_eq!(v["accepted"].as_array().expect("accepted").len(), 3);
        assert_eq!(v["projected"]["balance"], 10);

        // Replay: the same bonuses on a fresh attempt are absorbed server-side.
        let (st, att) = post_json(
            app,
            "/api/attempts",
            json!({ "user_id": ids.player, "quest_id": ids.quest }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let attempt2 = att["attempt_id"].as_str().expect("attempt id").to_string();
        let (st, v) = post_json(
            app,
            &format!("/api/attempts/{attempt2}/facts"),
            rate_facts("4", None),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            v["accepted"].as_array().expect("accepted").len(),
            1,
            "only the re-rate lands, the bonuses are once-ever: {v}"
        );
        assert_eq!(v["projected"]["balance"], 0, "no coins on the replay");

        // The cross-attempt fold pays each bonus exactly once.
        let (st, s) = get_json_h(
            app,
            "/api/users/me/stats",
            &[("x-user-id", ids.player.as_str())],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(s["balance"], 10);
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
            json!({"user_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        let second = meta2["attempt_id"].as_str().expect("attempt id");
        let (_, v2) = post_json(app, &format!("/api/attempts/{second}/facts"), bonus).await;
        assert_eq!(
            v2["accepted"].as_array().expect("accepted").len(),
            0,
            "bonus is once per (player, quest), ever"
        );

        // The same answer, told to the client BEFORE it plays: a device that
        // never saw this quest has nothing of its own to read (issue #117).
        let (st, paid) = get_json_h(
            app,
            &format!("/api/quests/{}/bonuses", ids.quest),
            &[("x-user-id", ids.player.as_str())],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(paid["kinds"], json!(["completion_bonus"]));

        let (_, none) = get_json_h(
            app,
            &format!("/api/quests/{}-never-played/bonuses", ids.quest),
            &[("x-user-id", ids.player.as_str())],
        )
        .await;
        assert_eq!(
            none["kinds"],
            json!([]),
            "a quest paid nothing names nothing"
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

    /// «Прохождения» counts distinct FINISHERS, and one finisher earns up to
    /// three once-ever bonuses (§11: completion, rating, review). The Postgres
    /// backend reads them out of `bonus_awards`, where each is its own row since
    /// migration 0005 — counting rows would report one player as three.
    async fn scenario_completions_count_distinct_finishers(app: &Router, ids: &Ids) {
        let attempt = grant_publish_attempt(app, ids).await;
        let (st, v) = post_json(
            app,
            &format!("/api/attempts/{attempt}/facts"),
            json!({"facts": [
                fact_json(FactKind::CompletionBonus, 3, 5, "device-a"),
                fact_json(FactKind::RatingBonus, 3, 5, "device-a"),
                fact_json(FactKind::CommentBonus, 3, 5, "device-a"),
            ]}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["accepted"].as_array().expect("accepted").len(), 3);

        let (_, list) = get_json(app, "/api/quests").await;
        let card = list
            .as_array()
            .expect("array")
            .iter()
            .find(|q| q["quest_id"] == ids.quest)
            .expect("quest in store");
        assert_eq!(card["players"], 1, "one player finished it, not three");

        let (_, prod) = get_json(app, &format!("/api/quests/{}", ids.quest)).await;
        assert_eq!(prod["players"], 1, "the product page counts the same way");
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
            json!({"user_id": ids.player, "quest_id": ids.quest}),
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
            json!({"user_id": ids.player, "quest_id": ids.quest, "coupon_code": null}),
        )
        .await;
        assert_eq!(v1["created"], true);
        assert_eq!(v1["grant"]["source"], "Payment");

        // Re-checkout of an owned quest is idempotent and never consumes a
        // coupon — the code is not even looked up.
        let (_, v2) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": ids.quest, "coupon_code": "GHOST-1"}),
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
            json!({"user_id": ids.player, "quest_id": other_quest,
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
        // A direct/legacy publish has no constructor row, so no attributes: the
        // catalog reports them honestly as unknown instead of fabricating defaults.
        assert_eq!(row["complexity"], serde_json::Value::Null);
        assert_eq!(row["age_target"], serde_json::Value::Null);
        assert_eq!(row["tags"], json!([]));

        // /api/grants is caller-scoped: anonymous callers must claim an id, and
        // the response contains ONLY that player's grants (no cross-player leak).
        let (st, _) = get_json(app, "/api/grants").await;
        assert_eq!(st, StatusCode::UNAUTHORIZED, "grants require an identity");

        let (_, grants) = get_json_h(app, "/api/grants", &[("x-user-id", &ids.player)]).await;
        let grants = grants.as_array().expect("grants");
        assert!(
            grants
                .iter()
                .any(|g| g["user_id"] == ids.player.as_str() && g["source"] == "Payment")
        );
        assert!(
            grants.iter().all(|g| g["user_id"] == ids.player.as_str()),
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
                "complexity": "high", "age_target": "kids", "tags": ["логика", "город"],
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

        // The catalog row exposes the author's attributes (store-page filters).
        let (_, list) = get_json(app, "/api/quests").await;
        let item = list
            .as_array()
            .expect("array")
            .iter()
            .find(|q| q["quest_id"] == ids.quest.as_str())
            .expect("listed quest")
            .clone();
        assert_eq!(item["complexity"], "high");
        assert_eq!(item["age_target"], "kids");
        assert_eq!(item["tags"], json!(["логика", "город"]));

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
            &format!("/api/quests/{}/bundle?user_id={}", ids.quest, ids.player),
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
            &format!("/api/quests/{}/bundle?user_id={}", ids.quest, ids.player),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        assert!(body.get("snapshot").is_none());

        // After checkout -> full frozen snapshot JSON.
        let (_, _) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        let (st, body) = get_json(
            app,
            &format!("/api/quests/{}/bundle?user_id={}", ids.quest, ids.player),
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

        // This quest was published WITHOUT snapshot content, so its snapshot row
        // carries no data. The inbox must degrade to "labels unknown", not fail:
        // a stored NULL and a missing row are the same absence, and both storage
        // backends have to answer it the same way.
        let (st, v) = get_json_h(app, "/api/admin/feedback", &admin).await;
        assert_eq!(st, StatusCode::OK, "content-less snapshot: {v}");
        let group = v["groups"]
            .as_array()
            .expect("groups")
            .iter()
            .find(|g| g["quest_id"] == ids.quest.as_str())
            .expect("the reported quest is grouped");
        assert_eq!(group["version"], Value::Null);
        assert_eq!(group["step_title"], Value::Null);
        assert_eq!(group["current"], json!(true), "v1 is the live version");
    }

    /// The back office names a quest from the AUTHORING registry, so the label
    /// survives a rename and does not depend on the catalog at all. Runs on both
    /// backends because the city is projected out of the authoring body — in Rust
    /// in-memory, in SQL on Postgres — and the two must not drift.
    async fn scenario_admin_quest_labels(app: &Router, ids: &Ids) {
        let bearer = editor_bearer(app, &ids.player).await;
        let h = [("authorization", bearer.as_str())];
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let quest = ids.quest.as_str();

        // Authored under one name, published under another (the frozen store card),
        // then renamed in the constructor — the state a rename-after-publish leaves.
        let (st, _) = post_json_h(
            app,
            "/api/constructor/quests",
            json!({
                "quest_id": quest,
                "name": "Рабочее имя",
                "steps_count": 1,
                "body": { "id": quest, "meta": { "title": "Рабочее имя", "city": "  Нови Сад  " } }
            }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = publish(
            app,
            ids,
            json!({
                "quest_id": quest, "name": "Витринное имя", "template_summary": "1 step",
                "snapshot_version": 1, "snapshot_id": ids.snap1, "city": "Казань",
                "snapshot": { "steps": [{ "template": "start" }] }
            }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Buy, play, rate and report — the fact log the admin surfaces fold.
        let (st, _) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, meta) = post_json(
            app,
            "/api/attempts",
            json!({"user_id": ids.player, "quest_id": quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let attempt = meta["attempt_id"].as_str().expect("attempt id");
        let (st, _) = post_json(
            app,
            &format!("/api/attempts/{attempt}/facts"),
            json!({"facts": [
                {"type": "quest_rated", "step_position": 0, "submitted_value": "2",
                 "local_is_correct": true, "coins_delta": 0, "note": "спорно", "device_id": "d"},
                {"type": "feedback_reported", "step_position": 0, "submitted_value": null,
                 "local_is_correct": true, "coins_delta": 0, "note": "шаг сломан", "device_id": "d"}
            ]}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        let (st, _) = post_json_h(
            app,
            &format!("/api/constructor/quests/{quest}/save"),
            json!({
                "name": "Финальное имя",
                "steps_count": 1,
                "body": { "id": quest, "meta": { "title": "Финальное имя", "city": " Белград " } }
            }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Every admin surface reports the live authored label, trimmed.
        let (_, v) = get_json_h(app, "/api/admin/reviews", &admin).await;
        let review = v["reviews"]
            .as_array()
            .expect("reviews")
            .iter()
            .find(|r| r["quest_id"] == quest)
            .expect("the rated quest is listed");
        assert_eq!(review["quest_name"], json!("Финальное имя"));
        assert_eq!(review["quest_city"], json!("Белград"));

        let (st, v) = get_json_h(app, "/api/admin/feedback", &admin).await;
        assert_eq!(st, StatusCode::OK, "feedback list: {v}");
        let group = v["groups"]
            .as_array()
            .expect("groups")
            .iter()
            .find(|g| g["quest_id"] == quest)
            .expect("the reported quest is listed");
        assert_eq!(group["quest_name"], json!("Финальное имя"));
        assert_eq!(group["quest_city"], json!("Белград"));

        let (_, v) = get_json_h(app, "/api/admin/stats", &admin).await;
        let row = v["quests"]
            .as_array()
            .expect("quests")
            .iter()
            .find(|r| r["quest_id"] == quest)
            .expect("the played quest has a row");
        assert_eq!(row["name"], json!("Финальное имя"));
        assert_eq!(row["city"], json!("Белград"));

        let (st, v) = get_json_h(app, &format!("/api/admin/stats/{quest}"), &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["name"], json!("Финальное имя"), "drill-down agrees");
        assert_eq!(v["city"], json!("Белград"));

        // The public store card is untouched: it is the frozen published version.
        let (st, product) = get_json(app, &format!("/api/quests/{quest}")).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(product["name"], json!("Витринное имя"));
        assert_eq!(product["city"], json!("Казань"));
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
            json!({"user_id": player, "email": email, "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["user_id"], player, "registration keeps the player id");
        let token = v["token"].as_str().expect("token").to_string();
        assert_eq!(token.len(), 64);
        (email, token)
    }

    async fn scenario_auth_register_login(app: &Router, ids: &Ids) {
        // Anonymous purchase BEFORE registration — must survive it.
        let (st, _) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        let (email, token) = register(app, &ids.player).await;

        // Garbage credentials are rejected up front.
        let (st, _) = post_json(
            app,
            "/api/auth/register",
            json!({"user_id": "p-x", "email": "no-at-sign", "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _) = post_json(
            app,
            "/api/auth/register",
            json!({"user_id": "p-x", "email": "x@example.com", "password": "short"}),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        // Duplicate email (another player) and re-registration: 409, no partial state.
        let (st, _) = post_json(
            app,
            "/api/auth/register",
            json!({"user_id": format!("{}-other", ids.player), "email": email,
                   "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);
        let (st, _) = post_json(
            app,
            "/api/auth/register",
            json!({"user_id": ids.player, "email": format!("second-{email}"),
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
            json!({"user_id": format!("{}-case", ids.player),
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
        assert_eq!(v["user_id"], ids.player.as_str());
        let login_token = v["token"].as_str().expect("token").to_string();
        assert_ne!(login_token, token, "each login mints a fresh session");
        let (st, v) = post_json(
            app,
            "/api/auth/login",
            json!({"email": email.to_uppercase(), "password": "hunter2hunter2"}),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "login is email-case-insensitive");
        assert_eq!(v["user_id"], ids.player.as_str());
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
            json!({"user_id": ids.player, "quest_id": ids.quest}),
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
            json!({"user_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Anonymous profile via X-User-Id.
        let (st, me) = get_json_h(app, "/api/users/me", &[("x-user-id", &ids.player)]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["registered"], false);
        assert_eq!(me["user_id"], ids.player.as_str());

        let (_, token) = register(app, &ids.player).await;
        let bearer = format!("Bearer {token}");

        // After registration: tokenless claims of this id are 401 everywhere scoped.
        let (st, _) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": "another-quest"}),
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
            json!({"user_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        let (st, _) = get_json_h(app, "/api/users/me/stats", &[("x-user-id", &ids.player)]).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        let (st, _) = get_json(
            app,
            &format!("/api/quests/{}/bundle?user_id={}", ids.quest, ids.player),
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        // With the session, the same requests pass identity (then normal gating).
        let (st, me) = get_json_h(app, "/api/users/me", &[("authorization", &bearer)]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["registered"], true);
        let (st, v) = post_json_h(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": "another-quest"}),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["grant"]["user_id"], ids.player.as_str());

        // A session must not act as someone else (client-bug guard).
        let (st, _) = post_json_h(
            app,
            "/api/checkout",
            json!({"user_id": "someone-else", "quest_id": ids.quest}),
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);

        // Garbage tokens are 401, not anonymous fallback.
        let (st, _) = post_json_h(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": ids.quest}),
            &[("authorization", "Bearer not-a-real-token")],
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }

    /// Admin user management (admin-users spec): the dual authorizer (shared secret
    /// vs session-admin), listing without secret leakage, role assignment, and the
    /// anti-lockout + validation guards. Uses `.find` rather than length/index so it
    /// tolerates the shared, pre-populated Postgres database in `pg_scenarios`.
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
        let (st, me) = get_json_h(app, "/api/users/me", &[("authorization", &alice_bearer)]).await;
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
            .find(|u| u["user_id"] == alice.as_str())
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
        let (_, me_b) = get_json_h(app, "/api/users/me", &[("authorization", &bob_bearer)]).await;
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
            &[("x-user-id", &ids.player)],
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN, "anonymous cannot publish");

        // A plain player session cannot publish.
        let pl = format!("{}-pl", ids.player);
        let pl_email = format!("{pl}@example.com");
        let (st, rv) = post_json(
            app,
            "/api/auth/register",
            json!({"user_id": pl, "email": pl_email, "password": "hunter2hunter2"}),
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
            json!({"user_id": ids.player, "quest_id": quest_b}),
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
            json!({"user_id": ids.player, "quest_id": quest_b}),
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
        let (st, stats) =
            get_json_h(app, "/api/users/me/stats", &[("x-user-id", &ids.player)]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(stats["balance"], -2, "5 + 5 - 12, unclamped");
        assert_eq!(stats["quests_completed"], 1);
        assert_eq!(stats["completed_quest_ids"], json!([ids.quest.as_str()]));
        assert_eq!(stats["attempts_count"], 2);
        assert_eq!(stats["grants_count"], 2);

        // Idempotent re-append changes nothing.
        let (_, _) = post_json(app, &format!("/api/attempts/{attempt_b}/facts"), hint_batch).await;
        let (_, stats2) =
            get_json_h(app, "/api/users/me/stats", &[("x-user-id", &ids.player)]).await;
        assert_eq!(stats, stats2, "duplicate appends never move stats");
    }

    async fn scenario_payment_ref_audit(app: &Router, ids: &Ids) {
        // Payment path: mock provider approves, ref recorded on the grant.
        let (st, v1) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": ids.quest}),
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
            json!({"user_id": ids.player, "quest_id": coupon_quest, "coupon_code": code}),
        )
        .await;
        assert_eq!(v2["grant"]["source"], "CouponRedemption");
        assert_eq!(v2["grant"]["source_ref"], Value::Null);

        // Idempotent repeat preserves the original audit ref.
        let (_, v3) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": ids.quest}),
        )
        .await;
        assert_eq!(v3["created"], false);
        assert_eq!(v3["grant"]["source_ref"], v1["grant"]["source_ref"]);
    }

    // === In-memory backend (fresh state per test, fixed tags) ===

    /// `/health` is the release gate: CI polls it until `build_id` equals the id
    /// of the commit being released, and only then promotes the frontend (see
    /// `.github/workflows/release.yml`). So the field is part of the contract, not
    /// decoration — dropping or renaming it silently disables the gate.
    ///
    /// It reports exactly ONE identity, and a derived one. The endpoint used to
    /// also carry the crate version, which sat at "0.1.0" from the first commit of
    /// the repository and was never once bumped — so an operator reading it to
    /// answer "is my change live?" always got the same answer, whatever was
    /// actually deployed. A constant shaped like a deploy identity is worse than
    /// no identity at all.
    #[tokio::test]
    async fn health_reports_the_build_id_and_nothing_hand_maintained() {
        let app = test_app();
        let (status, body) = get_json(&app, "/health").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["build_id"], "test-build");
        assert!(
            body.get("version").is_none(),
            "/health must not report a hand-maintained version — it cannot be kept \
             true and the release gate does not read it: {body}"
        );
    }

    /// Outside a released image there is no `BUILD_ID`, and the fallback must be a
    /// value no released build can ever produce — otherwise a misconfigured
    /// container could report an id CI mistakes for the real one and promote the
    /// frontend against a backend that never updated.
    #[test]
    fn build_id_falls_back_to_dev_when_unset() {
        assert_eq!(config::build_id_from(None), "dev");
        assert_eq!(config::build_id_from(Some("   ")), "dev");
        assert_eq!(config::build_id_from(Some("a1b2c3d4e5f6")), "a1b2c3d4e5f6");
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

        // Validation: empty code, bad percent, bad date, zero limit, empty quest list.
        for bad in [
            json!({"code": "   ", "discount_type": "percent", "discount_value": 10}),
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
            json!({"user_id": player, "quest_id": ids.quest, "code": code.to_ascii_lowercase()}),
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
                json!({"user_id": player, "quest_id": ids.quest, "code": unknown}),
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
            json!({"user_id": player, "quest_id": "ghost-quest", "code": code}),
        )
        .await;
        assert_eq!(v["valid"], false);

        // Preview does not consume: checkout with the code still succeeds,
        // and only then does the per-user limit bite the NEXT quest.
        let (st, out) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": player, "quest_id": ids.quest, "coupon_code": code}),
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
            json!({"user_id": player, "quest_id": other, "code": code}),
        )
        .await;
        assert_eq!(v["valid"], false);
        assert_eq!(v["message"], "Вы уже использовали этот промокод");
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
            json!({"user_id": p("r1"), "quest_id": quest_c, "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);
        assert_eq!(body["error"], "Промокод не действует на этот квест");

        // Partial discount on quest_a charges the provider (Payment)...
        let (st, out) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": p("r1"), "quest_id": quest_a, "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(out["grant"]["source"], "Payment");
        // ...while a clamped full discount on quest_b bypasses it entirely.
        let (st, out) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": p("r2"), "quest_id": quest_b, "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(out["grant"]["source"], "CouponRedemption");

        // Cap of 2 reached → third player gets the exhausted message.
        let (st, body) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": p("r3"), "quest_id": quest_a, "coupon_code": code}),
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
            json!({"user_id": p("r4"), "quest_id": quest_a, "coupon_code": code}),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);
        assert_eq!(body["error"], "Промокод временно не действует");

        // Unknown code on a paid quest → 404 with the player-facing message.
        let (st, body) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": p("r5"), "quest_id": quest_a, "coupon_code": "NOPE-9"}),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "промокод не найден");
    }

    /// v2 spec §9.1/§12.6 — the owner reports the dashboard status control fails
    /// on EVERY transition. The dashboard drives POST
    /// /api/constructor/quests/{id}/status with an EDITOR SESSION (Bearer), not
    /// the ops token that constructor_full_lifecycle uses — and until now the
    /// Postgres store never ran ANY constructor scenario. This walks the real
    /// user path over the full transition matrix on both stores.
    /// §11 review visibility: a later star-only re-rate updates the stars but
    /// keeps the player's written review, and the reviews endpoint pages past
    /// the product page's first ten.
    async fn scenario_review_visibility(app: &Router, ids: &Ids) {
        let attempt1 = grant_publish_attempt(app, ids).await;
        let quest = ids.quest.as_str();
        let rate = |attempt: String, stars: &str, note: Option<&str>| {
            let uri = format!("/api/attempts/{attempt}/facts");
            let body = json!({ "facts": [{
                "type": "quest_rated", "step_position": 0, "submitted_value": stars,
                "local_is_correct": true, "coins_delta": 0,
                "note": note, "device_id": "d1"
            }] });
            async move {
                let (st, _) = post_json(app, &uri, body).await;
                assert_eq!(st, StatusCode::OK);
            }
        };
        rate(attempt1, "5", Some("Отличный квест!")).await;

        // Replay: a new attempt with a star-only re-rate.
        let (st, att) = post_json(
            app,
            "/api/attempts",
            json!({ "user_id": ids.player, "quest_id": quest }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let attempt2 = att["attempt_id"].as_str().expect("attempt id").to_string();
        // A whitespace-only note IS a star-only rating (pins the blank rule
        // in both stores' text selection).
        rate(attempt2, "3", Some("   ")).await;

        let (st, v) = get_json(app, &format!("/api/quests/{quest}")).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["rating_avg"], 3.0, "stars follow the latest rating");
        assert_eq!(v["rating_count"], 1, "a replaying player counts once");
        assert_eq!(v["reviews_total"], 1, "the written review survives: {v}");
        assert_eq!(v["reviews"][0]["text"], "Отличный квест!");
        assert_eq!(
            v["reviews"][0]["rating"], 3,
            "shown with the effective stars"
        );

        // A second reviewer, then page through the dedicated endpoint.
        let buyer = format!("rev2-{}", ids.player);
        let (st, _) = post_json(
            app,
            "/api/checkout",
            json!({ "user_id": buyer, "quest_id": quest }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, att) = post_json(
            app,
            "/api/attempts",
            json!({ "user_id": buyer, "quest_id": quest }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let attempt3 = att["attempt_id"].as_str().expect("attempt id").to_string();
        rate(attempt3, "4", Some("Тоже неплохо")).await;

        let (st, page) = get_json(
            app,
            &format!("/api/quests/{quest}/reviews?offset=0&limit=1"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(page["total"], 2);
        assert_eq!(page["reviews"][0]["text"], "Тоже неплохо", "newest first");
        assert_eq!(page["reviews"].as_array().expect("page").len(), 1);
        let (st, page) = get_json(
            app,
            &format!("/api/quests/{quest}/reviews?offset=1&limit=1"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(page["reviews"][0]["text"], "Отличный квест!");
    }

    /// No authored payload is stored with pixels inside it. Create, save and
    /// publish all take an inline `data:` image apart — the cover column, every
    /// image anywhere in the body, and the frozen snapshot a player downloads —
    /// and store a reference instead. That is what lets the dashboard list carry
    /// the real image rather than falling back to a letter tile, and what keeps
    /// a quest record from growing to megabytes of base64.
    async fn scenario_media_externalized_on_write(app: &Router, ids: &Ids) {
        let bearer = editor_bearer(app, &ids.player).await;
        let h = [("authorization", bearer.as_str())];
        let make = |id: &str, cover: serde_json::Value| {
            json!({
                "quest_id": id,
                "name": "Обложечный квест",
                "cover": cover,
                "steps_count": 1,
                "body": { "id": id, "meta": { "title": "К", "cover": cover },
                          "steps": [{ "image": { "url": "data:image/jpeg;base64,AQID" } }],
                          "versions": [] }
            })
        };
        let url_quest = format!("{}-url", ids.quest);
        let blob_quest = format!("{}-blob", ids.quest);
        let (st, _) = post_json_h(
            app,
            "/api/constructor/quests",
            make(&url_quest, json!("/api/media/coverhash")),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = post_json_h(
            app,
            "/api/constructor/quests",
            make(&blob_quest, json!("data:image/png;base64,AAAA")),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        let (st, list) = get_json_h(app, "/api/constructor/quests", &h).await;
        assert_eq!(st, StatusCode::OK);
        let cover_of = |id: &str| {
            list.as_array()
                .expect("list")
                .iter()
                .find(|q| q["quest_id"] == id)
                .expect("row")["cover"]
                .clone()
        };
        assert_eq!(cover_of(&url_quest), json!("/api/media/coverhash"));
        // "AAAA" decodes to three zero bytes; the store addresses them by sha256.
        // The URL prefix is per-environment, so assert the content address.
        let hash = crate::media::sha256_hex(&[0u8, 0, 0]);
        let blob_cover = cover_of(&blob_quest);
        assert_eq!(
            crate::media::media_hash_in_ref(blob_cover.as_str().expect("cover url")),
            Some(hash.as_str()),
            "data: blob externalized on create, so the list carries the image"
        );
        // Saving a legacy body re-externalizes the same way (one rule, both
        // writes), and echoes the URL back so the editor stops re-sending the
        // blob on every autosave.
        let (st, saved) = post_json_h(
            app,
            &format!("/api/constructor/quests/{blob_quest}/save"),
            make(&blob_quest, json!("data:image/png;base64,AAAA")),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(saved["cover"], blob_cover, "save echoes the stored cover");
        let (st, one) = get_json_h(app, &format!("/api/constructor/quests/{blob_quest}"), &h).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(one["cover"], blob_cover);
        // The BODY is taken apart too, not just the two columns beside it: the
        // step image and the cover copy inside the body are references, so the
        // stored record is kilobytes rather than one base64 string per step.
        let step_image = crate::media::sha256_hex(&[1u8, 2, 3]);
        assert_eq!(one["body"]["meta"]["cover"], blob_cover);
        assert_eq!(
            crate::media::media_hash_in_ref(
                one["body"]["steps"][0]["image"]["url"]
                    .as_str()
                    .expect("step image url")
            ),
            Some(step_image.as_str()),
            "an image inside the body is externalized by the same rule",
        );

        // Publish writes the catalog cover from the same client field, so it
        // externalizes too — a base64 cover must not reach the store card — and
        // so does the frozen snapshot, which is what every player downloads.
        let (st, _) = post_json_h(
            app,
            "/api/quests/publish",
            json!({
                "quest_id": blob_quest,
                "name": "Обложечный квест",
                "primary_comic": "data:image/png;base64,AAAA",
                "template_summary": "start",
                "snapshot_version": 1,
                "snapshot": { "golden_id": blob_quest, "name": "К", "snapshot_version": 1,
                              "steps": [{ "image": "data:image/jpeg;base64,AQID" }] }
            }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, product) = get_json(app, &format!("/api/quests/{blob_quest}")).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(product["primary_comic"], blob_cover);
        let (_, _) = post_json(
            app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": blob_quest}),
        )
        .await;
        let (st, bundle) = get_json(
            app,
            &format!("/api/quests/{blob_quest}/bundle?user_id={}", ids.player),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            crate::media::media_hash_in_ref(
                bundle["snapshot"]["steps"][0]["image"]
                    .as_str()
                    .expect("snapshot image url")
            ),
            Some(step_image.as_str()),
            "the frozen snapshot ships references, not megabytes of base64",
        );
    }

    /// Handing a quest to another author: an ADMIN decision, over the closed set
    /// of accounts that may own one (editors and admins). The quest leaves the
    /// old author's workspace and lands in the new one; the old author loses
    /// every per-quest right with it.
    async fn scenario_ctor_transfer_author(app: &Router, ids: &Ids) {
        let owner = editor_bearer(app, &ids.player).await;
        let owner_h = [("authorization", owner.as_str())];
        let admin = admin_bearer(app, &ids.player).await;
        let admin_h = [("authorization", admin.as_str())];
        let heir = role_bearer(app, "ed2", &ids.player, "editor").await;
        let heir_h = [("authorization", heir.as_str())];
        let heir_id = format!("ed2-{}", ids.player);
        let player_id = {
            role_bearer(app, "pl", &ids.player, "player").await;
            format!("pl-{}", ids.player)
        };
        let quest = ids.quest.as_str();

        let (st, created) = post_json_h(
            app,
            "/api/constructor/quests",
            json!({
                "quest_id": quest, "name": "Передаваемый квест", "cover": null, "steps_count": 1,
                "body": { "id": quest, "meta": { "title": "Передаваемый квест" }, "steps": [1], "versions": [] }
            }),
            &owner_h,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let owner_id = created["author_id"].as_str().expect("author").to_string();

        // The candidate list is the accounts that may own a quest — admins and
        // editors, never players — and only an admin may read it.
        let (st, _) = get_json_h(app, "/api/constructor/authors", &owner_h).await;
        assert_eq!(st, StatusCode::FORBIDDEN, "an editor cannot list accounts");
        let (st, authors) = get_json_h(app, "/api/constructor/authors", &admin_h).await;
        assert_eq!(st, StatusCode::OK);
        let ids_of = |v: &Value| {
            v.as_array()
                .expect("authors")
                .iter()
                .map(|a| a["user_id"].as_str().expect("id").to_string())
                .collect::<Vec<_>>()
        };
        let listed = ids_of(&authors);
        assert!(listed.contains(&heir_id), "editors are candidates");
        assert!(!listed.contains(&player_id), "players are not");

        let transfer = |to: &str| json!({ "author_id": to });
        let url = format!("/api/constructor/quests/{quest}/author");

        // Only an admin transfers. The owner is not one, and the ops token is
        // never admin in the constructor (it must not gain cross-author reach).
        let (st, _) = post_json_h(app, &url, transfer(&heir_id), &owner_h).await;
        assert_eq!(st, StatusCode::FORBIDDEN, "an editor cannot transfer");
        let (st, _) = post_json_h(
            app,
            &url,
            transfer(&heir_id),
            &[("x-admin-token", TEST_ADMIN_TOKEN)],
        )
        .await;
        assert_eq!(
            st,
            StatusCode::FORBIDDEN,
            "the ops token is not an admin here"
        );

        // Only an account that may own a quest can receive one.
        let (st, _) = post_json_h(app, &url, transfer(&player_id), &admin_h).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "a player cannot own a quest");
        let (st, _) = post_json_h(app, &url, transfer("nobody"), &admin_h).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "unknown account");

        let (st, moved) = post_json_h(app, &url, transfer(&heir_id), &admin_h).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(moved["author_id"], json!(heir_id));
        assert_eq!(
            moved["author"],
            json!(format!("ed2-{}@example.com", ids.player))
        );

        // The workspace follows the ownership, both ways.
        let has = |list: &Value| {
            list.as_array()
                .expect("list")
                .iter()
                .any(|q| q["quest_id"] == quest)
        };
        let (_, heir_list) = get_json_h(app, "/api/constructor/quests", &heir_h).await;
        assert!(has(&heir_list), "the new author sees it");
        let (_, old_list) = get_json_h(app, "/api/constructor/quests", &owner_h).await;
        assert!(!has(&old_list), "the old author does not");
        // …and the rights follow with it: the quest is gone for the old author.
        let (st, _) = get_json_h(app, &format!("/api/constructor/quests/{quest}"), &owner_h).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _) = post_json_h(
            app,
            &format!("/api/constructor/quests/{quest}/delete"),
            json!({}),
            &owner_h,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND, "no lingering per-quest rights");

        // Transferring to the current owner is a no-op, not an error.
        let (st, same) = post_json_h(app, &url, transfer(&heir_id), &admin_h).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(same["author_id"], json!(heir_id));

        // And back, so the scenario leaves the quest with its creator.
        let (st, back) = post_json_h(app, &url, transfer(&owner_id), &admin_h).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(back["author_id"], json!(owner_id));
    }

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
                json!({ "user_id": buyer, "quest_id": quest }),
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
                "snapshot": { "theme": { "bg": "#101014", "ink": "#F2F2F5", "btn": "#C9A227" }, "steps": [
                    { "template": "start", "supporting": { "is_start": true } },
                    { "template": "task_answer", "supporting": {
                        "hint": { "cost_coins": 5, "reveal_text": "x" },
                        "navigator": { "lat": 44.8176, "lng": 20.4569, "label": "Калемегдан" }
                    } },
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
        assert_eq!(
            v["start_point"],
            json!({ "lat": 44.8176, "lng": 20.4569 }),
            "«Место старта» falls back to the first navigator on legacy snapshots"
        );
        assert_eq!(
            v["theme"],
            json!({ "bg": "#101014", "ink": "#F2F2F5", "btn": "#C9A227" }),
            "the quest's colours ride out of the frozen snapshot for the PWA manifest"
        );
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
                json!({ "user_id": buyer, "quest_id": quest }),
            )
            .await;
            assert_eq!(st, StatusCode::OK);
            let (st, att) = post_json(
                app,
                "/api/attempts",
                json!({ "user_id": buyer, "quest_id": quest }),
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
    /// §6.4 change email: session-authed request mails a confirmation to the
    /// NEW address; the email changes only after that link is opened, arrives
    /// confirmed, and a taken address is rejected up front.
    async fn scenario_change_email(
        app: &Router,
        mails: &Mutex<Vec<mailer::OutgoingMail>>,
        ids: &Ids,
    ) {
        let player = ids.player.as_str();
        let old_email = format!("{player}@example.com");
        let new_email = format!("new-{player}@example.com");
        let (_, token) = register(app, player).await;
        let bearer = format!("Bearer {token}");
        let h = [("authorization", bearer.as_str())];

        // No session → 401; garbage address → 400; a password account must
        // re-prove its password (a stolen session alone must not move the
        // mailbox that owns the reset path).
        let (st, _) = post_json(app, "/api/auth/email", json!({ "new_email": new_email })).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        let (st, _) = post_json_h(
            app,
            "/api/auth/email",
            json!({ "new_email": "не почта" }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _) = post_json_h(
            app,
            "/api/auth/email",
            json!({ "new_email": new_email, "current_password": "wrong-password" }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED, "wrong password rejected");

        // Request the change: the mail goes to the NEW address, nothing
        // changes yet, and the OLD address is notified.
        let (st, v) = post_json_h(
            app,
            "/api/auth/email",
            json!({ "new_email": new_email, "current_password": "hunter2hunter2" }),
            &h,
        )
        .await;
        assert_eq!(st, StatusCode::OK, "change requested: {v}");
        assert_eq!(v["status"], "sent");
        assert!(
            mails
                .lock()
                .expect("lock")
                .iter()
                .any(|m| m.to == old_email && m.subject.contains("смена почты")),
            "displaced mailbox is warned"
        );
        let (_, me) = get_json_h(app, "/api/users/me", &[("authorization", &bearer)]).await;
        assert_eq!(me["email"], old_email, "unchanged until confirmed");

        // The mailed link confirms the change; the address arrives CONFIRMED.
        let change_token = mailed_token(mails, &new_email);
        let (st, v) = post_json(app, "/api/auth/confirm", json!({ "token": change_token })).await;
        assert_eq!(st, StatusCode::OK, "confirm: {v}");
        assert_eq!(v["email"], new_email);
        assert_eq!(v["changed"], true, "the landing can name what happened");
        let (_, me) = get_json_h(app, "/api/users/me", &[("authorization", &bearer)]).await;
        assert_eq!(me["email"], new_email);
        assert_eq!(me["needs_email_confirmation"], false, "arrives confirmed");

        // The old address is free again, the new one is taken by this account.
        let (st, v) = post_json(app, "/api/auth/identify", json!({ "email": old_email })).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["exists"], false, "old address released");

        // A second account cannot take the new address.
        let other = format!("other-{player}");
        let (_, other_token) = register(app, &other).await;
        let other_bearer = format!("Bearer {other_token}");
        let oh = [("authorization", other_bearer.as_str())];
        let (st, _) = post_json_h(
            app,
            "/api/auth/email",
            json!({ "new_email": new_email, "current_password": "hunter2hunter2" }),
            &oh,
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT, "taken address rejected up front");

        // A consumed token cannot be replayed.
        let (st, _) = post_json(app, "/api/auth/confirm", json!({ "token": change_token })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "single-use");
    }

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
        assert_eq!(v["user_id"], player);
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
        let (st, _) = get_json_h(app, "/api/users/me", &[("authorization", bearer.as_str())]).await;
        // The pre-delete session must be dead too (claims fall back to anonymous or 401).
        assert_ne!(st, StatusCode::INTERNAL_SERVER_ERROR);
        let (_, v) = post_json(app, "/api/auth/identify", json!({ "email": email })).await;
        assert_eq!(v["exists"], false, "email is free again");
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
        assert_eq!(v["user_id"], ids.player.as_str());
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
    async fn measure_rates_endpoint() {
        let (st, rates) = get_json(&test_app(), "/api/measure/rates").await;
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
            ("x-user-id", "dev-owner"),
        ];
        let other: [(&str, &str); 2] = [
            ("x-admin-token", TEST_ADMIN_TOKEN),
            ("x-user-id", "dev-other"),
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
                    .header("x-user-id", "dev-owner")
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
        let a: [(&str, &str); 2] = [("x-admin-token", TEST_ADMIN_TOKEN), ("x-user-id", "dev-a")];
        let b: [(&str, &str); 2] = [("x-admin-token", TEST_ADMIN_TOKEN), ("x-user-id", "dev-b")];

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

    /// Pins the ops-token capability split (`authz`): the shared `ADMIN_TOKEN`
    /// grants the admin surface and passes the editor gate, but in the
    /// constructor it is author-scoped (never admin) — a bare ops token cannot
    /// see or open a session editor's quest, while a session ADMIN can.
    #[tokio::test]
    async fn ops_token_grants_admin_surface_but_never_foreign_constructor_quests() {
        let app = test_app();
        let editor = editor_bearer(&app, "opspin").await;
        let (st, _) = post_json_h(
            &app,
            "/api/constructor/quests",
            json!({
                "quest_id": "q-ops-pin", "name": "Свой", "cover": null, "steps_count": 1,
                "body": { "id": "q-ops-pin", "meta": { "title": "Свой" }, "steps": [1], "versions": [] }
            }),
            &[("authorization", editor.as_str())],
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        let ops = [("x-admin-token", TEST_ADMIN_TOKEN)];
        // Admin surface: OK for the bare ops token.
        let (st, _) = get_json_h(&app, "/api/admin/users", &ops).await;
        assert_eq!(st, StatusCode::OK, "ops token reaches the admin surface");
        // Editor gate: passes, but the workspace is the ops author's own (empty),
        // never every author's.
        let (st, list) = get_json_h(&app, "/api/constructor/quests", &ops).await;
        assert_eq!(st, StatusCode::OK, "ops token passes the editor gate");
        assert_eq!(
            list.as_array().expect("array").len(),
            0,
            "ops token lists no foreign quests"
        );
        // Per-quest reach: a foreign quest reads as absent for the ops token...
        let (st, _) = get_json_h(&app, "/api/constructor/quests/q-ops-pin", &ops).await;
        assert_eq!(
            st,
            StatusCode::NOT_FOUND,
            "ops token cannot open another author's quest"
        );
        // ...but a session ADMIN is the superuser and opens it fine.
        let admin = admin_bearer(&app, "opspin").await;
        let (st, _) = get_json_h(
            &app,
            "/api/constructor/quests/q-ops-pin",
            &[("authorization", admin.as_str())],
        )
        .await;
        assert_eq!(st, StatusCode::OK, "session admin opens any author's quest");
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

    async fn pg_app(
        pool: sqlx::PgPool,
    ) -> (Router, std::sync::Arc<Mutex<Vec<mailer::OutgoingMail>>>) {
        let media_cfg = test_media_cfg();
        let (m, outbox) = mailer::Mailer::recorder();
        // Same baseline as the in-memory harness: nothing seeds overrides any
        // more, so a harness must switch on the features it exercises. Idempotent
        // upserts — the pg suites share one database and run concurrently.
        let storage = Storage::postgres(pool);
        for f in TEST_ENABLED_FLAGS {
            storage
                .flags
                .set(f.key(), true)
                .await
                .expect("enable baseline flag");
        }
        let router = build_router(AppState {
            config: AppConfig {
                addr: "0.0.0.0:0".parse().expect("test addr"),
                build_id: "test-build".to_string(),
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
            store: storage.facts,
            grants: storage.grants,
            auth: storage.auth,
            constructor: storage.constructor,
            coupons: storage.coupons,
            media: MediaStores::from_config(&media_cfg).expect("in-process media store"),
            payment_rows: storage.payments,
            moderation: storage.moderation,
            flags: storage.flags,
            settings: storage.settings,
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
    /// like the pg_scenarios tests. Run-unique ids tolerate a shared DB and never collide
    /// with the fixed seed ids the 0006 cleanup targets.
    #[tokio::test]
    async fn pg_constructor_lifecycle() {
        let Some(h) = pg_harness("pg_constructor_lifecycle").await else {
            return;
        };
        let app = h.app;
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let qid = format!("q-citest-{}", h.run);

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
        let dev_id = format!("dev-citest-{}", h.run);
        let dev: [(&str, &str); 2] = [
            ("x-admin-token", TEST_ADMIN_TOKEN),
            ("x-user-id", dev_id.as_str()),
        ];
        let other_qid = format!("q-citest-other-{}", h.run);
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

    /// PostgreSQL parity for [`backfill`]. The in-memory tests there are the
    /// spec; this drives the same one-off through the real SQL writers — the
    /// `updated_at` guard in the UPDATE, and the snapshot rewrite that goes
    /// around a freeze guard which would (correctly) refuse a republish. The
    /// legacy row is written straight through the store because no HTTP write
    /// can produce one any more.
    #[tokio::test]
    async fn pg_media_backfill_rewrites_a_legacy_row() {
        dotenv().ok();
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("pg_media_backfill_rewrites_a_legacy_row: skipped (DATABASE_URL not set)");
            return;
        };
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect to DATABASE_URL");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        let ctor: store::ConstructorStores =
            Arc::new(pg_store::PgConstructorStore::new(pool.clone()));
        let grants: store::GrantStores = Arc::new(pg_store::PgGrantStore::new(pool));
        let media = media::MediaStores::InMemory(Arc::new(Mutex::new(
            media::InMemoryMediaStore::new("/api/media".to_string()),
        )));
        let run = store::now_secs() * 1_000_000 + (std::process::id() as u64 % 1_000_000);
        let qid = format!("q-legacymedia-{run}");
        let snapshot_id = format!("{qid}-v1");
        let blob = "data:image/png;base64,AAAA";
        let url_of = format!("/api/media/{}", media::sha256_hex(&[0u8, 0, 0]));
        let real_author = format!("author-{run}");
        ctor.create(store::ConstructorQuest {
            quest_id: qid.clone(),
            author_id: real_author.clone(),
            author_name: "Автор".into(),
            name: "Легаси обложка".into(),
            status: store::CTOR_STATUS_DRAFT.into(),
            cover: Some(blob.into()),
            steps_count: 1,
            attrs: store::QuestAttributes::default(),
            created_at: 1,
            updated_at: 1,
            body: json!({ "id": qid, "steps": [{ "image": blob }] }),
        })
        .await
        .expect("create");
        grants
            .register_published(
                &qid,
                PublishedMeta {
                    quest_id: qid.clone(),
                    name: "Легаси обложка".into(),
                    primary_comic: Some(blob.into()),
                    template_summary: "demo".into(),
                    snapshot_version: 1,
                    snapshot_id: snapshot_id.clone(),
                    city: None,
                    duration: None,
                    price: None,
                    description: None,
                    pages: None,
                    tasks: None,
                    paid_hints: None,
                    players_bonus: 0,
                },
                Some(json!({ "steps": [{ "image": blob }] })),
            )
            .await
            .expect("publish");

        // The registry is shared with every other pg test, so budget for this
        // row plus whatever else is lying around, and assert on the row itself.
        let report = backfill::run_media_backfill(&media, &ctor, &grants, 200)
            .await
            .expect("backfill");
        assert!(report.quests_rewritten >= 1);

        let stored = ctor.get(&qid).await.expect("query").expect("row");
        assert_eq!(stored.cover.as_deref(), Some(url_of.as_str()));
        assert_eq!(stored.body["steps"][0]["image"], url_of);
        assert_eq!(stored.updated_at, 1, "a rewrite is not an edit");
        assert_eq!(
            grants
                .get_published(&qid)
                .await
                .expect("query")
                .expect("row")
                .primary_comic
                .as_deref(),
            Some(url_of.as_str()),
        );
        assert_eq!(
            grants
                .get_snapshot(&snapshot_id)
                .await
                .expect("query")
                .expect("frozen")["steps"][0]["image"],
            url_of,
            "the frozen snapshot a player downloads carries a reference",
        );

        // The SQL guards: a stale `updated_at` cannot rewrite, and a stale owner
        // cannot delete.
        assert!(
            !ctor
                .rewrite_media(&qid, 999, None, json!({}))
                .await
                .expect("rewrite"),
            "the optimistic guard keeps a stale reader out"
        );
        assert!(
            !ctor
                .delete(&qid, store::AuthorGuard::Is("someone-else"))
                .await
                .expect("delete"),
            "the guard keeps a stale owner out"
        );
        assert!(
            ctor.delete(&qid, store::AuthorGuard::Is(&real_author))
                .await
                .expect("delete")
        );
    }

    /// Everything a per-scenario Postgres test needs: the router over a real
    /// pool (migrations applied) and a run-unique tag so scenarios tolerate a
    /// shared, pre-populated database. `None` means "skip: no DATABASE_URL".
    struct PgHarness {
        app: Router,
        mails: std::sync::Arc<Mutex<Vec<mailer::OutgoingMail>>>,
        run: u64,
    }

    async fn pg_harness(test: &str) -> Option<PgHarness> {
        dotenv().ok();
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("{test}: skipped (DATABASE_URL not set)");
            return None;
        };
        let pool = sqlx::postgres::PgPoolOptions::new()
            // Pg tests run CONCURRENTLY (one per scenario): ~32 pools must fit
            // under Postgres's default max_connections=100, and each scenario's
            // requests are sequential — 2 connections suffice.
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect to DATABASE_URL");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        let (app, mails) = pg_app(pool).await;
        let run = store::now_secs() * 1_000_000 + (std::process::id() as u64 % 1_000_000);
        Some(PgHarness { app, mails, run })
    }

    /// ONE scenario list, BOTH backends. Each row expands to an in-memory
    /// `#[tokio::test]` (fresh `test_app`) and a `pg_scenarios::*` twin that
    /// self-skips without DATABASE_URL. A scenario cannot be registered for one
    /// backend and silently missed on the other — the row is the registration.
    ///
    /// Row shapes: `ids` — `scenario(&app, &Ids)`; `plain` — `scenario(&app)`;
    /// `mails` — `scenario(&app, &outbox, &Ids)`; `key` — `scenario(&app, &str)`.
    macro_rules! scenarios {
        (@mem ids $scenario:ident, $slug:literal) => {
            $scenario(&test_app(), &Ids::new($slug)).await;
        };
        (@mem plain $scenario:ident, $slug:literal) => {
            $scenario(&test_app()).await;
        };
        (@mem mails $scenario:ident, $slug:literal) => {
            let (app, mails) = TestApp {
                mail_recorder: true,
                ..TestApp::default()
            }
            .build();
            let mails = mails.expect("recorder outbox");
            $scenario(&app, &mails, &Ids::new($slug)).await;
        };
        (@mem key $scenario:ident, $slug:literal) => {
            $scenario(&test_app(), concat!("legacy:", $slug)).await;
        };
        (@pg ids $scenario:ident, $h:ident, $tag:ident) => {
            $scenario(&$h.app, &Ids::new(&$tag)).await;
        };
        (@pg plain $scenario:ident, $h:ident, $tag:ident) => {
            $scenario(&$h.app).await;
        };
        (@pg mails $scenario:ident, $h:ident, $tag:ident) => {
            $scenario(&$h.app, &$h.mails, &Ids::new(&$tag)).await;
        };
        (@pg key $scenario:ident, $h:ident, $tag:ident) => {
            $scenario(&$h.app, &format!("legacy:{}", $tag)).await;
        };
        ($($name:ident = $kind:ident $scenario:ident / $slug:literal;)*) => {
            $(
                #[tokio::test]
                async fn $name() {
                    scenarios!(@mem $kind $scenario, $slug);
                }
            )*

            mod pg_scenarios {
                use super::*;
                $(
                    #[tokio::test]
                    async fn $name() {
                        let Some(h) =
                            pg_harness(concat!("pg_scenarios::", stringify!($name))).await
                        else {
                            return;
                        };
                        let _tag = format!("{}-{}", $slug, h.run);
                        scenarios!(@pg $kind $scenario, h, _tag);
                    }
                )*
            }
        };
    }

    scenarios! {
        attempt_requires_grant_and_published_quest = ids scenario_attempt_gating / "gate";
        unknown_attempt_rejected_on_append_and_state = plain scenario_unknown_attempt / "na";
        happy_chain_grant_attempt_facts_idempotent_reconnect = ids scenario_happy_chain / "happy";
        multi_device_overdraft_stays_negative = ids scenario_multi_device_overdraft / "od";
        cross_device_duplicate_award_absorbed = ids scenario_cross_device_duplicate / "dup";
        concurrent_duplicate_batch_collapses_to_one = ids scenario_concurrent_duplicate_batch / "race";
        completion_bonus_idempotent_across_attempts = ids scenario_completion_bonus_once / "bonus";
        completions_count_distinct_finishers = ids scenario_completions_count_distinct_finishers / "finishers";
        rating_and_comment_bonuses_once_ever = ids scenario_rating_rewards / "raterew";
        version_freeze_new_publish_does_not_rebind = ids scenario_version_freeze / "freeze";
        checkout_idempotent_coupon100_and_publish_list = ids scenario_checkout_and_publish_list / "shop";
        store_lists_only_published_quests = ids scenario_store_lists_only_published / "vis";
        bundle_endpoint_gated_by_grant = ids scenario_bundle_gated_by_grant / "bundle";
        publish_rejects_frozen_snapshot_rewrite = ids scenario_snapshot_immutability / "frozen";
        admin_stats_and_feedbacks_per_version = ids scenario_admin_stats / "admin";
        admin_user_management_list_and_roles = ids scenario_admin_users / "users";
        admin_surfaces_name_quests_from_the_authoring_registry = ids scenario_admin_quest_labels / "labels";
        admin_coupons_crud_validation_and_gating = ids scenario_admin_coupons / "cpncrud";
        coupon_validate_previews_without_consuming = ids scenario_coupon_validate / "cpnprev";
        checkout_redeems_coupons_with_limits_and_stats = ids scenario_coupon_redeem / "cpnrdm";
        publish_requires_editor_role = ids scenario_publish_authz / "pubauthz";
        ctor_status_lifecycle_editor_session = ids scenario_ctor_status_lifecycle / "ctorstatus";
        authored_payloads_are_stored_without_pixels = ids scenario_media_externalized_on_write / "ctorcover";
        ctor_quest_transfers_between_authors = ids scenario_ctor_transfer_author / "ctorxfer";
        review_survives_star_only_rerate_and_pages = ids scenario_review_visibility / "reviews";
        product_page_payload = ids scenario_product_page / "product";
        auth_v2_full_flow = mails scenario_auth_v2 / "authv2";
        reset_by_code_alongside_link = mails scenario_reset_by_code / "resetcode";
        change_email_confirms_on_the_new_address = mails scenario_change_email / "chmail";
        bad_payload_rejected_with_4xx = ids scenario_bad_payload / "bad";
        migration_idempotent = key scenario_migration_idempotent / "mig";
        auth_register_login_preserves_identity = ids scenario_auth_register_login / "auth";
        auth_enforcement_two_tier = ids scenario_auth_enforcement / "enforce";
        player_stats_cross_attempt_fold = ids scenario_player_stats / "stats";
        payment_ref_audited_on_grants = ids scenario_payment_ref_audit / "pay";
    }

    /// Restart survival: a brand-new pool + router (process restart equivalent)
    /// sees the pre-restart state, and bonus/auth idempotency survives. Runs its
    /// own setup scenarios so it is independent of the per-scenario pg tests.
    #[tokio::test]
    async fn pg_restart_survival() {
        let Some(h) = pg_harness("pg_restart_survival").await else {
            return;
        };
        let run = h.run;
        let happy_ids = Ids::new(&format!("happyre-{run}"));
        let happy_attempt = scenario_happy_chain(&h.app, &happy_ids).await;
        let enforce_ids = Ids::new(&format!("enforcere-{run}"));
        scenario_auth_enforcement(&h.app, &enforce_ids).await;

        let h2 = pg_harness("pg_restart_survival (restart)")
            .await
            .expect("DATABASE_URL checked by the first harness");
        let app2 = h2.app;
        let (st, gv) = get_json(&app2, &format!("/api/attempts/{happy_attempt}/state")).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(gv["projected"]["balance"], 5, "projection survives restart");
        assert_eq!(gv["snapshot_id"], happy_ids.snap1.as_str());

        let bonus = json!({"facts": [fact_json(FactKind::CompletionBonus, 3, 5, "device-a")]});
        let (_, meta2) = post_json(
            &app2,
            "/api/attempts",
            json!({"user_id": happy_ids.player, "quest_id": happy_ids.quest}),
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
            json!({"user_id": happy_ids.player, "quest_id": happy_ids.quest}),
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
        let (st, me) = get_json_h(&app2, "/api/users/me", &[("authorization", &bearer)]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(me["registered"], true);
        assert_eq!(me["user_id"], enforce_ids.player.as_str());
    }
    // ===== YooKassa redirect flow (scripted fake gateway — the real API is
    // ===== never called from tests) =====

    /// `test_app` + the scripted YooKassa fake injected into state.
    fn test_app_yookassa() -> (Router, std::sync::Arc<Mutex<yookassa::FakeYookassa>>) {
        let mut state = test_state(test_config());
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
        let mut body = json!({"user_id": ids.player, "quest_id": ids.quest,
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

    /// Owner poll for a payment (X-User-Id identity, as the return page does).
    async fn poll_payment(app: &Router, player: &str, payment_id: &str) -> (StatusCode, Value) {
        get_json_h(
            app,
            &format!("/api/payments/{payment_id}"),
            &[("x-user-id", player)],
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
            &format!("/api/grants?user_id={}", ids.player),
            &[("x-user-id", ids.player.as_str())],
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
            json!({"user_id": ids.player, "quest_id": ids.quest, "provider": "yookassa"}),
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
            json!({"user_id": ids.player, "quest_id": ids.quest, "provider": "yookassa"}),
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
            json!({"user_id": ids.player, "quest_id": ids.quest, "provider": "yookassa"}),
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
            json!({"user_id": ids.player, "quest_id": ids.quest,
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
    async fn yookassa_full_coupon_bypasses_the_gateway() {
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
            json!({"user_id": ids.player, "quest_id": ids.quest,
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
    }

    #[tokio::test]
    async fn yookassa_unconfigured_fails_closed_and_unknown_provider_rejected() {
        let app = test_app();
        let ids = Ids::new("yk-off");
        let (st, _) = post_json(
            &app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": ids.quest, "provider": "yookassa"}),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_IMPLEMENTED);
        let (st, _) = post_json(
            &app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": ids.quest, "provider": "paypal"}),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn free_quest_checkout_bypasses_providers_and_flags() {
        // A deployment that never enabled any payment provider: paid checkout
        // fails closed, but a published free quest grants without a provider.
        let app = TestApp {
            seeded_flags: false,
            ..TestApp::default()
        }
        .build()
        .0;
        let ids = Ids::new("free-noflags");
        let free_quest = format!("{}-free", ids.quest);
        let (st, _) = publish(
            &app,
            &ids,
            json!({"quest_id": free_quest, "name": "F", "template_summary": "demo",
                   "snapshot_version": 1, "snapshot_id": format!("{}-f", ids.snap1), "price": 0}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        // An unknown provider is rejected before the free short-circuit.
        let (st, _) = post_json(
            &app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": free_quest, "provider": "paypal"}),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        // Free quest, no provider field: granted immediately.
        let (st, v) = post_json(
            &app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": free_quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["grant"]["source"], "FreeQuest");
        assert_eq!(v["created"], json!(true));

        // Idempotent re-checkout returns the stored grant.
        let (st, v) = post_json(
            &app,
            "/api/checkout",
            json!({"user_id": ids.player, "quest_id": free_quest}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["created"], json!(false));
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
        let app = TestApp {
            seeded_flags: false,
            ..TestApp::default()
        }
        .build()
        .0;
        // No credential and a fail-closed (no ADMIN_TOKEN) deployment both 403.
        let (st, _) = get_json(&app, "/api/admin/features").await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        let (st, _) = get_json_h(
            &TestApp {
                admin_token: false,
                ..TestApp::default()
            }
            .build()
            .0,
            "/api/admin/features",
            &[],
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);

        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let (st, v) = get_json_h(&app, "/api/admin/features", &admin).await;
        assert_eq!(st, StatusCode::OK);
        let rows = v.as_array().expect("feature list");
        assert_eq!(rows.len(), features::Feature::ALL.len());
        for row in rows {
            // A fresh deployment stores no overrides at all, so every flag reads
            // its code default — off. Enabling one is always an admin decision.
            let key = row["key"].as_str().expect("key");
            assert_eq!(row["default_enabled"], json!(false), "{key} defaults off");
            assert_eq!(row["override"], Value::Null, "{key} has no override");
            assert_eq!(row["effective"], json!(false), "{key} is off");
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
                ("player_back_button", true),
                ("player_universal_answer", true),
                ("quest_share", true),
            ]
        );
    }

    /// GET /api/features is public and serves ONLY the client-visible flags'
    /// effective verdicts — the player runtime keys behavior off it without
    /// admin credentials, and server-side flags never leak through it.
    #[tokio::test]
    async fn public_features_endpoint_serves_client_visible_flags() {
        let app = test_app();
        let (st, v) = get_json(&app, "/api/features").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            v,
            json!({
                "flags": {
                    "player_back_button": false,
                    "player_universal_answer": false,
                    "quest_share": false,
                },
                "universal_answer": null,
            })
        );

        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let (st, _) = post_json_h(
            &app,
            "/api/admin/features/player_back_button",
            json!({ "enabled": true }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, v) = get_json(&app, "/api/features").await;
        assert_eq!(
            v["flags"],
            json!({
                "player_back_button": true,
                "player_universal_answer": false,
                "quest_share": false,
            })
        );
    }

    /// The universal answer reaches GET /api/features only when BOTH halves
    /// hold: the `player_universal_answer` flag is on AND a value is stored.
    /// Either half alone serves `null` — flipping the flag off retracts the
    /// answer without erasing the stored value.
    #[tokio::test]
    async fn universal_answer_served_only_when_flag_on_and_value_set() {
        let app = test_app();
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        // Value set, flag off → null.
        let (st, v) = post_json_h(
            &app,
            "/api/admin/settings/universal_answer",
            json!({ "value": "  11 " }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            v,
            json!({ "key": "universal_answer", "value": "11" }),
            "trimmed on write"
        );
        let (_, v) = get_json(&app, "/api/features").await;
        assert_eq!(v["universal_answer"], Value::Null);

        // Flag on too → served.
        let (st, _) = post_json_h(
            &app,
            "/api/admin/features/player_universal_answer",
            json!({ "enabled": true }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, v) = get_json(&app, "/api/features").await;
        assert_eq!(v["universal_answer"], json!("11"));

        // Clearing the value (empty string) retracts it while the flag stays on.
        let (st, v) = post_json_h(
            &app,
            "/api/admin/settings/universal_answer",
            json!({ "value": "" }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["value"], Value::Null);
        let (_, v) = get_json(&app, "/api/features").await;
        assert_eq!(v["universal_answer"], Value::Null);
    }

    #[tokio::test]
    async fn settings_endpoints_admin_gated_and_reject_unknown_keys() {
        let app = test_app();
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        // Both verbs require the admin credential.
        let (st, _) = get_json(&app, "/api/admin/settings/universal_answer").await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        let (st, _) = post_json(
            &app,
            "/api/admin/settings/universal_answer",
            json!({ "value": "11" }),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);

        // The registry lives in code: unknown keys are 404 on both verbs.
        let (st, _) = get_json_h(&app, "/api/admin/settings/smtp_url", &admin).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _) = post_json_h(
            &app,
            "/api/admin/settings/smtp_url",
            json!({ "value": "x" }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        // Unset reads as null; set then read round-trips.
        let (st, v) = get_json_h(&app, "/api/admin/settings/universal_answer", &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v, json!({ "key": "universal_answer", "value": null }));
        let (_, _) = post_json_h(
            &app,
            "/api/admin/settings/universal_answer",
            json!({ "value": "42" }),
            &admin,
        )
        .await;
        let (_, v) = get_json_h(&app, "/api/admin/settings/universal_answer", &admin).await;
        assert_eq!(v["value"], json!("42"));
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
            json!({"user_id": "dev:ft", "quest_id": "q-ft", "coupon_code": null}),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_IMPLEMENTED);

        // `enabled: null` clears the override — back to the code default,
        // which is OFF for every flag since the default-off policy.
        let (st, row) = post_json_h(
            &app,
            "/api/admin/features/payments_mock",
            json!({ "enabled": null }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(row["override"], Value::Null);
        assert_eq!(row["effective"], json!(false));
        let (_, v) = get_json(&app, "/api/payments/providers").await;
        assert_eq!(v["providers"], json!([]));

        // Switching it explicitly on restores checkout.
        let (st, row) = post_json_h(
            &app,
            "/api/admin/features/payments_mock",
            json!({ "enabled": true }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(row["effective"], json!(true));
        let (_, v) = get_json(&app, "/api/payments/providers").await;
        assert_eq!(v["providers"], json!(["mock"]));
        let (st, _) = post_json(
            &app,
            "/api/checkout",
            json!({"user_id": "dev:ft", "quest_id": "q-ft", "coupon_code": null}),
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
        let Some(h) = pg_harness("pg_feature_override_round_trip").await else {
            return;
        };
        let app = h.app;
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        // The pg suites share ONE database and run concurrently, so this test
        // must not disable a feature another suite's behavior depends on —
        // toggling `payments_mock` here used to 501 the pg scenario checkouts
        // mid-run. `payments_yookassa` is behavior-inert on the pg app (no
        // gateway configured → the yookassa path is 501 regardless), while the
        // override rows still round-trip through the same store code.
        // Set an override, twice (second write exercises the upsert path).
        for _ in 0..2 {
            let (st, row) = post_json_h(
                &app,
                "/api/admin/features/payments_yookassa",
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
            .find(|r| r["key"] == "payments_yookassa")
            .expect("payments_yookassa row");
        assert_eq!(row["override"], json!(false));

        // Clear: the row is deleted and the code default (off) applies again.
        let (st, row) = post_json_h(
            &app,
            "/api/admin/features/payments_yookassa",
            json!({ "enabled": null }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(row["override"], Value::Null);
        assert_eq!(row["effective"], json!(false));

        // Leave the shared database as migration 0015 seeded it (override on),
        // so reruns and the other pg suites see the launch-era state.
        let (st, row) = post_json_h(
            &app,
            "/api/admin/features/payments_yookassa",
            json!({ "enabled": true }),
            &admin,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(row["effective"], json!(true));
    }

    // ---- admin statistics (overview + per-quest funnel) ---------------------

    fn stats_meta(quest_id: &str, name: &str) -> PublishedMeta {
        PublishedMeta {
            quest_id: quest_id.to_string(),
            name: name.to_string(),
            primary_comic: None,
            template_summary: "3 steps".to_string(),
            snapshot_version: 1,
            snapshot_id: format!("{quest_id}-v1"),
            city: Some("Казань".to_string()),
            duration: None,
            price: Some(500),
            description: None,
            pages: Some(3),
            tasks: Some(1),
            paid_hints: None,
            players_bonus: 0,
        }
    }

    fn stats_snapshot() -> Value {
        json!({
            "steps": [
                { "template": "start", "rich_content": { "title": "Старт: у башни" } },
                { "template": "task_answer", "rich_content": { "title": "Задание: герб" } },
                { "template": "congrats", "rich_content": { "title": "Финал" } }
            ]
        })
    }

    fn stats_fact(kind: FactKind, step: i32, correct: bool) -> Fact {
        Fact {
            kind,
            step_position: step,
            submitted_value: None,
            local_is_correct: correct,
            coins_delta: 0,
            note: None,
            device_id: "d1".to_string(),
        }
    }

    /// Publish q1, grant it to p1, run one attempt to completion. Everything is
    /// stamped «now», so today's range covers all events.
    async fn seed_stats_fixture(state: &AppState) {
        state
            .grants
            .register_published(
                "q1",
                stats_meta("q1", "Тайны старого города"),
                Some(stats_snapshot()),
            )
            .await
            .expect("publish");
        state
            .grants
            .create_grant_idemp("p1", "q1", grants::GrantSource::Payment, None)
            .await
            .expect("grant");
        let att = state
            .store
            .create_attempt("p1", "q1", "q1-v1")
            .await
            .expect("attempt");
        state
            .store
            .append_idempotent(
                &att.attempt_id,
                vec![
                    stats_fact(FactKind::PhysicalConfirmed, 0, false),
                    stats_fact(FactKind::AnswerSubmitted, 1, true),
                    stats_fact(FactKind::AttemptCompleted, 2, false),
                    // A second completion at another position is a legal store
                    // state (natural key includes step_position). «Завершено»
                    // must still count the ATTEMPT once, not the facts.
                    stats_fact(FactKind::AttemptCompleted, 3, false),
                ],
            )
            .await
            .expect("append")
            .expect("known attempt");
    }

    #[tokio::test]
    async fn admin_stats_fails_closed_without_credentials() {
        let app = test_app();
        for uri in ["/api/admin/stats", "/api/admin/stats/q1"] {
            let (st, _) = get_json(&app, uri).await;
            assert_eq!(st, StatusCode::FORBIDDEN, "{uri} without token");
            let (st, _) = get_json_h(&app, uri, &[("x-admin-token", "wrong")]).await;
            assert_eq!(st, StatusCode::FORBIDDEN, "{uri} wrong token");
        }
        // No secret configured at all: fail closed too.
        let (st, _) = get_json(
            &TestApp {
                admin_token: false,
                ..TestApp::default()
            }
            .build()
            .0,
            "/api/admin/stats",
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn admin_stats_overview_counts_daily_and_quests() {
        let state = test_state(test_config());
        seed_stats_fixture(&state).await;
        let app = build_router(state);
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        let today = store::today_utc();

        // Bounded range: totals + zero prev + one daily point + the quest row.
        let uri = format!("/api/admin/stats?from={today}&to={today}");
        let (st, v) = get_json_h(&app, &uri, &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            v["totals"],
            json!({ "purchased": 1, "started": 1, "finished": 1 })
        );
        assert_eq!(
            v["prev"],
            json!({ "purchased": 0, "started": 0, "finished": 0 })
        );
        let daily = v["daily"].as_array().expect("daily");
        assert_eq!(daily.len(), 1);
        assert_eq!(daily[0]["date"], json!(today));
        assert_eq!(daily[0]["started"], json!(1));
        assert_eq!(daily[0]["finished"], json!(1));
        let quests = v["quests"].as_array().expect("quests");
        assert_eq!(quests.len(), 1);
        assert_eq!(quests[0]["quest_id"], json!("q1"));
        assert_eq!(quests[0]["name"], json!("Тайны старого города"));
        assert_eq!(quests[0]["pages"], json!(3));
        assert_eq!(quests[0]["purchased"], json!(1));

        // «Всё время»: no prev, range anchored at the earliest event (today).
        let (st, v) = get_json_h(&app, "/api/admin/stats", &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["prev"], Value::Null);
        assert_eq!(v["from"], json!(today));
        assert_eq!(v["to"], json!(today));
    }

    #[tokio::test]
    async fn admin_stats_quest_detail_returns_labelled_funnel() {
        let state = test_state(test_config());
        seed_stats_fixture(&state).await;
        let app = build_router(state);
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        let (st, v) = get_json_h(&app, "/api/admin/stats/q1", &admin).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["quest_id"], json!("q1"));
        assert_eq!(v["snapshot_id"], json!("q1-v1"));
        assert_eq!(v["funnel_started"], json!(1));
        assert_eq!(v["totals"]["finished"], json!(1));
        let funnel = v["funnel"].as_array().expect("funnel");
        assert_eq!(funnel.len(), 3);
        assert_eq!(funnel[0]["title"], json!("Старт: у башни"));
        assert_eq!(funnel[0]["template"], json!("start"));
        // The single attempt completed everything: every step reached.
        for step in funnel {
            assert_eq!(step["reached"], json!(1), "step {}", step["position"]);
        }

        // Unknown quest: honest 404.
        let (st, _) = get_json_h(&app, "/api/admin/stats/nope", &admin).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }

    // ---------------- content moderation (Отзывы + Обратная связь) ----------------

    fn mod_snapshot() -> Value {
        json!({
            "snapshot_version": 1,
            "steps": [
                { "template": "start", "rich_content": { "title": "Старт" } },
                { "template": "task_answer", "rich_content": { "title": "Фонтан у театра" } },
                { "template": "congrats", "rich_content": { "title": "Финал" } }
            ]
        })
    }

    fn rate_fact(stars: &str, text: Option<&str>) -> Fact {
        Fact {
            kind: FactKind::QuestRated,
            step_position: 2,
            submitted_value: Some(stars.into()),
            local_is_correct: true,
            coins_delta: 0,
            note: text.map(str::to_string),
            device_id: "d".into(),
        }
    }

    fn report_fact(note: &str) -> Fact {
        Fact {
            kind: FactKind::FeedbackReported,
            step_position: 1,
            submitted_value: None,
            local_is_correct: true,
            coins_delta: 0,
            note: Some(note.into()),
            device_id: "d".into(),
        }
    }

    /// Publish q1 and seed four raters (google / email / telegram / anon) plus three
    /// reporters on step 1, each with a distinct identity kind.
    async fn seed_moderation(state: &AppState) {
        state
            .grants
            .register_published(
                "q1",
                stats_meta("q1", "Ирония судьбы"),
                Some(mod_snapshot()),
            )
            .await
            .expect("publish");
        state
            .auth
            .create_social_account(
                "acct-google",
                Some("anna@gmail.com".into()),
                Some("Анна".into()),
                None,
            )
            .await
            .expect("google account");
        state
            .auth
            .create_identity(store::AuthIdentity {
                method: "google".into(),
                identifier: "g1".into(),
                user_id: "acct-google".into(),
                handle: None,
                created_at: 0,
            })
            .await
            .expect("google identity");
        state
            .auth
            .create_social_account(
                "acct-email",
                Some("igor@mail.ru".into()),
                Some("Игорь".into()),
                None,
            )
            .await
            .expect("email account");
        state
            .auth
            .create_social_account("acct-tg", None, Some("Milan".into()), None)
            .await
            .expect("telegram account");
        state
            .auth
            .create_identity(store::AuthIdentity {
                method: "telegram".into(),
                identifier: "t1".into(),
                user_id: "acct-tg".into(),
                handle: Some("milan_bg".into()),
                created_at: 0,
            })
            .await
            .expect("telegram identity");

        for (pid, fact) in [
            ("acct-google", rate_fact("5", Some("Отлично"))),
            ("acct-email", rate_fact("4", Some("Норм"))),
            ("acct-tg", rate_fact("5", Some("Супер"))),
            ("dev-anon", rate_fact("2", None)), // star-only, anonymous
        ] {
            seed_fact(state, pid, "q1", "q1-v1", fact).await;
        }
        for (pid, note) in [
            ("acct-email", "Ответ не принят"),
            ("acct-tg", "not accepted"),
            ("dev-anon", "баг"),
        ] {
            seed_fact(state, pid, "q1", "q1-v1", report_fact(note)).await;
        }
    }

    #[tokio::test]
    async fn admin_reviews_list_identities_star_only_and_hide_from_average() {
        let state = test_state(test_config());
        seed_moderation(&state).await;
        let app = build_router(state);
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        let (st, v) = get_json_h(&app, "/api/admin/reviews", &admin).await;
        assert_eq!(st, StatusCode::OK);
        let reviews = v["reviews"].as_array().expect("reviews");
        assert_eq!(
            reviews.len(),
            4,
            "one row per (player, quest), star-only included"
        );
        assert_eq!(reviews[0]["rating"], json!(2), "worst first");
        assert_eq!(
            reviews[0]["text"],
            Value::Null,
            "a star-only rating has no text"
        );
        assert_eq!(reviews[0]["identity"]["kind"], json!("anon"));
        let by_kind = |k: &str| {
            reviews
                .iter()
                .find(|r| r["identity"]["kind"] == json!(k))
                .unwrap_or_else(|| panic!("no {k} review"))
        };
        assert_eq!(
            by_kind("telegram")["identity"]["telegram_username"],
            json!("milan_bg")
        );
        assert!(by_kind("telegram")["identity"]["email"].is_null());
        assert_eq!(
            by_kind("google")["identity"]["email"],
            json!("anna@gmail.com")
        );
        assert_eq!(by_kind("email")["identity"]["email"], json!("igor@mail.ru"));
        assert_eq!(by_kind("google")["quest_name"], json!("Ирония судьбы"));
        assert!(reviews.iter().all(|r| r["hidden"] == json!(false)));

        // Product page average over all four: (5 + 4 + 5 + 2) / 4 = 4.0, count 4.
        let (_, p) = get_json(&app, "/api/quests/q1").await;
        assert_eq!(p["rating_count"], json!(4));
        assert!((p["rating_avg"].as_f64().expect("avg") - 4.0).abs() < 1e-9);

        // Hide the anonymous 2★ → dropped from the average and flagged; idempotent.
        let hide = json!({ "user_id": "dev-anon", "quest_id": "q1" });
        for _ in 0..2 {
            let (st, _) = post_json_h(&app, "/api/admin/reviews/hide", hide.clone(), &admin).await;
            assert_eq!(st, StatusCode::NO_CONTENT);
        }
        let (_, p) = get_json(&app, "/api/quests/q1").await;
        assert_eq!(p["rating_count"], json!(3));
        assert!(
            (p["rating_avg"].as_f64().expect("avg") - 14.0 / 3.0).abs() < 1e-9,
            "hidden 2★ dropped from the average"
        );
        let (_, v) = get_json_h(&app, "/api/admin/reviews", &admin).await;
        assert!(
            v["reviews"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["identity"]["kind"] == json!("anon") && r["hidden"] == json!(true))
        );

        // Unhide restores the average.
        let (st, _) = post_json_h(&app, "/api/admin/reviews/unhide", hide, &admin).await;
        assert_eq!(st, StatusCode::NO_CONTENT);
        let (_, p) = get_json(&app, "/api/quests/q1").await;
        assert_eq!(p["rating_count"], json!(4));
        assert!((p["rating_avg"].as_f64().expect("avg") - 4.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn admin_feedback_groups_resolve_and_reopen_on_new_report() {
        let state = test_state(test_config());
        seed_moderation(&state).await;
        let app = build_router(state.clone());
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        let (st, v) = get_json_h(&app, "/api/admin/feedback", &admin).await;
        assert_eq!(st, StatusCode::OK);
        let groups = v["groups"].as_array().expect("groups");
        assert_eq!(groups.len(), 1, "one (quest, snapshot, step) group");
        let g = &groups[0];
        assert_eq!(g["quest_id"], json!("q1"));
        assert_eq!(g["snapshot_id"], json!("q1-v1"));
        assert_eq!(g["step_position"], json!(1));
        assert_eq!(g["step_title"], json!("Фонтан у театра"));
        assert_eq!(g["step_template"], json!("task_answer"));
        assert_eq!(g["version"], json!(1));
        assert_eq!(g["current"], json!(true));
        assert_eq!(g["quest_name"], json!("Ирония судьбы"));
        assert_eq!(g["resolved"], json!(false));
        assert_eq!(g["reports"].as_array().unwrap().len(), 3);
        assert!(
            g["reports"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["identity"]["telegram_username"] == json!("milan_bg"))
        );

        let key = json!({ "quest_id": "q1", "snapshot_id": "q1-v1", "step_position": 1 });
        let (st, _) = post_json_h(&app, "/api/admin/feedback/resolve", key.clone(), &admin).await;
        assert_eq!(st, StatusCode::NO_CONTENT);
        let (_, v) = get_json_h(&app, "/api/admin/feedback", &admin).await;
        assert_eq!(v["groups"][0]["resolved"], json!(true));

        // A NEW report pushes the count past the acknowledged watermark → reopens.
        seed_fact(
            &state,
            "acct-email",
            "q1",
            "q1-v1",
            report_fact("ещё раз не работает"),
        )
        .await;
        let (_, v) = get_json_h(&app, "/api/admin/feedback", &admin).await;
        assert_eq!(
            v["groups"][0]["resolved"],
            json!(false),
            "a later report reopens the group"
        );
        assert_eq!(v["groups"][0]["reports"].as_array().unwrap().len(), 4);

        // Resolve again, then a manual reopen with no new report.
        let _ = post_json_h(&app, "/api/admin/feedback/resolve", key.clone(), &admin).await;
        let (_, v) = get_json_h(&app, "/api/admin/feedback", &admin).await;
        assert_eq!(v["groups"][0]["resolved"], json!(true));
        let (st, _) = post_json_h(&app, "/api/admin/feedback/reopen", key, &admin).await;
        assert_eq!(st, StatusCode::NO_CONTENT);
        let (_, v) = get_json_h(&app, "/api/admin/feedback", &admin).await;
        assert_eq!(v["groups"][0]["resolved"], json!(false));
    }

    /// Register a constructor row (the authoring registry) with an authored city
    /// in its body. Registers NOTHING in the catalog — publishing is a separate
    /// act, which is the whole point of the callers below.
    async fn seed_authoring_row(
        state: &AppState,
        quest_id: &str,
        name: &str,
        city: &str,
        status: &str,
    ) {
        state
            .constructor
            .create(ConstructorQuest {
                quest_id: quest_id.to_string(),
                author_id: "bubble:import".into(),
                author_name: "Импорт".into(),
                name: name.to_string(),
                status: status.to_string(),
                cover: None,
                steps_count: 3,
                attrs: store::QuestAttributes::default(),
                created_at: 1,
                updated_at: 1,
                body: json!({ "id": quest_id, "meta": { "city": city } }),
            })
            .await
            .expect("constructor row");
    }

    /// Append one fact on a fresh attempt, straight through the store. Attempt
    /// creation via the API needs a published snapshot; the store does not, which
    /// is what lets these tests reach states a live deployment arrives at by
    /// import or restore.
    async fn seed_fact(
        state: &AppState,
        player: &str,
        quest_id: &str,
        snapshot_id: &str,
        fact: Fact,
    ) {
        let a = state
            .store
            .create_attempt(player, quest_id, snapshot_id)
            .await
            .expect("attempt");
        state
            .store
            .append_idempotent(&a.attempt_id, vec![fact])
            .await
            .expect("append")
            .expect("known attempt");
    }

    /// Rate and report on `quest_id` as `player` — the fact log outlives any
    /// catalog row, which is exactly the state an imported deployment is in.
    async fn seed_play(state: &AppState, player: &str, quest_id: &str, snapshot_id: &str) {
        for fact in [rate_fact("1", Some("не понравилось")), report_fact("баг")] {
            seed_fact(state, player, quest_id, snapshot_id, fact).await;
        }
    }

    /// A quest that was NEVER published — an imported draft — still has to be
    /// nameable everywhere the back office lists it. Before the label seam these
    /// surfaces read `published_quests` and printed the raw quest id.
    #[tokio::test]
    async fn admin_surfaces_name_a_quest_that_was_never_published() {
        let state = test_state(test_config());
        seed_authoring_row(
            &state,
            "bubble-1755",
            "Пузырь",
            " Нови Сад ",
            store::CTOR_STATUS_DRAFT,
        )
        .await;
        seed_play(&state, "dev-anon", "bubble-1755", "bubble-1755-v1").await;
        let app = build_router(state);
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];

        let (st, v) = get_json_h(&app, "/api/admin/reviews", &admin).await;
        assert_eq!(st, StatusCode::OK);
        let review = &v["reviews"][0];
        assert_eq!(review["quest_id"], json!("bubble-1755"));
        assert_eq!(review["quest_name"], json!("Пузырь"), "not the raw id");
        assert_eq!(
            review["quest_city"],
            json!("Нови Сад"),
            "authored city, trimmed"
        );

        let (st, v) = get_json_h(&app, "/api/admin/feedback", &admin).await;
        assert_eq!(st, StatusCode::OK);
        let group = &v["groups"][0];
        assert_eq!(group["quest_name"], json!("Пузырь"));
        assert_eq!(group["quest_city"], json!("Нови Сад"));
        assert_eq!(
            group["current"],
            json!(false),
            "no published version, so no group is the current one"
        );

        let (st, v) = get_json_h(&app, "/api/admin/stats", &admin).await;
        assert_eq!(st, StatusCode::OK);
        let row = v["quests"]
            .as_array()
            .expect("quests")
            .iter()
            .find(|r| r["quest_id"] == json!("bubble-1755"))
            .expect("the played quest has a row");
        assert_eq!(row["name"], json!("Пузырь"));
        assert_eq!(row["city"], json!("Нови Сад"));
        assert_eq!(row["published"], json!(false));
    }

    #[tokio::test]
    async fn moderation_endpoints_require_admin() {
        let state = test_state(test_config());
        seed_moderation(&state).await;
        let app = build_router(state);
        let key = json!({ "quest_id": "q1", "snapshot_id": "q1-v1", "step_position": 1 });
        let hide = json!({ "user_id": "dev-anon", "quest_id": "q1" });
        for uri in ["/api/admin/reviews", "/api/admin/feedback"] {
            let (st, _) = get_json(&app, uri).await;
            assert_eq!(st, StatusCode::FORBIDDEN, "{uri} without admin");
            let (st, _) = get_json_h(&app, uri, &[("x-admin-token", "wrong")]).await;
            assert_eq!(st, StatusCode::FORBIDDEN, "{uri} wrong token");
        }
        for (uri, body) in [
            ("/api/admin/reviews/hide", hide.clone()),
            ("/api/admin/reviews/unhide", hide),
            ("/api/admin/feedback/resolve", key.clone()),
            ("/api/admin/feedback/reopen", key),
        ] {
            let (st, _) = post_json(&app, uri, body).await;
            assert_eq!(st, StatusCode::FORBIDDEN, "{uri} without admin");
        }
        // The admin token unlocks the same read.
        let (st, _) = get_json_h(
            &app,
            "/api/admin/reviews",
            &[("x-admin-token", TEST_ADMIN_TOKEN)],
        )
        .await;
        assert_eq!(st, StatusCode::OK);
    }

    #[tokio::test]
    async fn admin_stats_rejects_malformed_ranges() {
        let app = test_app();
        let admin = [("x-admin-token", TEST_ADMIN_TOKEN)];
        for uri in [
            "/api/admin/stats?from=2026-99-01&to=2026-07-16",
            "/api/admin/stats?from=garbage",
            "/api/admin/stats?to=2026-02-30",
            "/api/admin/stats?from=2026-07-16&to=2026-07-10",
        ] {
            let (st, _) = get_json_h(&app, uri, &admin).await;
            assert_eq!(st, StatusCode::BAD_REQUEST, "{uri}");
        }
    }
}
