use std::net::SocketAddr;

/// A non-empty environment variable ("" and whitespace read as unset).
fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// Reported when the process runs outside a released image (local `cargo run`,
/// tests, a hand-built container). A released image always carries a hex content
/// id, so this value can never be mistaken for one by the release gate.
pub const UNRELEASED_BUILD_ID: &str = "dev";

/// Resolves [`AppConfig::build_id`] from the raw `BUILD_ID` env value.
///
/// Split out so the fallback is unit-testable without mutating process env
/// (which races across parallel tests).
pub fn build_id_from(raw: Option<&str>) -> String {
    raw.map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(UNRELEASED_BUILD_ID)
        .to_string()
}

/// Application configuration loaded from environment.
///
/// All values have safe defaults suitable for local development.
/// Production deployments should override via environment variables.
#[derive(Debug, Clone)]
pub struct AppConfig {
    /// Address the HTTP server will bind to.
    pub addr: SocketAddr,
    /// Content identity of the image serving this process, baked in at image
    /// build time (`BUILD_ID`, set by `backend/Containerfile`'s `ARG BUILD_ID`).
    ///
    /// This is the deployment's ONLY identity, and it replaced the crate version
    /// that `/health` used to report. That version was written once at the first
    /// commit of the repository and never bumped again, so it answered "is my
    /// change live?" with the same string forever — a constant shaped like a
    /// deploy identity, which is worse than none. Anything hand-maintained decays
    /// into that; a derived id cannot.
    ///
    /// It is a hash of the sources the image is built from — NOT the commit sha —
    /// so it changes exactly when the backend changes. That is what makes the
    /// release gate correct for every commit: a frontend-only commit leaves it
    /// untouched, so `.github/workflows/release.yml` observes the expected id
    /// immediately instead of waiting for a redeploy that will never happen (and
    /// the identical image means podman never needlessly restarts the unit).
    /// [`UNRELEASED_BUILD_ID`] outside a released image.
    pub build_id: String,
    /// Shared secret for admin-only endpoints (stats/feedbacks/migration).
    /// When `None` (env `ADMIN_TOKEN` unset) those endpoints are disabled
    /// (fail-closed) — they expose aggregate telemetry and raw feedback notes.
    pub admin_token: Option<String>,
    /// Browser origins allowed by CORS, from `CORS_ALLOWED_ORIGINS` (comma
    /// separated). Each entry is either an exact origin
    /// (`https://app.example.com`) or a single-`*` wildcard
    /// (`https://*.vercel.app`). When EMPTY (env unset), CORS reflects any
    /// origin — convenient for local dev, but production MUST set this.
    pub cors_allowed_origins: Vec<String>,
    /// Media-storage backend: Cloudflare R2 in production, an in-process store
    /// otherwise (tests / local dev).
    pub media: MediaConfig,
    /// Transactional-mail SMTP url (`smtps://user:pass@host[:port]`); None →
    /// mails are logged instead of sent (dev/staging).
    pub smtp_url: Option<String>,
    /// From address for transactional mail.
    pub mail_from: String,
    /// Public frontend origin used in emailed links (reset/confirm).
    pub frontend_base: String,
    /// Google OAuth client id ("Sign in with Google"). `None` (env
    /// `GOOGLE_CLIENT_ID` unset) → `/api/auth/google` is disabled (501, fail-closed).
    /// The ID token's `aud` MUST equal this value.
    pub google_client_id: Option<String>,
    /// Telegram bot **Client ID** (the bot id) from BotFather → Bot Settings → Web
    /// Login. This is the `aud` an OIDC id_token MUST carry, and the public value
    /// the frontend passes to `Telegram.Login.init` to render the login button.
    /// `None` (env `TELEGRAM_CLIENT_ID` unset) → `/api/auth/telegram` is disabled
    /// (501, fail-closed). Public (not a secret): id_token verification is against
    /// Telegram's public JWKS, so no bot token/secret is needed.
    pub telegram_client_id: Option<String>,
    /// YooKassa shop credentials. `None` (env unset) → `provider=yookassa`
    /// checkouts are disabled (501, fail-closed); the mock provider remains.
    pub yookassa: Option<YookassaConfig>,
}

/// YooKassa credentials, resolved all-or-nothing from `YOOKASSA_SHOP_ID` +
/// `YOOKASSA_SECRET_KEY` (a partial set is a misconfiguration and is logged
/// loudly — MediaConfig pattern). `YOOKASSA_API_BASE` points the client at a
/// local mock in tests; never set in production.
#[derive(Debug, Clone)]
pub struct YookassaConfig {
    pub shop_id: String,
    pub secret_key: String,
    pub api_base: String,
}

