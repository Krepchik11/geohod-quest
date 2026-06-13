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

        Ok(Self {
            addr,
            version: env!("CARGO_PKG_VERSION"),
            admin_token,
        })
    }
}
