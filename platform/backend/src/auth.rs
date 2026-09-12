//! Identity primitive: anonymous-first users, email registration, sessions.
//!
//! The model (player-identity spec): the client mints a device UUID and uses
//! `dev:<uuid>` as its user id with NO server round-trip — identity exists
//! before any network. Registration attaches an account (a `users` row whose PK
//! is the anonymous id, carrying the contact email) plus a `password` row in
//! `identities` (the argon2 hash) to that SAME user id, so every
//! grant/attempt/fact/bonus key survives with zero migration. Login from another
//! device returns the account's user id; the device adopts it.
//!
//! Every way to sign in — password, google, telegram — is one `identities` row
//! (a tagged union keyed by `method`); a method works iff its row exists. The
//! account's email is NOT an authenticator: it is the contact/recovery channel
//! (and the password-login address), which is why [`reachable_ways`] counts it
//! separately from the identity rows.
//!
//! Naming: `user_id` is the universal principal id — it exists before any
//! registration (anonymous devices) and regardless of role (an admin who never
//! plays carries one too; "player" is only a ROLE value). A row in `users` is a
//! registered *account* ([`UserAccount`]) attached to that id.
//!
//! Enforcement (honest two-tier threat model): a REGISTERED user id requires a
//! valid Bearer session token for player-scoped actions; an anonymous id is
//! credentialed by device possession alone (locked owner decision — a token
//! cannot exist before registration). Facts append stays attempt-scoped.

use argon2::Argon2;
use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use serde::{Deserialize, Serialize};

use crate::errors::AppError;

/// Access role attached to a registered account (admin-users spec). The default
/// for every new registration is [`DEFAULT_ROLE`] (`player`); `admin` is the only
/// role that unlocks the admin surface (see `require_admin_actor` in main.rs).
/// Stored as a plain string (one column, simple wire) but constrained to the three
/// known values both in code ([`validate_role`]) and at the DB (a CHECK constraint).
pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_EDITOR: &str = "editor";
pub const ROLE_PLAYER: &str = "player";
pub const DEFAULT_ROLE: &str = ROLE_PLAYER;
/// The full set of assignable roles, in display order (admin → editor → player).
pub const ROLES: [&str; 3] = [ROLE_ADMIN, ROLE_EDITOR, ROLE_PLAYER];

/// The roles that may author quests — open the constructor, publish, and OWN a
/// quest row (admin ⊃ editor). One definition for both directions of the rule:
/// the gate that lets a session into the constructor, and the candidate set a
/// quest may be handed to. A quest owned by an account outside this set would be
/// a quest nobody can edit.
pub const AUTHOR_ROLES: &[&str] = &[ROLE_ADMIN, ROLE_EDITOR];

/// See [`AUTHOR_ROLES`].
pub fn role_can_author(role: &str) -> bool {
    AUTHOR_ROLES.contains(&role)
}

/// Sign-in methods — rows in `identities`. `password` is the built-in
/// email+password login: its row holds the argon2 secret and exists only once a
/// password is actually set (the login ADDRESS lives on `users.email`, which is
/// an account property — contact + reset delivery — not a credential). Social
/// methods key on the provider's stable subject id.
pub const METHOD_PASSWORD: &str = "password";
pub const PROVIDER_GOOGLE: &str = "google";
pub const PROVIDER_TELEGRAM: &str = "telegram";
/// The wire name the client shows for the password method (the profile's
/// `methods` list says `"email"`); storage says [`METHOD_PASSWORD`].
pub const METHOD_EMAIL: &str = "email";
/// Providers accepted by the social endpoints (the linkable/unlinkable subset
/// of methods — the password row is managed by register/reset/change, never
/// link/unlink).
pub const PROVIDERS: [&str; 2] = [PROVIDER_GOOGLE, PROVIDER_TELEGRAM];

/// Reject a provider outside the known set (keeps the in-memory store honest,
/// mirroring the DB CHECK constraint).
pub fn validate_provider(provider: &str) -> Result<(), AppError> {
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "unknown provider '{provider}' (expected google or telegram)"
        )))
    }
}

/// Reject any role outside the known set (400). Keeps the `role` column honest in
/// the in-memory store too, where no DB CHECK constraint exists.
pub fn validate_role(role: &str) -> Result<(), AppError> {
    if ROLES.contains(&role) {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "invalid role '{role}' (expected one of: admin, editor, player)"
        )))
    }
}

