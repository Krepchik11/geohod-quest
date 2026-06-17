//! Identity primitive: anonymous-first players, email registration, sessions.
//!
//! The model (player-identity spec): the client mints a device UUID and uses
//! `dev:<uuid>` as its player id with NO server round-trip — identity exists
//! before any network. Registration attaches email + argon2 password hash to
//! that SAME player id (a `players` row whose PK is the anonymous id), so every
//! grant/attempt/fact/bonus key survives with zero migration. Login from another
//! device returns the account's player id; the device adopts it.
//!
//! Enforcement (honest two-tier threat model): a REGISTERED player id requires a
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

/// Public account data (never carries the password hash).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PlayerAccount {
    pub player_id: String,
    pub email: String,
    pub display_name: Option<String>,
    /// Access role (admin/editor/player). New accounts default to `player`.
    pub role: String,
    /// Unix seconds at registration (0 on clock error; informational only).
    pub created_at: u64,
}

/// Stored registration record: public account + secret hash (store-layer only).
#[derive(Clone, Debug)]
pub struct PlayerRecord {
    pub account: PlayerAccount,
    pub password_hash: String,
}

/// Hash a password with argon2id (default params, random salt).
pub fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(anyhow::anyhow!("password hashing failed: {e}")))
}

/// Verify a password against a stored argon2 hash. A malformed stored hash
/// verifies false (treated as bad credentials, logged upstream as 401).
pub fn verify_password(stored_hash: &str, password: &str) -> bool {
    PasswordHash::new(stored_hash)
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

/// Opaque session token: 32 random bytes, hex-encoded (revocable server-side).
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Minimal credential validation: enough to reject obvious garbage without
/// pretending to be full email validation (no confirmation flow exists by
/// requirement, so deliverability is unverifiable anyway).
pub fn validate_credentials(email: &str, password: &str) -> Result<(), AppError> {
    let email_ok = email.len() >= 3 && email.contains('@') && !email.contains(char::is_whitespace);
    if !email_ok {
        return Err(AppError::BadRequest("invalid email".into()));
    }
    if password.len() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_then_verify_roundtrip_and_wrong_password_fails() {
        let hash = hash_password("correct horse battery").expect("hash");
        assert!(verify_password(&hash, "correct horse battery"));
        assert!(!verify_password(&hash, "wrong password"));
        assert!(!verify_password("not-a-phc-hash", "anything"));
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
    fn credential_validation_rejects_garbage() {
        assert!(validate_credentials("a@b.io", "longenough").is_ok());
        assert!(validate_credentials("no-at-sign", "longenough").is_err());
        assert!(validate_credentials("a @b.io", "longenough").is_err());
        assert!(validate_credentials("a@b.io", "short").is_err());
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
