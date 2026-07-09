//! Social sign-in verification: Telegram Login Widget (HMAC) and Google Identity
//! Services (RS256 ID token). Both are PURE with respect to our data — they only
//! decide "is this provider payload authentic, and who is it?" The account
//! link-or-create policy lives in `main.rs`; the store persists identities.
//!
//! Security model (verified against primary docs):
//! - Telegram (`core.telegram.org/widgets/login-legacy`): the widget signs the
//!   payload with `HMAC_SHA256(data_check_string, SHA256(bot_token))`. We
//!   reconstruct the data-check-string, verify in CONSTANT TIME (`Mac::verify_slice`),
//!   and reject a stale `auth_date` so a leaked-but-old payload cannot be replayed.
//!   Telegram provides NO email.
//! - Google (`developers.google.com/identity/gsi/web/guides/verify-google-id-token`):
//!   the client yields an ID token (JWT). We verify the RS256 signature against
//!   Google's rotating JWKS, and require `aud == our client id`,
//!   `iss ∈ {accounts.google.com, https://accounts.google.com}`, and unexpired
//!   `exp`. The stable user id is `sub` (never email — email can change).

use std::sync::Mutex;

use hmac::{Hmac, Mac};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};

use crate::errors::AppError;

fn unauthorized(msg: &str) -> AppError {
    AppError::Unauthorized(msg.to_string())
}

// ============================ Telegram ============================

/// Telegram Login Widget payload (the seven fields the widget emits). `id` and
/// `auth_date` are numeric on the wire; the optional name/username/photo fields
/// are present only when the user has them, exactly as the widget sends them.
#[derive(Debug, Clone, Deserialize)]
pub struct TelegramAuth {
    pub id: i64,
    pub first_name: String,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub photo_url: Option<String>,
    pub auth_date: i64,
    pub hash: String,
}

impl TelegramAuth {
    /// The data-check-string: every received field EXCEPT `hash`, formatted as
    /// `key=value`, sorted alphabetically by key, joined by `\n`. An optional
    /// field absent from the payload is absent here too — matching what Telegram
    /// hashed on its side.
    fn data_check_string(&self) -> String {
        let mut pairs: Vec<(&str, String)> = vec![
            ("auth_date", self.auth_date.to_string()),
            ("first_name", self.first_name.clone()),
            ("id", self.id.to_string()),
        ];
        if let Some(v) = &self.last_name {
            pairs.push(("last_name", v.clone()));
        }
        if let Some(v) = &self.photo_url {
            pairs.push(("photo_url", v.clone()));
        }
        if let Some(v) = &self.username {
            pairs.push(("username", v.clone()));
        }
        pairs.sort_by(|a, b| a.0.cmp(b.0));
        pairs
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Verify authenticity (HMAC) and freshness (`auth_date`). Returns 401 on any
    /// mismatch — a forged, tampered, or stale payload is indistinguishable to the
    /// caller (one opaque failure, no oracle).
    pub fn verify(&self, bot_token: &str, now: u64, max_age_secs: u64) -> Result<(), AppError> {
        // Freshness: reject payloads older than the window, and reject a far-future
        // auth_date (small clock skew tolerated) so the window cannot be sidestepped.
        let now = now as i64;
        let max_age = max_age_secs as i64;
        if self.auth_date > now + 300 || now - self.auth_date > max_age {
            return Err(unauthorized("telegram auth_date is stale"));
        }
        let secret = Sha256::digest(bot_token.as_bytes());
        let mut mac = <Hmac<Sha256>>::new_from_slice(&secret)
            .map_err(|_| AppError::Internal(anyhow::anyhow!("hmac key init")))?;
        mac.update(self.data_check_string().as_bytes());
        let provided = hex::decode(self.hash.trim())
            .map_err(|_| unauthorized("telegram hash is not valid hex"))?;
        // Constant-time comparison (verify_slice), not `==` on the hex string.
        mac.verify_slice(&provided)
            .map_err(|_| unauthorized("telegram signature mismatch"))
    }

    /// A human display name from the Telegram profile: "First Last" (trimmed), or
    /// the `@username`, or None (the account still works, just unnamed).
    pub fn display_name(&self) -> Option<String> {
        let full = match &self.last_name {
            Some(last) => format!("{} {}", self.first_name, last),
            None => self.first_name.clone(),
        };
        let full = full.trim().to_string();
        if !full.is_empty() {
            return Some(full);
        }
        self.username.as_ref().map(|u| format!("@{u}"))
    }

    /// Stable identity subject for the `auth_identities` table (the Telegram user id).
    pub fn subject(&self) -> String {
        self.id.to_string()
    }
}

// ============================ Google ============================

/// The claims we consume from a verified Google ID token. `sub` is the stable,
/// never-reused Google account id (the identity key). `email` is present only
/// when the token carries one; `email_verified` gates whether Google is
/// authoritative for it (and thus whether we may auto-link on email match).
#[derive(Debug, Clone, PartialEq)]
pub struct GoogleClaims {
    pub sub: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub name: Option<String>,
    pub picture: Option<String>,
}

/// Raw claim shape as it arrives in the JWT. `email_verified` is accepted as
/// either a JSON boolean (modern GIS tokens) or the string "true"/"false" (older
/// OAuth tokens) — Google has emitted both.
#[derive(Debug, Deserialize)]
struct RawGoogleClaims {
    sub: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default, deserialize_with = "de_flexible_bool")]
    email_verified: bool,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    picture: Option<String>,
}