/// Public account data (never carries the password hash). One row in `users`.
/// `user_id` is the universal principal id the account is attached to (kept
/// as-is so every grant/attempt/fact key survives registration — module docs).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct UserAccount {
    pub user_id: String,
    /// Login email. `None` for a social-only account (a Telegram account has no
    /// email; a Google account has one). Unique across accounts when present.
    pub email: Option<String>,
    pub display_name: Option<String>,
    /// Access role (admin/editor/player). New accounts default to `player`.
    pub role: String,
    /// Unix seconds at registration (0 on clock error; informational only).
    pub created_at: u64,
    /// Unix seconds when the email was confirmed (§6.3 soft confirmation);
    /// None until the confirmation link is opened.
    #[serde(default)]
    pub email_confirmed_at: Option<u64>,
}

impl UserAccount {
    /// How this account is labelled as a quest author: display name, else email,
    /// else the raw id. Denormalized onto the quest row at creation AND at
    /// transfer, so both writers spell the author the same way.
    pub fn author_label(&self) -> String {
        self.display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or(self.email.as_deref())
            .unwrap_or(&self.user_id)
            .to_string()
    }

    /// §6.3 — the address still awaiting confirmation, if any. THE one rule
    /// behind the profile banner and the resend endpoint: an account with no
    /// email has nothing to confirm.
    pub fn unconfirmed_email(&self) -> Option<&str> {
        match self.email_confirmed_at {
            None => self.email.as_deref(),
            Some(_) => None,
        }
    }
}

/// Credential view for the password flows (login, change-password): the public
/// account joined with its `password` identity's secret. `password_hash` is
/// `None` when no password row exists (social-only account, or a
/// Google-attached email whose password was never set) — such an account cannot
/// password-login until a reset creates the row.
#[derive(Clone, Debug)]
pub struct UserRecord {
    pub account: UserAccount,
    pub password_hash: Option<String>,
}

/// WORKING sign-in methods for an account: a method works iff its `identities`
/// row exists. The password method is served under its wire name `"email"`,
/// first; social methods follow in store order. THE source of the `/me`
/// `methods` list — distinct from [`reachable_ways`], which also counts a
/// password-less email because the reset flow makes it a way back in.
pub fn signin_methods(identities: &[crate::store::AuthIdentity]) -> Vec<&str> {
    let mut methods: Vec<&str> = Vec::new();
    if identities.iter().any(|i| !i.is_social()) {
        methods.push(METHOD_EMAIL);
    }
    methods.extend(
        identities
            .iter()
            .filter(|i| i.is_social())
            .map(|i| i.method.as_str()),
    );
    methods
}

/// How many ways the account can still be REACHED: every linked social method
/// plus an email even without a password (recoverable via the §6.2 reset
/// flow); the password row adds nothing beyond the email that resets it. THE
/// unlink guard and the `can_unlink` verdict served to the client, so the UI
/// and the guard can never disagree.
pub fn reachable_ways(account: &UserAccount, identities: &[crate::store::AuthIdentity]) -> usize {
    let social = identities.iter().filter(|i| i.is_social()).count();
    social + usize::from(account.email.is_some())
}

/// Argon2id is deliberately expensive: the default parameters cost ~19 MiB and
/// tens of milliseconds of pure CPU per call. Run on an async worker that is a
/// stall of the whole thread — with N workers, N concurrent sign-ins stop the
/// server answering anything at all, `/health` included, and sign-in is the one
/// endpoint an anonymous caller can aim at. Both password operations therefore
/// go to the blocking pool, which is sized for exactly this and cannot starve
/// the request loop no matter how many arrive.
///
/// Same reasoning and same idiom as `yookassa.rs` and `social.rs`.
async fn on_blocking_pool<T, F>(what: &'static str, f: F) -> Result<T, AppError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("{what} task failed: {e}")))
}

/// Hash a password with argon2id (default params, random salt).
pub async fn hash_password(password: &str) -> Result<String, AppError> {
    let password = password.to_string();
    on_blocking_pool("password hashing", move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| AppError::Internal(anyhow::anyhow!("password hashing failed: {e}")))
    })
    .await?
}

