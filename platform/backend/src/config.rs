use std::net::SocketAddr;

/// Application configuration loaded from environment.
///
/// All values have safe defaults suitable for local development.
/// Production deployments should override via environment variables.
#[derive(Debug, Clone)]
pub struct AppConfig {
    /// Address the HTTP server will bind to.
    pub addr: SocketAddr,
    /// Human readable application version (from Cargo).
    pub version: &'static str,
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

        let admin_token = std::env::var("ADMIN_TOKEN")
            .ok()
            .filter(|t| !t.trim().is_empty());

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

        let smtp_url = std::env::var("SMTP_URL")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let mail_from = std::env::var("MAIL_FROM")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "GEOHOD QUEST <no-reply@geohod.ru>".to_string());
        let frontend_base = std::env::var("FRONTEND_BASE")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "http://localhost:3000".to_string());

        let env_opt = |k: &str| std::env::var(k).ok().filter(|s| !s.trim().is_empty());
        let google_client_id = env_opt("GOOGLE_CLIENT_ID");
        let telegram_client_id = env_opt("TELEGRAM_CLIENT_ID");

        Ok(Self {
            addr,
            version: env!("CARGO_PKG_VERSION"),
            admin_token,
            cors_allowed_origins,
            media,
            smtp_url,
            mail_from,
            frontend_base,
            google_client_id,
            telegram_client_id,
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
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
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
