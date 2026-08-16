//! Account routes: register/login, social auth (Google/Telegram), identify/
//! recover/reset/confirm/resend (§6), account management (display name,
//! password, unlink, delete), linked-provider listing, and the profile read.

use axum::{
    Router,
    extract::State,
    http::HeaderMap,
    response::Json,
    routing::{get, post},
};

use crate::authz::{claimed_from_headers, resolve_user, session_account};
use crate::errors::AppError;
use crate::features::Feature;
use crate::features::feature_enabled;
use crate::{AppState, auth, mailer, media, social, store};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/register", post(register_handler))
        .route("/api/auth/identify", post(identify_handler))
        .route("/api/auth/recover", post(recover_handler))
        .route("/api/auth/reset", post(reset_password_handler))
        .route("/api/auth/confirm", post(confirm_email_handler))
        .route("/api/auth/confirm/resend", post(resend_confirm_handler))
        .route("/api/auth/email", post(change_email_handler))
        .route("/api/auth/change-password", post(change_password_handler))
        .route("/api/auth/display-name", post(set_display_name_handler))
        .route("/api/auth/delete-account", post(delete_account_handler))
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/google", post(google_auth_handler))
        .route("/api/auth/telegram", post(telegram_auth_handler))
        .route("/api/auth/unlink", post(unlink_handler))
        .route("/api/auth/providers", get(auth_providers_handler))
        .route("/api/users/me", get(get_me_handler))
}

/// Body for POST /api/auth/register: attaches credentials to the caller's
/// existing anonymous player id (the id never changes — zero migration).
#[derive(serde::Deserialize)]
struct RegisterRequest {
    user_id: String,
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
    user_id: String,
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
    if req.user_id.is_empty() {
        return Err(AppError::BadRequest("user_id is required".into()));
    }
    let password_hash = auth::hash_password(&req.password)?;
    let account = state
        .auth
        .register_user(&req.user_id, &email, &password_hash, req.display_name)
        .await?;
    let token = auth::generate_token();
    state.auth.create_session(&token, &account.user_id).await?;
    // §6.3 soft confirmation: the account works immediately; the mail is
    // best-effort and the Profile banner offers a resend.
    send_confirm_email(&state, &account.user_id, &email).await?;
    Ok(Json(AuthResponse {
        user_id: account.user_id,
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
    // A social-only account (no password set) rejects like a wrong password.
    let password_ok = record
        .password_hash
        .as_deref()
        .is_some_and(|hash| auth::verify_password(hash, &req.password));
    if !password_ok {
        return Err(bad());
    }
    let token = auth::generate_token();
    state
        .auth
        .create_session(&token, &record.account.user_id)
        .await?;
    Ok(Json(AuthResponse {
        user_id: record.account.user_id,
        email: record.account.email,
        display_name: record.account.display_name,
        role: record.account.role,
        token,
    }))
}

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
    /// Telegram `@username` (handle, no `@`); `None` for Google and for a
    /// handleless Telegram user. Persisted so admins get a `t.me/<handle>` contact.
    handle: Option<String>,
}

/// POST /api/auth/google — `{credential, user_id}` where `credential` is a
/// Google Identity Services ID token. Fail-closed (501) when unconfigured.
#[derive(serde::Deserialize)]
struct GoogleAuthRequest {
    credential: String,
    user_id: String,
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
        handle: None,
    };
    complete_social_login(&state, &headers, &req.user_id, ident)
        .await
        .map(Json)
}

/// POST /api/auth/telegram — `{id_token, user_id}` where `id_token` is the OIDC
/// JWT that `telegram-login.js` returns. Fail-closed (501) when unconfigured.
#[derive(serde::Deserialize)]
struct TelegramAuthRequest {
    id_token: String,
    user_id: String,
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
        handle: claims.preferred_username.clone(),
    };
    complete_social_login(&state, &headers, &req.user_id, ident)
        .await
        .map(Json)
}