/// Verify a password against a stored argon2 hash. A malformed stored hash
/// verifies false (treated as bad credentials, logged upstream as 401).
pub async fn verify_password(stored_hash: &str, password: &str) -> bool {
    let (stored_hash, password) = (stored_hash.to_string(), password.to_string());
    on_blocking_pool("password verification", move || {
        PasswordHash::new(&stored_hash)
            .map(|parsed| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// Opaque session token: 32 random bytes, hex-encoded (revocable server-side).
pub fn generate_token() -> String {
    const HEX: [u8; 16] = *b"0123456789abcdef";
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    // Single 64-byte allocation; push nibbles directly (no per-byte `format!` String).
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Compare two secrets without an early exit. `==` on a shared secret stops at
/// the first differing byte, so how long the answer takes is a measurement of
/// how much of the secret the caller already has (CWE-208). The fold has no
/// branch to short-circuit; only the length is observable, which a shared
/// operator token does not hide anyway.
pub fn secret_eq(provided: &str, expected: &str) -> bool {
    let (provided, expected) = (provided.as_bytes(), expected.as_bytes());
    provided.len() == expected.len()
        && provided
            .iter()
            .zip(expected)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

/// The STORED form of a session token. A session token is a bearer secret, so
/// it is kept exactly like the mailed reset link and code: only sha256 of it is
/// persisted, and a leaked database yields no working login. 32 random bytes
/// need no salt or stretching — there is nothing to guess offline.
pub fn session_hash(token: &str) -> String {
    crate::media::sha256_hex(token.as_bytes())
}

/// Mint a session: the RAW token (the client's only copy) paired with the hash
/// the store keeps. They only ever come together, so a caller cannot persist
/// the raw token by forgetting a step.
pub fn new_session_token() -> (String, String) {
    let raw = generate_token();
    let hash = session_hash(&raw);
    (raw, hash)
}

/// §6.2 R2: emailed password-reset code — 6 digits, crypto-random, uniform
/// (rejection sampling, no modulo bias). Low entropy is deliberate (typed from
/// a mail notification), so verification MUST stay attempt-capped server-side
/// (see `store::MAX_CODE_ATTEMPTS`).
pub fn generate_reset_code() -> String {
    // Largest multiple of 1_000_000 that fits in u32; resample above it.
    const LIMIT: u32 = u32::MAX - (u32::MAX % 1_000_000);
    loop {
        let mut bytes = [0u8; 4];
        OsRng.fill_bytes(&mut bytes);
        let n = u32::from_le_bytes(bytes);
        if n < LIMIT {
            return format!("{:06}", n % 1_000_000);
        }
    }
}

/// Canonical email form: trimmed + lowercased. Applied at EVERY auth boundary
/// that accepts an email (register/login/identify/recover) so one mailbox maps
/// to one account regardless of caller casing — client-side normalization is
/// not a boundary the server may rely on.
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Server email rule. Counts Unicode code points, not bytes, so the verdict
/// matches the client mirror (frontend lib/credentials.ts) — the shared
/// goldens/wire/credentials.json pins both sides.
pub fn email_valid(email: &str) -> bool {
    email.chars().count() >= 3 && email.contains('@') && !email.contains(char::is_whitespace)
}

/// Server password rule: at least 8 code points. The ONE implementation —
/// register, reset and change-password all call it.
pub fn password_valid(password: &str) -> bool {
    password.chars().count() >= 8
}

pub const PASSWORD_ERROR: &str = "password must be at least 8 characters";

/// Minimal credential validation: enough to reject obvious garbage without
/// pretending to be full email validation (real deliverability is proven by
/// the §6.3 confirmation mail, not by parsing).
pub fn validate_credentials(email: &str, password: &str) -> Result<(), AppError> {
    if !email_valid(email) {
        return Err(AppError::BadRequest("invalid email".into()));
    }
    if !password_valid(password) {
        return Err(AppError::BadRequest(PASSWORD_ERROR.into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hash_then_verify_roundtrip_and_wrong_password_fails() {
        let hash = hash_password("correct horse battery").await.expect("hash");
        assert!(verify_password(&hash, "correct horse battery").await);
        assert!(!verify_password(&hash, "wrong password").await);
        assert!(!verify_password("not-a-phc-hash", "anything").await);
    }

    #[test]
    fn secret_eq_matches_string_equality() {
        assert!(secret_eq("s3cret", "s3cret"));
        assert!(!secret_eq("s3cret", "s3crey"), "last byte differs");
        assert!(!secret_eq("s3cre", "s3cret"), "prefix is not a match");
        assert!(!secret_eq("s3crett", "s3cret"), "extension is not a match");
        assert!(secret_eq("", ""));
    }

    #[test]
    fn tokens_are_unique_and_64_hex_chars() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two tokens must not collide");
    }

    #[test]
    fn reset_code_is_six_digits() {
        for _ in 0..64 {
            let code = generate_reset_code();
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|c| c.is_ascii_digit()), "{code}");
        }
    }

    /// Shared wire golden (platform/goldens/wire/credentials.json) — the SAME
    /// file the frontend credentials tests run.
    #[test]
    fn credentials_match_wire_golden() {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        #[allow(dead_code)]
        struct Fixture {
            name: String,
            description: String,
            emails: Vec<EmailCase>,
            passwords: Vec<PasswordCase>,
        }
        #[derive(serde::Deserialize)]
        struct EmailCase {
            raw: String,
            normalized: String,
            valid: bool,
        }
        #[derive(serde::Deserialize)]
        struct PasswordCase {
            password: String,
            valid: bool,
        }
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../goldens/wire/credentials.json"
        );
        let fx: Fixture =
            serde_json::from_str(&std::fs::read_to_string(path).expect("read golden"))
                .expect("parse golden");
        assert!(!fx.emails.is_empty() && !fx.passwords.is_empty());
        for c in &fx.emails {
            let normalized = normalize_email(&c.raw);
            assert_eq!(normalized, c.normalized, "normalize({:?})", c.raw);
            assert_eq!(
                validate_credentials(&normalized, "longenough").is_ok(),
                c.valid,
                "email verdict for {:?}",
                c.raw
            );
        }
        for c in &fx.passwords {
            assert_eq!(
                validate_credentials("a@b.io", &c.password).is_ok(),
                c.valid,
                "password verdict for {:?}",
                c.password
            );
        }
    }

    #[test]
    fn normalize_email_trims_and_lowercases() {
        assert_eq!(normalize_email("  Anna@Example.COM "), "anna@example.com");
        assert_eq!(normalize_email("a@b.io"), "a@b.io");
    }

    #[test]
    fn credential_validation_rejects_garbage() {
        assert!(validate_credentials("a@b.io", "longenough").is_ok());
        assert!(validate_credentials("no-at-sign", "longenough").is_err());
        assert!(validate_credentials("a @b.io", "longenough").is_err());
        assert!(validate_credentials("a@b.io", "short").is_err());
    }

    fn identity(method: &str) -> crate::store::AuthIdentity {
        crate::store::AuthIdentity {
            method: method.to_string(),
            identifier: format!("id-{method}"),
            user_id: "dev:u1".to_string(),
            handle: None,
            created_at: 1,
        }
    }

    fn account(email: Option<&str>) -> UserAccount {
        UserAccount {
            user_id: "dev:u1".to_string(),
            email: email.map(str::to_string),
            display_name: None,
            role: DEFAULT_ROLE.to_string(),
            created_at: 1,
            email_confirmed_at: None,
        }
    }

    #[test]
    fn signin_methods_serves_password_as_email_first_then_socials() {
        let ids = [
            identity(PROVIDER_GOOGLE),
            identity(METHOD_PASSWORD),
            identity(PROVIDER_TELEGRAM),
        ];
        assert_eq!(signin_methods(&ids), vec!["email", "google", "telegram"]);
    }

    #[test]
    fn signin_methods_is_row_existence_only() {
        assert!(signin_methods(&[]).is_empty());
        // A social-only account: no password row → no "email" method, even
        // though the ACCOUNT may well have an email (reachable, not sign-in-able).
        let ids = [identity(PROVIDER_TELEGRAM)];
        assert_eq!(signin_methods(&ids), vec!["telegram"]);
    }

    #[test]
    fn reachable_counts_socials_plus_email_and_ignores_password_row() {
        // Password row adds nothing beyond the email that resets it.
        let ids = [identity(METHOD_PASSWORD), identity(PROVIDER_GOOGLE)];
        assert_eq!(reachable_ways(&account(Some("a@b.io")), &ids), 2);
        // Email without a password still counts (reset flow is a way back in).
        assert_eq!(reachable_ways(&account(Some("a@b.io")), &[]), 1);
        // Social-only, no email: exactly the linked methods.
        let ids = [identity(PROVIDER_TELEGRAM)];
        assert_eq!(reachable_ways(&account(None), &ids), 1);
        assert_eq!(reachable_ways(&account(None), &[]), 0);
    }

    #[test]
    fn role_validation_accepts_known_and_rejects_unknown() {
        assert!(validate_role("admin").is_ok());
        assert!(validate_role("editor").is_ok());
        assert!(validate_role("player").is_ok());
        assert!(validate_role("superuser").is_err());
        assert!(validate_role("").is_err());
        assert!(validate_role("Admin").is_err(), "case-sensitive");
    }
}