impl YookassaConfig {
    fn from_env() -> Option<Self> {
        match (env_opt("YOOKASSA_SHOP_ID"), env_opt("YOOKASSA_SECRET_KEY")) {
            (Some(shop_id), Some(secret_key)) => Some(Self {
                shop_id,
                secret_key,
                api_base: env_opt("YOOKASSA_API_BASE")
                    .map(|b| b.trim_end_matches('/').to_string())
                    .unwrap_or_else(|| crate::yookassa::DEFAULT_API_BASE.to_string()),
            }),
            (None, None) => None,
            _ => {
                tracing::warn!(
                    "YooKassa partially configured — set BOTH YOOKASSA_SHOP_ID and \
                     YOOKASSA_SECRET_KEY to enable card payments. Falling back to \
                     mock-only checkout."
                );
                None
            }
        }
    }
}

impl AppConfig {
    /// Load configuration from environment, falling back to development defaults.
    ///
    /// Respects .env files via dotenvy (loaded by caller before this).
    ///
    /// # Errors
    ///
    /// Returns error if PORT is present but not a valid u16 or the resulting
    /// socket address cannot be constructed.
    pub fn from_env() -> Result<Self, anyhow::Error> {
        let port: u16 = std::env::var("PORT")
            .ok()
            .map(|s| s.parse())
            .transpose()?
            .unwrap_or(8080);

        let addr: SocketAddr = format!("0.0.0.0:{port}").parse()?;

        let admin_token = env_opt("ADMIN_TOKEN");

        let cors_allowed_origins = std::env::var("CORS_ALLOWED_ORIGINS")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();

        let media = MediaConfig::from_env(port);

        let smtp_url = env_opt("SMTP_URL");
        let mail_from =
            env_opt("MAIL_FROM").unwrap_or_else(|| "GEOHOD QUEST <no-reply@geohod.ru>".to_string());
        let frontend_base =
            env_opt("FRONTEND_BASE").unwrap_or_else(|| "http://localhost:3000".to_string());

        let google_client_id = env_opt("GOOGLE_CLIENT_ID");
        let telegram_client_id = env_opt("TELEGRAM_CLIENT_ID");
        let yookassa = YookassaConfig::from_env();

        Ok(Self {
            addr,
            build_id: build_id_from(env_opt("BUILD_ID").as_deref()),
            admin_token,
            cors_allowed_origins,
            media,
            smtp_url,
            mail_from,
            frontend_base,
            google_client_id,
            telegram_client_id,
            yookassa,
        })
    }
}

/// Media-storage configuration, resolved from env at startup.
///
/// `R2` when the full Cloudflare R2 credential set is present (production);
/// otherwise `Local` — an in-process store that serves uploads back through the
/// API at `/api/media/{hash}`, zero-infra for tests and local dev (mirroring how
/// storage falls back to in-memory without `DATABASE_URL`).
#[derive(Debug, Clone)]
pub enum MediaConfig {
    R2 {
        account_id: String,
        access_key_id: String,
        secret_access_key: String,
        bucket: String,
        /// Public base the bucket is served from; refs are `"{public_base}/{hash}"`.
        /// With a custom domain that is the domain (e.g. `https://media.quest...`);
        /// without one it is the API's own serve route (`https://api.../api/media`),
        /// which streams bytes via `GET /api/media/{hash}`.
        public_base: String,
        /// Optional S3 endpoint override (`R2_ENDPOINT`). `None` → the account
        /// endpoint `https://{account_id}.r2.cloudflarestorage.com`. Set only to
        /// point at a local S3 mock (MinIO) in tests; never set in production.
        endpoint: Option<String>,
    },
    Local {
        /// Absolute base the in-process store builds refs against, so the browser
        /// can fetch cross-origin from the API (e.g. `http://localhost:8080/api/media`).
        public_base: String,
    },
}

impl MediaConfig {
    /// Resolve from `R2_*` env. All five of `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
    /// `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` / `R2_PUBLIC_BASE_URL` present → `R2`;
    /// none → `Local`. A PARTIAL set is almost certainly a misconfiguration that
    /// would silently disable R2 in production, so it is logged loudly before
    /// falling back to `Local`.
    fn from_env(port: u16) -> Self {
        let var = env_opt;
        // Strip trailing '/' so refs built as "{base}/{hash}" never double-slash.
        let trim = |s: String| s.trim_end_matches('/').to_string();

        let r2 = [
            "R2_ACCOUNT_ID",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "R2_BUCKET",
            "R2_PUBLIC_BASE_URL",
        ]
        .map(&var);
        let set = r2.iter().filter(|v| v.is_some()).count();
        if let [
            Some(account_id),
            Some(access_key_id),
            Some(secret_access_key),
            Some(bucket),
            Some(public_base),
        ] = r2
        {
            return Self::R2 {
                account_id,
                access_key_id,
                secret_access_key,
                bucket,
                public_base: trim(public_base),
                // Independent of the 5 required vars; absent in production.
                endpoint: var("R2_ENDPOINT"),
            };
        }

        if set > 0 {
            tracing::warn!(
                "R2 media storage partially configured ({set}/5 R2_* vars) — falling \
                 back to in-process media. Set ALL of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, \
                 R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL to enable R2."
            );
        }

        let public_base = var("MEDIA_PUBLIC_BASE_URL")
            .unwrap_or_else(|| format!("http://localhost:{port}/api/media"));
        Self::Local {
            public_base: trim(public_base),
        }
    }
}