/// Link a verified social identity to an account and return a fresh session,
/// preserving the caller's anonymous user_id where possible (player-identity
/// spec): (1) an already-linked identity logs into its account — unless the
/// caller is logged into a DIFFERENT account, which is a 409, never a silent
/// account switch; (2) a logged-in caller links it to their account; (3) a
/// Google-verified email links to the matching existing account; (4) otherwise
/// it attaches to the anonymous id, creating an account there so prior
/// coins/grants survive.
async fn complete_social_login(
    state: &AppState,
    headers: &HeaderMap,
    claimed_user_id: &str,
    ident: SocialIdentity,
) -> Result<AuthResponse, AppError> {
    /// The 409 for an identity owned by a different account than the caller's.
    const FOREIGN_IDENTITY: &str = "этот способ входа уже привязан к другому аккаунту";

    let session = session_account(state, headers).await?;

    // 1. Existing identity → login to that account (any device). A logged-in
    // caller whose session is another account gets a conflict: honoring the
    // login would drop them into the identity's account while the profile UI
    // reports a successful "link" that never happened.
    if let Some(pid) = state
        .auth
        .find_identity(ident.provider, &ident.subject)
        .await?
    {
        if session.as_ref().is_some_and(|a| a.user_id != pid) {
            return Err(AppError::Conflict(FOREIGN_IDENTITY.into()));
        }
        // Keep a re-used identity's stored contact current (e.g. a changed
        // Telegram @username); an absent claim leaves the prior value untouched.
        state
            .auth
            .set_identity_handle(ident.provider, &ident.subject, ident.handle.clone())
            .await?;
        return issue_session_for(state, &pid).await;
    }

    // Choose the account to attach the NEW identity to.
    let target = if let Some(account) = session {
        // 2. Logged-in caller → link to their account.
        account.user_id
    } else if ident.email_verified
        && let Some(email) = ident.email.as_ref()
        && let Some(record) = state.auth.find_by_email(email).await?
    {
        // 3. Verified provider email matches an existing account → link to it.
        record.account.user_id
    } else {
        // 4. Attach to the caller's anonymous id (creating an account there).
        create_social_on_claimed(state, headers, claimed_user_id, &ident).await?
    };

    // Link the identity. A concurrent duplicate is absorbed as a login below.
    match state
        .auth
        .create_identity(store::AuthIdentity {
            method: ident.provider.to_string(),
            identifier: ident.subject.clone(),
            user_id: target.clone(),
            handle: ident.handle.clone(),
            created_at: store::now_secs(),
        })
        .await
    {
        Ok(()) => {}
        // The store says WHICH invariant rejected the link (typed constants).
        // UNIQUE (user_id, method): the target account already links a
        // DIFFERENT identity of this provider.
        Err(AppError::Conflict(msg)) if msg == store::CONFLICT_METHOD_TAKEN => {
            return Err(AppError::Conflict(
                "к аккаунту уже привязан другой аккаунт этого провайдера".into(),
            ));
        }
        // (method, identifier) was already owned at insert time. Absorb as a
        // login only when a racing request linked it to OUR target account;
        // any other owner is the same foreign-identity conflict as above.
        Err(AppError::Conflict(_)) => {
            let owner = state
                .auth
                .find_identity(ident.provider, &ident.subject)
                .await?;
            if owner.as_deref() != Some(target.as_str()) {
                return Err(AppError::Conflict(FOREIGN_IDENTITY.into()));
            }
        }
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
/// token — the exact resolve_user invariant), then create a social account keyed
/// to it so prior grants/coins survive. A taken Google email degrades to no email.
async fn create_social_on_claimed(
    state: &AppState,
    headers: &HeaderMap,
    claimed_user_id: &str,
    ident: &SocialIdentity,
) -> Result<String, AppError> {
    let pid = resolve_user(state, headers, claimed_user_id).await?;
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
        Ok(account) => Ok(account.user_id),
        // The Google email is taken by another account — create without an email;
        // the identity still links, so the user reaches a working account.
        Err(AppError::Conflict(_)) if email.is_some() => {
            let account = state
                .auth
                .create_social_account(&pid, None, ident.display_name.clone(), None)
                .await?;
            Ok(account.user_id)
        }
        Err(e) => Err(e),
    }
}

/// Mint a session for an existing account and shape the standard `AuthResponse`.
async fn issue_session_for(state: &AppState, user_id: &str) -> Result<AuthResponse, AppError> {
    let account = state
        .auth
        .get_user(user_id)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("account not found after link")))?;
    let token = auth::generate_token();
    state.auth.create_session(&token, user_id).await?;
    Ok(AuthResponse {
        user_id: account.user_id,
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
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AuthProviders"))]
pub(crate) struct AuthProviders {
    google_client_id: Option<String>,
    telegram_client_id: Option<String>,
}

async fn auth_providers_handler(
    State(state): State<AppState>,
) -> Result<Json<AuthProviders>, AppError> {
    let overrides = state.flags.all().await?;
    let on = |f: Feature| f.effective(overrides.get(f.key()).copied());
    Ok(Json(AuthProviders {
        google_client_id: on(Feature::AuthGoogle)
            .then(|| state.config.google_client_id.clone())
            .flatten(),
        telegram_client_id: on(Feature::AuthTelegram)
            .then(|| state.config.telegram_client_id.clone())
            .flatten(),
    }))
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
    let identities = state.auth.identities_for_user(&account.user_id).await?;
    // Not-linked is a 404 regardless of the method count — checked first so a
    // no-op unlink never masquerades as the "last method" conflict.
    if !identities.iter().any(|i| i.method == req.provider) {
        return Err(AppError::NotFound("этот способ входа не подключён".into()));
    }
    // The reachability guard (auth::reachable_ways is THE rule; /me serves the
    // same verdict as `can_unlink`, so the UI can never disagree with this 409).
    if auth::reachable_ways(&account, &identities) <= 1 {
        return Err(AppError::Conflict(
            "нельзя отвязать единственный способ входа".into(),
        ));
    }
    state
        .auth
        .delete_identity(&req.provider, &account.user_id)
        .await?;
    Ok(Json(serde_json::json!({ "status": "unlinked" })))
}

/// Password-reset link TTL (30 minutes — stated in the «Письмо ушло» copy).
const RESET_TOKEN_TTL_SECS: u64 = 30 * 60;

/// Email-confirmation link TTL (7 days — soft confirmation, no urgency).
const CONFIRM_TOKEN_TTL_SECS: u64 = 7 * 24 * 3600;

/// §6.1 identify rate limit: requests per fixed window, per email.
const IDENTIFY_LIMIT: u32 = 10;

const IDENTIFY_WINDOW_SECS: u64 = 60;

/// §6.2/§6.3 mail-sending rate limit (recover, resend-confirm), per email.
/// The server is the boundary — the UI cooldown is advisory only.
pub(crate) const MAIL_SEND_LIMIT: u32 = 5;

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
    user_id: &str,
    kind: &str,
    ttl_secs: u64,
    payload: Option<String>,
) -> Result<(String, String), AppError> {
    let token = auth::generate_token();
    let code = auth::generate_reset_code();
    state
        .auth
        .create_auth_token(
            &media::sha256_hex(token.as_bytes()),
            store::AuthTokenRecord {
                user_id: user_id.to_string(),
                kind: kind.to_string(),
                code_hash: media::sha256_hex(code.as_bytes()),
                expires_at: store::now_secs() + ttl_secs,
                used_at: None,
                attempts: 0,
                payload,
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

async fn send_confirm_email(state: &AppState, user_id: &str, email: &str) -> Result<(), AppError> {
    // Confirmation is link-only (§6.3 is soft, nobody types codes for it) —
    // the minted code is simply never mailed, so it is unusable.
    let (token, _code) = issue_auth_token(
        state,
        user_id,
        store::TOKEN_KIND_CONFIRM,
        CONFIRM_TOKEN_TTL_SECS,
        None,
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
                &record.account.user_id,
                store::TOKEN_KIND_RESET,
                RESET_TOKEN_TTL_SECS,
                None,
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
            send_confirm_email(&state, &record.account.user_id, &email).await?;
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
    if !auth::password_valid(&password) {
        return Err(AppError::BadRequest(auth::PASSWORD_ERROR.into()));
    }
    let now = store::now_secs();
    let user_id = match req {
        ResetPasswordRequest::ByToken { token, .. } => state
            .auth
            .consume_auth_token(
                &media::sha256_hex(token.as_bytes()),
                store::TOKEN_KIND_RESET,
                now,
            )
            .await?
            .map(|(user_id, _)| user_id),
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
                            &record.account.user_id,
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
        .set_password(&user_id, &auth::hash_password(&password)?)
        .await?;
    // Using a valid reset credential also proves mailbox ownership (§6.3).
    let account = state.auth.confirm_email(&user_id, now).await?;
    let token = auth::generate_token();
    state.auth.create_session(&token, &user_id).await?;
    Ok(Json(AuthResponse {
        user_id: account.user_id,
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

/// One landing for both mailed links: a first-confirmation token stamps the
/// current address, an email-change token (§6.4) applies its pending NEW
/// address — proved reachable by this very click, so it lands confirmed.
async fn confirm_email_handler(
    State(state): State<AppState>,
    Json(req): Json<ConfirmEmailRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let hash = media::sha256_hex(req.token.as_bytes());
    let now = store::now_secs();
    let account = if let Some((user_id, _)) = state
        .auth
        .consume_auth_token(&hash, store::TOKEN_KIND_CONFIRM, now)
        .await?
    {
        state.auth.confirm_email(&user_id, now).await?
    } else if let Some((user_id, Some(new_email))) = state
        .auth
        .consume_auth_token(&hash, store::TOKEN_KIND_EMAIL_CHANGE, now)
        .await?
    {
        state.auth.replace_email(&user_id, &new_email, now).await?
    } else {
        return Err(AppError::BadRequest(
            "ссылка недействительна или устарела — запросите новую".into(),
        ));
    };
    Ok(Json(
        serde_json::json!({ "status": "confirmed", "email": account.email }),
    ))
}

/// Body for POST /api/auth/email (§6.4 change email).
#[derive(serde::Deserialize)]
struct ChangeEmailRequest {
    new_email: String,
}

/// §6.4 — request an email change (Profile «Изменить почту»). Session-only.
/// Nothing changes until the mailed link is opened FROM THE NEW ADDRESS —
/// that click both proves reachability and applies the change (see
/// [`confirm_email_handler`]). Also how a social-only account gains its first
/// address. The taken-address check up front is a UX courtesy; the store's
/// unique index stays the authority at apply time.
async fn change_email_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChangeEmailRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let account = session_account(&state, &headers)
        .await?
        .ok_or_else(|| AppError::Unauthorized("login required".into()))?;
    let new_email = auth::normalize_email(&req.new_email);
    if !auth::email_valid(&new_email) {
        return Err(AppError::BadRequest("введите корректную почту".into()));
    }
    if account.email.as_deref() == Some(new_email.as_str()) {
        return Err(AppError::BadRequest("это текущий адрес".into()));
    }
    if state.auth.find_by_email(&new_email).await?.is_some() {
        return Err(AppError::Conflict("email is already taken".into()));
    }
    fixed_window_allow(
        &state,
        format!("email-change:{new_email}"),
        MAIL_SEND_WINDOW_SECS,
        MAIL_SEND_LIMIT,
    )?;
    let (token, _code) = issue_auth_token(
        &state,
        &account.user_id,
        store::TOKEN_KIND_EMAIL_CHANGE,
        RESET_TOKEN_TTL_SECS,
        Some(new_email.clone()),
    )
    .await?;
    let link = format!("{}/auth/confirm?token={token}", state.config.frontend_base);
    send_mail_best_effort(
        &state,
        &new_email,
        "Подтвердите новую почту — GEOHOD QUEST",
        &format!(
            "Здравствуйте!\n\nВы попросили привязать этот адрес к аккаунту GEOHOD QUEST — подтвердите по ссылке:\n{link}\n\nЕсли это были не вы, просто игнорируйте это письмо."
        ),
    )
    .await;
    Ok(Json(serde_json::json!({ "status": "sent" })))
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
    // confirm, a confirmed one has nothing left — both: nothing to send.
    let Some(email) = account.unconfirmed_email().map(str::to_string) else {
        return Ok(Json(serde_json::json!({ "status": "already-confirmed" })));
    };
    fixed_window_allow(
        &state,
        format!("confirm:{email}"),
        MAIL_SEND_WINDOW_SECS,
        MAIL_SEND_LIMIT,
    )?;
    send_confirm_email(&state, &account.user_id, &email).await?;
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
    let updated = state.auth.set_display_name(&account.user_id, name).await?;
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
    let record = state
        .auth
        .user_record(&account.user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("login required".into()))?;
    // No password (social-only account, or a Google-attached email whose
    // password was never set) → honest guidance, not a lying "wrong password".
    let Some(hash) = record.password_hash.as_deref() else {
        return Err(AppError::BadRequest(
            "этот аккаунт входит через провайдера — пароль не задан".into(),
        ));
    };
    if !auth::verify_password(hash, &req.current_password) {
        return Err(AppError::Unauthorized("неверный текущий пароль".into()));
    }
    if !auth::password_valid(&req.new_password) {
        return Err(AppError::BadRequest(auth::PASSWORD_ERROR.into()));
    }
    state
        .auth
        .set_password(&account.user_id, &auth::hash_password(&req.new_password)?)
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
        .list_summaries_for_author(&account.user_id)
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
    state.store.delete_user_data(&account.user_id).await?;
    state
        .grants
        .delete_grants_for_user(&account.user_id)
        .await?;
    state.auth.delete_user(&account.user_id).await?;
    Ok(Json(serde_json::json!({ "status": "deleted" })))
}

/// Profile for the resolved identity: the account when registered, a synthetic
/// anonymous profile otherwise (registered=false).
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "Me"))]
pub(crate) struct Me {
    user_id: String,
    registered: bool,
    email: Option<String>,
    display_name: Option<String>,
    role: Option<String>,
    /// §6.3: absent for an anonymous profile, `null`-able for an account —
    /// the double Option keeps «absent» and «null» distinct on the wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "number | null"))]
    email_confirmed_at: Option<Option<u64>>,
    /// §6.3 — the server's banner verdict (like `can_unlink`): true only while
    /// the account has an email that is still unconfirmed.
    needs_email_confirmation: bool,
    methods: Vec<String>,
    can_unlink: bool,
}

async fn get_me_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Me>, AppError> {
    let claimed = claimed_from_headers(&headers);
    let user_id = resolve_user(&state, &headers, &claimed).await?;
    let account = state.auth.get_user(&user_id).await?;
    Ok(Json(match account {
        Some(a) => {
            let identities = state.auth.identities_for_user(&a.user_id).await?;
            // Sign-in surface from the one source of truth (auth.rs): working
            // methods for the list (a method works iff its identities row
            // exists), the reachability verdict for unlink UI — the client
            // renders these, it never re-derives the rules.
            let methods = auth::signin_methods(&identities)
                .into_iter()
                .map(str::to_string)
                .collect();
            let can_unlink = auth::reachable_ways(&a, &identities) > 1;
            Me {
                needs_email_confirmation: a.unconfirmed_email().is_some(),
                user_id: a.user_id,
                registered: true,
                email: a.email,
                display_name: a.display_name,
                role: Some(a.role),
                email_confirmed_at: Some(a.email_confirmed_at),
                methods,
                can_unlink,
            }
        }
        None => Me {
            user_id,
            registered: false,
            email: None,
            display_name: None,
            role: None,
            email_confirmed_at: None,
            needs_email_confirmation: false,
            methods: vec![],
            can_unlink: false,
        },
    }))
}