fn de_flexible_bool<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum BoolOrStr {
        B(bool),
        S(String),
    }
    Ok(match BoolOrStr::deserialize(d)? {
        BoolOrStr::B(b) => b,
        BoolOrStr::S(s) => s.eq_ignore_ascii_case("true"),
    })
}

/// One JSON Web Key from Google's JWKS (`.../oauth2/v3/certs`). We only use RSA
/// keys (`n`, `e`) selected by `kid`.
#[derive(Debug, Clone, Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Debug, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

/// Cached Google public keys. `expires_at` follows the JWKS response
/// `Cache-Control: max-age`; an empty cache (or unknown `kid`) forces a refetch.
#[derive(Default)]
struct JwksCache {
    keys: Vec<Jwk>,
    expires_at: u64,
}

/// Verifier for Google ID tokens against a specific OAuth client id. Holds the
/// cached JWKS; clone-cheap wrapper for `AppState` via `Arc`.
pub struct GoogleVerifier {
    client_id: String,
    cache: Mutex<JwksCache>,
}

const GOOGLE_CERTS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
/// Fallback cache lifetime when the response omits a usable `max-age`.
const JWKS_FALLBACK_TTL_SECS: u64 = 3600;

impl GoogleVerifier {
    pub fn new(client_id: String) -> Self {
        Self {
            client_id,
            cache: Mutex::new(JwksCache::default()),
        }
    }

    /// Verify a Google ID token and return its claims, refreshing the JWKS on a
    /// cold cache or an unknown `kid` (key rotation). Any failure is 401.
    pub async fn verify(&self, id_token: &str, now: u64) -> Result<GoogleClaims, AppError> {
        let header = decode_header(id_token).map_err(|_| unauthorized("malformed google token"))?;
        let kid = header
            .kid
            .ok_or_else(|| unauthorized("google token has no kid"))?;

        let mut keys = self.keys(now, false).await?;
        if !keys.iter().any(|k| k.kid == kid) {
            // The signing key rotated out of our cache — force one refetch.
            keys = self.keys(now, true).await?;
        }
        let jwk = keys
            .iter()
            .find(|k| k.kid == kid)
            .ok_or_else(|| unauthorized("unknown google signing key"))?;
        verify_id_token_with_key(id_token, jwk, &self.client_id)
    }

    /// Return cached keys, fetching when the cache is stale/empty or `force`.
    async fn keys(&self, now: u64, force: bool) -> Result<Vec<Jwk>, AppError> {
        if !force {
            let cache = self
                .cache
                .lock()
                .map_err(|_| AppError::Internal(anyhow::anyhow!("jwks lock poisoned")))?;
            if !cache.keys.is_empty() && cache.expires_at > now {
                return Ok(cache.keys.clone());
            }
        }
        // Blocking HTTP off the async runtime; called rarely (cached ~1h).
        let (keys, ttl) = tokio::task::spawn_blocking(fetch_google_certs)
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("jwks fetch task: {e}")))??;
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| AppError::Internal(anyhow::anyhow!("jwks lock poisoned")))?;
        cache.keys = keys.clone();
        cache.expires_at = now + ttl;
        Ok(keys)
    }
}

/// Fetch + parse Google's JWKS, returning the keys and the cache TTL derived from
/// the `Cache-Control: max-age` response header.
fn fetch_google_certs() -> Result<(Vec<Jwk>, u64), AppError> {
    let resp = attohttpc::get(GOOGLE_CERTS_URL)
        .send()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("google jwks fetch failed: {e}")))?;
    let ttl = resp
        .headers()
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_max_age)
        .unwrap_or(JWKS_FALLBACK_TTL_SECS);
    let jwks: Jwks = resp
        .json()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("google jwks parse failed: {e}")))?;
    Ok((jwks.keys, ttl))
}

/// Extract `max-age=<secs>` from a `Cache-Control` header value.
fn parse_max_age(header: &str) -> Option<u64> {
    header.split(',').find_map(|part| {
        let part = part.trim();
        part.strip_prefix("max-age=")
            .and_then(|n| n.trim().parse::<u64>().ok())
    })
}

/// Core RS256 verification against ONE JWK — the testable heart of Google auth.
/// `jsonwebtoken` enforces the signature, `exp` (with default leeway), `aud`
/// (our client id) and `iss` (Google) inside `decode`.
fn verify_id_token_with_key(
    id_token: &str,
    jwk: &Jwk,
    client_id: &str,
) -> Result<GoogleClaims, AppError> {
    let key = DecodingKey::from_rsa_components(&jwk.n, &jwk.e)
        .map_err(|_| unauthorized("bad google signing key"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&["accounts.google.com", "https://accounts.google.com"]);
    validation.validate_exp = true;
    let data = decode::<RawGoogleClaims>(id_token, &key, &validation)
        .map_err(|_| unauthorized("google token verification failed"))?;
    let c = data.claims;
    Ok(GoogleClaims {
        sub: c.sub,
        email: c.email.map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()),
        email_verified: c.email_verified,
        name: c.name.filter(|n| !n.trim().is_empty()),
        picture: c.picture,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Telegram ----

    const TG_TOKEN: &str = "123456:TESTTOKEN";

    fn tg() -> TelegramAuth {
        TelegramAuth {
            id: 42,
            first_name: "Ann".to_string(),
            last_name: None,
            username: None,
            photo_url: None,
            auth_date: 1_600_000_000,
            // Golden HMAC computed independently (python hmac/sha256) for
            // token=TG_TOKEN over "auth_date=1600000000\nfirst_name=Ann\nid=42".
            hash: "516ac6557f524eb52143014a96cf843235617ca52c7a7e2e860fc371724f40bc".to_string(),
        }
    }

    #[test]
    fn telegram_golden_payload_verifies() {
        let a = tg();
        // now just after auth_date, generous window.
        assert!(a.verify(TG_TOKEN, 1_600_000_100, 86_400).is_ok());
    }

    #[test]
    fn telegram_tampered_field_fails() {
        let mut a = tg();
        a.first_name = "Eve".to_string(); // hash no longer matches the data
        assert!(a.verify(TG_TOKEN, 1_600_000_100, 86_400).is_err());
    }

    #[test]
    fn telegram_wrong_bot_token_fails() {
        let a = tg();
        assert!(a.verify("999:OTHER", 1_600_000_100, 86_400).is_err());
    }

    #[test]
    fn telegram_stale_auth_date_fails_even_with_valid_hash() {
        let a = tg();
        // now is 2 days after auth_date, window is 1 day.
        assert!(a.verify(TG_TOKEN, 1_600_000_000 + 2 * 86_400, 86_400).is_err());
    }

    #[test]
    fn telegram_data_check_string_is_sorted_and_excludes_hash() {
        let a = TelegramAuth {
            id: 7,
            first_name: "B".into(),
            last_name: Some("C".into()),
            username: Some("u".into()),
            photo_url: None,
            auth_date: 100,
            hash: "deadbeef".into(),
        };
        assert_eq!(
            a.data_check_string(),
            "auth_date=100\nfirst_name=B\nid=7\nlast_name=C\nusername=u"
        );
    }

    #[test]
    fn telegram_display_name_prefers_full_then_username() {
        let mut a = tg();
        a.last_name = Some("Smith".into());
        assert_eq!(a.display_name().as_deref(), Some("Ann Smith"));
        a.first_name = " ".into();
        a.last_name = None;
        a.username = Some("nick".into());
        assert_eq!(a.display_name().as_deref(), Some("@nick"));
    }

    // ---- Google ----

    // Test RSA keypair (2048-bit) generated offline; the matching JWK n/e are the
    // base64url modulus/exponent. Used to SIGN tokens locally so the RS256 + aud +
    // iss + exp path is exercised with no network and no real Google key.
    const TEST_PRIV_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDD3MBIphXH6Xk/\n/1TYzYgMeVrRmhZ1UhVPkOr+xkNiVUvDdA3Vt6gwL5Ckx7WbHdGK+ZjhUBZkBuf0\n+GTfEqHroaCJdFvwuSjrh6aaW2J4NWv+0BvKJkeTB27lNUNXt8MACpvwIjo21gEG\nP0++a1j4v8d8fPo4OgddhHdqi/ZXoBxlI0frhEpbxGsIjiQ3ZlhIRRs0Im8yOqKL\n8EKMZ+9jdoOQjg5YpiOJszF8IZWJVVWudVyxC6HUXt0iN6HuudqeI19VZatSyZfP\nyCgVggEWUsKXD7WSJ0/WmoGs3d38H4S3bXSK0j7E42zYurB3q89FHe2wccVdeP14\nA7JVNT3fAgMBAAECggEAIQSNxbF56oGJVyiL/SBo1vF+Redb8dssjIU5mEmEAoeu\nhfyCeIzFZZofICgqjUOxl2QMSa9elu4zHDDjkFdrxHUywvlCpooQQ+RSSaMuLmWT\nFxmuFZ3uYvLV1v3rpFXuIYuoTgr3FVduRMdXghpGnWh3EJ1g8SmXJES4fNWraYng\nZ0qJzedYeZ3ARM4K83bFlzluro/etwjGyqdbn2Li63CDNZrD958y5SMCencAfz3N\nQWLVMzQZMmIgexgDl7AaTXynA9Igh+/GzDruQrxg5SXLV1RcurnSUkbJ/oo/yg1G\nRXTHmNvNOpn67xaw7xXtlDXJryx2+cvFpNmG0lv+gQKBgQD2eRKHNkHgM3cvaztz\n1PwhQGmng/kSTXtyorNBS81MaPdkrz96R6TZ+1D0v80rxT+QPvUrgbhXwDz4xSnZ\nikKNG8i+ygdVipA5vsZvdi5JArjbodj0MRTF/4DAUrRYX8T0Xak5+VaAyJuyZP2d\nSSXwJY46JSgdRbAb9nB6mHO5dwKBgQDLbt7csGnAVWNvFsgJJKVTEYTuZ7bdkVc+\nSmqlhZjqM1OW3CnWj1sihwRyjWVmGWVgnItY5nGWrD8dVl5zUCy8mnoJROZ7vFpk\npaLApcEBQ3Uv4EYMGwj3q+ILYLy/KX2XhFTjT/fNCaU2oI+odVycVujqHTgWzQQH\nH1i9fI042QKBgQCvVU+N6lYQhOwLSpAfhWrayLSgWyyrDX18/irgj2j7K0yaTmSs\nuxyViMd9ZJgyw/3EwlSsX3pgyjtViQSNYWKYeSRkPNncy1ZwDbuh/QNOIuaYL1lj\n1Sp+85SGvA7ZMz+rypkgybP0p0DDNj6ITknzvPOhf186+6EdM0GupJbmXwKBgFgP\nYTdkwhI4pDdFREf47fu8XK+ag6T7silLq0iFQUE4AJoQKagwHAIhMgKoRFli6uhc\nO1G7RzYyz4tShMYj0Ym+0M7MXXz4dqSUspPz7E0wtzyHN6sr1MDpTYshT/Lr8eqx\npNFVH25JG5Q/ApCoZPNkB6S4CzyLeI/guNglXzhZAoGADVcaS/khJYvIPB4ILe/r\nNytKqNRZCmivoteJYSE86+2+Tdl+kWJEd1nJDoPap/8Ew6cGi5usktxz8+K0Hzwj\nXRkd+60xc8kMu5V+c7ihLIJ09sf1gm/6Vt31iqOUE1eXZ+HhPb9EAcQJzW7Sa3gR\nFss42L+9njP/i6MM3L1MmFo=\n-----END PRIVATE KEY-----\n";
    const TEST_JWK_N: &str = "w9zASKYVx-l5P_9U2M2IDHla0ZoWdVIVT5Dq_sZDYlVLw3QN1beoMC-QpMe1mx3RivmY4VAWZAbn9Phk3xKh66GgiXRb8Lko64emmltieDVr_tAbyiZHkwdu5TVDV7fDAAqb8CI6NtYBBj9PvmtY-L_HfHz6ODoHXYR3aov2V6AcZSNH64RKW8RrCI4kN2ZYSEUbNCJvMjqii_BCjGfvY3aDkI4OWKYjibMxfCGViVVVrnVcsQuh1F7dIjeh7rnaniNfVWWrUsmXz8goFYIBFlLClw-1kidP1pqBrN3d_B-Et210itI-xONs2Lqwd6vPRR3tsHHFXXj9eAOyVTU93w";
    const TEST_JWK_E: &str = "AQAB";
    const CLIENT_ID: &str = "test-client.apps.googleusercontent.com";

    fn test_jwk() -> Jwk {
        Jwk {
            kid: "test-kid".into(),
            n: TEST_JWK_N.into(),
            e: TEST_JWK_E.into(),
        }
    }

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn sign(claims: serde_json::Value) -> String {
        let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
        header.kid = Some("test-kid".into());
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(TEST_PRIV_PEM.as_bytes())
            .expect("load test private key");
        jsonwebtoken::encode(&header, &claims, &key).expect("sign test token")
    }

    #[test]
    fn google_valid_token_yields_claims() {
        let token = sign(serde_json::json!({
            "iss": "https://accounts.google.com",
            "aud": CLIENT_ID,
            "sub": "google-user-123",
            "email": "Anna@Gmail.com",
            "email_verified": true,
            "name": "Anna",
            "exp": now() + 3600,
        }));
        let claims = verify_id_token_with_key(&token, &test_jwk(), CLIENT_ID).expect("verify");
        assert_eq!(claims.sub, "google-user-123");
        assert_eq!(claims.email.as_deref(), Some("anna@gmail.com")); // normalized
        assert!(claims.email_verified);
        assert_eq!(claims.name.as_deref(), Some("Anna"));
    }

    #[test]
    fn google_email_verified_accepts_string_true() {
        let token = sign(serde_json::json!({
            "iss": "accounts.google.com",
            "aud": CLIENT_ID,
            "sub": "u",
            "email": "x@y.io",
            "email_verified": "true",
            "exp": now() + 3600,
        }));
        let claims = verify_id_token_with_key(&token, &test_jwk(), CLIENT_ID).expect("verify");
        assert!(claims.email_verified);
    }

    #[test]
    fn google_wrong_audience_rejected() {
        let token = sign(serde_json::json!({
            "iss": "https://accounts.google.com",
            "aud": "attacker-client.apps.googleusercontent.com",
            "sub": "u",
            "exp": now() + 3600,
        }));
        assert!(verify_id_token_with_key(&token, &test_jwk(), CLIENT_ID).is_err());
    }

    #[test]
    fn google_wrong_issuer_rejected() {
        let token = sign(serde_json::json!({
            "iss": "https://evil.example.com",
            "aud": CLIENT_ID,
            "sub": "u",
            "exp": now() + 3600,
        }));
        assert!(verify_id_token_with_key(&token, &test_jwk(), CLIENT_ID).is_err());
    }

    #[test]
    fn google_expired_token_rejected() {
        let token = sign(serde_json::json!({
            "iss": "https://accounts.google.com",
            "aud": CLIENT_ID,
            "sub": "u",
            "exp": now() - 3600, // already expired (beyond default leeway)
        }));
        assert!(verify_id_token_with_key(&token, &test_jwk(), CLIENT_ID).is_err());
    }

    #[test]
    fn google_tampered_signature_rejected() {
        let token = sign(serde_json::json!({
            "iss": "https://accounts.google.com",
            "aud": CLIENT_ID,
            "sub": "u",
            "exp": now() + 3600,
        }));
        // Corrupt the FIRST character of the signature segment (after the last dot).
        let dot = token.rfind('.').unwrap();
        let (head, sig) = token.split_at(dot + 1);
        let first = sig.chars().next().unwrap();
        let swapped = if first == 'a' { 'b' } else { 'a' };
        let tampered = format!("{head}{swapped}{}", &sig[1..]);
        assert!(verify_id_token_with_key(&tampered, &test_jwk(), CLIENT_ID).is_err());
    }

    #[test]
    fn parse_max_age_reads_seconds() {
        assert_eq!(
            parse_max_age("public, max-age=3600, must-revalidate"),
            Some(3600)
        );
        assert_eq!(parse_max_age("no-cache"), None);
    }
}
