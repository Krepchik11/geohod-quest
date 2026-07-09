//! Social sign-in verification. BOTH providers issue an OpenID Connect **ID token**
//! (a JWT); we verify it against the provider's published JWKS. ONE verifier —
//! [`OidcVerifier`] — serves both: a provider is just an (audience, issuers,
//! jwks_url) triple. Verification is PURE — it answers only "is this token
//! authentic and for us, and who is it?" The account link-or-create policy lives
//! in `main.rs`; the store persists identities.
//!
//! Security model (verified against primary docs):
//! - **Google** (developers.google.com/identity/gsi/web/guides/verify-google-id-token):
//!   Google Identity Services yields an ID token. We verify the signature against
//!   Google's rotating JWKS, and require `aud == our client id`,
//!   `iss ∈ {accounts.google.com, https://accounts.google.com}`, and unexpired
//!   `exp`. The stable subject is `sub` (never email — email can change).
//! - **Telegram** (core.telegram.org/bots/telegram-login — the OpenID Connect
//!   login, which REPLACES the legacy HMAC Login Widget): `telegram-login.js`
//!   yields an ID token. We verify against Telegram's JWKS
//!   (oauth.telegram.org/.well-known/jwks.json), and require `aud == our bot's
//!   client id`, `iss == https://oauth.telegram.org`, and unexpired `exp`. The
//!   stable subject is the `id` claim — the Telegram user id, the SAME value the
//!   legacy widget keyed on, so existing linked identities survive the switch
//!   (the OIDC `sub` is a separate opaque value we deliberately do not key on).
//!   Telegram provides no email.
//!
//! JWKS keys are matched by `kid` and verified with THAT key's own algorithm:
//! Telegram advertises RS256/ES256/EdDSA/ES256K, so the verifier dispatches on the
//! JWK type (RSA→RS256, EC P-256→ES256, OKP Ed25519→EdDSA). ES256K (secp256k1) is
//! not supported by our JWT library; a token signed with it is rejected (401).

use std::sync::Mutex;

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::{Deserialize, Deserializer};

use crate::errors::AppError;

fn unauthorized(msg: &str) -> AppError {
    AppError::Unauthorized(msg.to_string())
}

// ============================ JWKS + verifier ============================

/// One JSON Web Key. A JWKS mixes key types, so every type-specific field is
/// optional and interpreted per `kty`/`crv` in [`Jwk::decoding`]. We keep only the
/// fields our supported algorithms need (RSA `n`/`e`, EC/OKP `x`/`y`).
#[derive(Debug, Clone, Deserialize)]
struct Jwk {
    kid: String,
    kty: String,
    #[serde(default)]
    crv: Option<String>,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
    #[serde(default)]
    x: Option<String>,
    #[serde(default)]
    y: Option<String>,
}

impl Jwk {
    /// Build a decoding key and the algorithm it verifies, or `None` for a key type
    /// we cannot verify (e.g. secp256k1 / ES256K — absent from our JWT library). A
    /// `None` here becomes a 401 at the call site, never a panic.
    fn decoding(&self) -> Option<(DecodingKey, Algorithm)> {
        match (self.kty.as_str(), self.crv.as_deref()) {
            ("RSA", _) => DecodingKey::from_rsa_components(self.n.as_deref()?, self.e.as_deref()?)
                .ok()
                .map(|k| (k, Algorithm::RS256)),
            ("EC", Some("P-256")) => {
                DecodingKey::from_ec_components(self.x.as_deref()?, self.y.as_deref()?)
                    .ok()
                    .map(|k| (k, Algorithm::ES256))
            }
            ("OKP", Some("Ed25519")) => DecodingKey::from_ed_components(self.x.as_deref()?)
                .ok()
                .map(|k| (k, Algorithm::EdDSA)),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

/// Cached provider public keys. `expires_at` follows the JWKS response
/// `Cache-Control: max-age`; an empty cache (or unknown `kid`) forces a refetch.
#[derive(Default)]
struct JwksCache {
    keys: Vec<Jwk>,
    expires_at: u64,
}

const GOOGLE_CERTS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const TELEGRAM_JWKS_URL: &str = "https://oauth.telegram.org/.well-known/jwks.json";
/// Fallback cache lifetime when the JWKS response omits a usable `max-age`.
const JWKS_FALLBACK_TTL_SECS: u64 = 3600;

/// Verifier for a single OIDC provider's ID tokens. Holds the cached JWKS; wrap in
/// `Arc` for `AppState`. A provider is fully described by its audience (our client
/// id), its accepted issuer(s), and its JWKS URL.
pub struct OidcVerifier {
    audience: String,
    issuers: Vec<String>,
    jwks_url: &'static str,
    cache: Mutex<JwksCache>,
}

impl OidcVerifier {
    /// Google "Sign in with Google": `aud == client_id`, issuer is Google (both the
    /// bare and https forms Google has emitted).
    pub fn google(client_id: String) -> Self {
        Self {
            audience: client_id,
            issuers: vec![
                "accounts.google.com".to_string(),
                "https://accounts.google.com".to_string(),
            ],
            jwks_url: GOOGLE_CERTS_URL,
            cache: Mutex::new(JwksCache::default()),
        }
    }

    /// Telegram OIDC login: `aud == the bot's client id`, issuer
    /// `https://oauth.telegram.org`.
    pub fn telegram(client_id: String) -> Self {
        Self {
            audience: client_id,
            issuers: vec!["https://oauth.telegram.org".to_string()],
            jwks_url: TELEGRAM_JWKS_URL,
            cache: Mutex::new(JwksCache::default()),
        }
    }

    /// Verify an ID token and return its validated claims, refreshing the JWKS on a
    /// cold cache or an unknown `kid` (key rotation). Any failure is 401. The caller
    /// extracts provider-specific claims from the returned JSON.
    pub async fn verify(&self, id_token: &str, now: u64) -> Result<serde_json::Value, AppError> {
        let header = decode_header(id_token).map_err(|_| unauthorized("malformed id token"))?;
        let kid = header.kid.ok_or_else(|| unauthorized("id token has no kid"))?;

        let mut keys = self.keys(now, false).await?;
        if !keys.iter().any(|k| k.kid == kid) {
            // The signing key rotated out of our cache — force one refetch.
            keys = self.keys(now, true).await?;
        }
        let jwk = keys
            .iter()
            .find(|k| k.kid == kid)
            .ok_or_else(|| unauthorized("unknown signing key"))?;
        self.verify_with_jwk(id_token, jwk)
    }

    /// Verify a token against ONE JWK — the testable heart, no network. Enforces the
    /// signature (with the key's own algorithm), `aud`, `iss` and `exp`.
    fn verify_with_jwk(
        &self,
        id_token: &str,
        jwk: &Jwk,
    ) -> Result<serde_json::Value, AppError> {
        let (key, alg) = jwk
            .decoding()
            .ok_or_else(|| unauthorized("unsupported signing key"))?;
        let mut validation = Validation::new(alg);
        validation.set_audience(&[self.audience.as_str()]);
        let issuers: Vec<&str> = self.issuers.iter().map(String::as_str).collect();
        validation.set_issuer(&issuers);
        validation.validate_exp = true;
        let data = decode::<serde_json::Value>(id_token, &key, &validation)
            .map_err(|_| unauthorized("id token verification failed"))?;
        Ok(data.claims)
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
        let url = self.jwks_url;
        let (keys, ttl) = tokio::task::spawn_blocking(move || fetch_jwks(url))
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

/// Fetch + parse a provider's JWKS, returning the keys and the cache TTL derived
/// from the `Cache-Control: max-age` response header.
fn fetch_jwks(url: &str) -> Result<(Vec<Jwk>, u64), AppError> {
    let resp = attohttpc::get(url)
        .send()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("jwks fetch failed: {e}")))?;
    let ttl = resp
        .headers()
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_max_age)
        .unwrap_or(JWKS_FALLBACK_TTL_SECS);
    let jwks: Jwks = resp
        .json()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("jwks parse failed: {e}")))?;
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

// ============================ Google claims ============================

/// The claims we consume from a verified Google ID token. `sub` is the stable,
/// never-reused Google account id (the identity key). `email` is present only when
/// the token carries one; `email_verified` gates whether Google is authoritative
/// for it (and thus whether we may auto-link on email match).
#[derive(Debug, Clone, PartialEq)]
pub struct GoogleClaims {
    pub sub: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub name: Option<String>,
    pub picture: Option<String>,
}

/// Raw claim shape as it arrives in the JWT. `email_verified` is accepted as either
/// a JSON boolean (modern GIS tokens) or the string "true"/"false" (older OAuth
/// tokens) — Google has emitted both.
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

impl GoogleClaims {
    /// Extract Google's claims from a verified token body (email lowercased; blank
    /// name dropped). A body missing `sub` is a malformed token (401).
    pub fn from_claims(claims: serde_json::Value) -> Result<Self, AppError> {
        let c: RawGoogleClaims = serde_json::from_value(claims)
            .map_err(|_| unauthorized("google token is missing required claims"))?;
        Ok(Self {
            sub: c.sub,
            email: c
                .email
                .map(|e| e.trim().to_lowercase())
                .filter(|e| !e.is_empty()),
            email_verified: c.email_verified,
            name: c.name.filter(|n| !n.trim().is_empty()),
            picture: c.picture,
        })
    }
}

// ============================ Telegram claims ============================

/// The claims we consume from a verified Telegram OIDC ID token. `subject` is the
/// stable identity key; Telegram provides no email.
#[derive(Debug, Clone, PartialEq)]
pub struct TelegramClaims {
    /// The stable subject: the `id` claim (the Telegram user id — the same value the
    /// legacy widget keyed on, so linked identities survive) when present, else the
    /// standard OIDC `sub`.
    pub subject: String,
    pub name: Option<String>,
    pub preferred_username: Option<String>,
    pub picture: Option<String>,
}

/// `id` and `sub` are BOTH optional here: Telegram serializes the user id as a JSON
/// number or a string, and a token may carry only `sub`. We coerce whatever is
/// present into a stable string subject (id preferred) — see [`TelegramClaims::from_claims`].
#[derive(Debug, Deserialize)]
struct RawTelegramClaims {
    #[serde(default, deserialize_with = "de_opt_flexible_i64")]
    id: Option<i64>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    preferred_username: Option<String>,
    #[serde(default)]
    picture: Option<String>,
}

/// Deserialize an optional integer that may arrive as a JSON number OR a string
/// (Telegram's `id` has been observed both ways). An unparseable string → None.
fn de_opt_flexible_i64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrStr {
        N(i64),
        S(String),
    }
    Ok(match Option::<NumOrStr>::deserialize(d)? {
        None => None,
        Some(NumOrStr::N(n)) => Some(n),
        Some(NumOrStr::S(s)) => s.trim().parse().ok(),
    })
}

impl TelegramClaims {
    /// Extract Telegram's claims from a verified token body. The subject is the `id`
    /// claim when present (number or string), else the OIDC `sub`; a token carrying
    /// neither is unidentifiable (401).
    pub fn from_claims(claims: serde_json::Value) -> Result<Self, AppError> {
        let c: RawTelegramClaims = serde_json::from_value(claims)
            .map_err(|_| unauthorized("telegram token is missing required claims"))?;
        let subject = c
            .id
            .map(|id| id.to_string())
            .or_else(|| c.sub.filter(|s| !s.trim().is_empty()))
            .ok_or_else(|| unauthorized("telegram token has neither id nor sub"))?;
        Ok(Self {
            subject,
            name: c.name.filter(|n| !n.trim().is_empty()),
            preferred_username: c.preferred_username.filter(|u| !u.trim().is_empty()),
            picture: c.picture,
        })
    }

    /// Stable identity subject for `auth_identities`.
    pub fn subject(&self) -> String {
        self.subject.clone()
    }

    /// A human display name: the profile `name`, else `@preferred_username`, else
    /// None (the account still works, just unnamed).
    pub fn display_name(&self) -> Option<String> {
        if let Some(name) = self.name.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            return Some(name.to_string());
        }
        self.preferred_username.as_ref().map(|u| format!("@{u}"))
    }
}

// ============================ Test support ============================

/// Offline signing + a pre-seeded JWKS so route tests exercise the REAL OIDC verify
/// path (signature + aud + iss + exp) with no network. Shared by this module's unit
/// tests and `main.rs`'s end-to-end social tests.
#[cfg(test)]
pub mod test_support {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};

    /// The bot client id (== `aud`) the seeded Telegram verifier trusts.
    pub const TELEGRAM_CLIENT_ID: &str = "111222333";
    const TG_KID: &str = "tg-es256";

    // EC P-256 keypair generated offline. ES256 is one of Telegram's advertised
    // id_token algorithms, so signing with it exercises the EC branch end-to-end.
    const EC_PRIV_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg+AExAiL6DEs0L9W8\nIm4W8Rr77DkGD8O2LhOJkL8ZkXmhRANCAAQwRcNqYyjm0j/SYMMwZtmpWEAaOKsY\nVdudgEhaR/9bUqx9pfrjGdRDIYhSuL8iZ5gVDYpVdWispSldEh3F+npQ\n-----END PRIVATE KEY-----\n";
    const EC_X: &str = "MEXDamMo5tI_0mDDMGbZqVhAGjirGFXbnYBIWkf_W1I";
    const EC_Y: &str = "rH2l-uMZ1EMhiFK4vyJnmBUNilV1aKylKV0SHcX6elA";

    fn ec_jwk() -> Jwk {
        Jwk {
            kid: TG_KID.to_string(),
            kty: "EC".to_string(),
            crv: Some("P-256".to_string()),
            n: None,
            e: None,
            x: Some(EC_X.to_string()),
            y: Some(EC_Y.to_string()),
        }
    }

    /// A Telegram verifier whose JWKS cache is pre-seeded with the local EC key and
    /// never expires — verifies locally-signed id_tokens with zero network.
    pub fn seeded_telegram_verifier() -> OidcVerifier {
        let verifier = OidcVerifier::telegram(TELEGRAM_CLIENT_ID.to_string());
        {
            let mut cache = verifier.cache.lock().expect("seed jwks cache");
            cache.keys = vec![ec_jwk()];
            cache.expires_at = u64::MAX;
        }
        verifier
    }

    /// Mint a Telegram OIDC id_token (ES256) valid for `ttl_secs` from now (pass a
    /// negative ttl for an already-expired token). `username` is optional.
    pub fn telegram_id_token(id: i64, name: &str, username: Option<&str>, ttl_secs: i64) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let mut claims = serde_json::json!({
            "iss": "https://oauth.telegram.org",
            "aud": TELEGRAM_CLIENT_ID,
            "sub": format!("tg-oidc-sub-{id}"),
            "id": id,
            "name": name,
            "iat": now,
            "exp": now + ttl_secs,
        });
        if let Some(u) = username {
            claims["preferred_username"] = serde_json::json!(u);
        }
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(TG_KID.to_string());
        let key = EncodingKey::from_ec_pem(EC_PRIV_PEM.as_bytes()).expect("load test EC key");
        encode(&header, &claims, &key).expect("sign telegram token")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};

    // ---- shared helpers ----

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    // ---- Google (RSA / RS256) ----

    // Test RSA keypair (2048-bit) generated offline; the matching JWK n/e are the
    // base64url modulus/exponent. Signs tokens locally so the RS256 + aud + iss +
    // exp path is exercised with no network and no real Google key.
    const TEST_PRIV_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDD3MBIphXH6Xk/\n/1TYzYgMeVrRmhZ1UhVPkOr+xkNiVUvDdA3Vt6gwL5Ckx7WbHdGK+ZjhUBZkBuf0\n+GTfEqHroaCJdFvwuSjrh6aaW2J4NWv+0BvKJkeTB27lNUNXt8MACpvwIjo21gEG\nP0++a1j4v8d8fPo4OgddhHdqi/ZXoBxlI0frhEpbxGsIjiQ3ZlhIRRs0Im8yOqKL\n8EKMZ+9jdoOQjg5YpiOJszF8IZWJVVWudVyxC6HUXt0iN6HuudqeI19VZatSyZfP\nyCgVggEWUsKXD7WSJ0/WmoGs3d38H4S3bXSK0j7E42zYurB3q89FHe2wccVdeP14\nA7JVNT3fAgMBAAECggEAIQSNxbF56oGJVyiL/SBo1vF+Redb8dssjIU5mEmEAoeu\nhfyCeIzFZZofICgqjUOxl2QMSa9elu4zHDDjkFdrxHUywvlCpooQQ+RSSaMuLmWT\nFxmuFZ3uYvLV1v3rpFXuIYuoTgr3FVduRMdXghpGnWh3EJ1g8SmXJES4fNWraYng\nZ0qJzedYeZ3ARM4K83bFlzluro/etwjGyqdbn2Li63CDNZrD958y5SMCencAfz3N\nQWLVMzQZMmIgexgDl7AaTXynA9Igh+/GzDruQrxg5SXLV1RcurnSUkbJ/oo/yg1G\nRXTHmNvNOpn67xaw7xXtlDXJryx2+cvFpNmG0lv+gQKBgQD2eRKHNkHgM3cvaztz\n1PwhQGmng/kSTXtyorNBS81MaPdkrz96R6TZ+1D0v80rxT+QPvUrgbhXwDz4xSnZ\nikKNG8i+ygdVipA5vsZvdi5JArjbodj0MRTF/4DAUrRYX8T0Xak5+VaAyJuyZP2d\nSSXwJY46JSgdRbAb9nB6mHO5dwKBgQDLbt7csGnAVWNvFsgJJKVTEYTuZ7bdkVc+\nSmqlhZjqM1OW3CnWj1sihwRyjWVmGWVgnItY5nGWrD8dVl5zUCy8mnoJROZ7vFpk\npaLApcEBQ3Uv4EYMGwj3q+ILYLy/KX2XhFTjT/fNCaU2oI+odVycVujqHTgWzQQH\nH1i9fI042QKBgQCvVU+N6lYQhOwLSpAfhWrayLSgWyyrDX18/irgj2j7K0yaTmSs\nuxyViMd9ZJgyw/3EwlSsX3pgyjtViQSNYWKYeSRkPNncy1ZwDbuh/QNOIuaYL1lj\n1Sp+85SGvA7ZMz+rypkgybP0p0DDNj6ITknzvPOhf186+6EdM0GupJbmXwKBgFgP\nYTdkwhI4pDdFREf47fu8XK+ag6T7silLq0iFQUE4AJoQKagwHAIhMgKoRFli6uhc\nO1G7RzYyz4tShMYj0Ym+0M7MXXz4dqSUspPz7E0wtzyHN6sr1MDpTYshT/Lr8eqx\npNFVH25JG5Q/ApCoZPNkB6S4CzyLeI/guNglXzhZAoGADVcaS/khJYvIPB4ILe/r\nNytKqNRZCmivoteJYSE86+2+Tdl+kWJEd1nJDoPap/8Ew6cGi5usktxz8+K0Hzwj\nXRkd+60xc8kMu5V+c7ihLIJ09sf1gm/6Vt31iqOUE1eXZ+HhPb9EAcQJzW7Sa3gR\nFss42L+9njP/i6MM3L1MmFo=\n-----END PRIVATE KEY-----\n";
    const TEST_JWK_N: &str = "w9zASKYVx-l5P_9U2M2IDHla0ZoWdVIVT5Dq_sZDYlVLw3QN1beoMC-QpMe1mx3RivmY4VAWZAbn9Phk3xKh66GgiXRb8Lko64emmltieDVr_tAbyiZHkwdu5TVDV7fDAAqb8CI6NtYBBj9PvmtY-L_HfHz6ODoHXYR3aov2V6AcZSNH64RKW8RrCI4kN2ZYSEUbNCJvMjqii_BCjGfvY3aDkI4OWKYjibMxfCGViVVVrnVcsQuh1F7dIjeh7rnaniNfVWWrUsmXz8goFYIBFlLClw-1kidP1pqBrN3d_B-Et210itI-xONs2Lqwd6vPRR3tsHHFXXj9eAOyVTU93w";
    const TEST_JWK_E: &str = "AQAB";
    const GOOGLE_CLIENT_ID: &str = "test-client.apps.googleusercontent.com";
    const GOOGLE_KID: &str = "rsa-kid";

    fn google_verifier() -> OidcVerifier {
        OidcVerifier::google(GOOGLE_CLIENT_ID.to_string())
    }

    fn rsa_jwk() -> Jwk {
        Jwk {
            kid: GOOGLE_KID.to_string(),
            kty: "RSA".to_string(),
            crv: None,
            n: Some(TEST_JWK_N.to_string()),
            e: Some(TEST_JWK_E.to_string()),
            x: None,
            y: None,
        }
    }

    fn sign_rs256(claims: serde_json::Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(GOOGLE_KID.to_string());
        let key = EncodingKey::from_rsa_pem(TEST_PRIV_PEM.as_bytes()).expect("load test RSA key");
        encode(&header, &claims, &key).expect("sign RS256 token")
    }

    #[test]
    fn google_valid_token_yields_claims() {
        let token = sign_rs256(serde_json::json!({
            "iss": "https://accounts.google.com",
            "aud": GOOGLE_CLIENT_ID,
            "sub": "google-user-123",
            "email": "Anna@Gmail.com",
            "email_verified": true,
            "name": "Anna",
            "exp": now() + 3600,
        }));
        let value = google_verifier()
            .verify_with_jwk(&token, &rsa_jwk())
            .expect("verify");
        let claims = GoogleClaims::from_claims(value).expect("extract");
        assert_eq!(claims.sub, "google-user-123");
        assert_eq!(claims.email.as_deref(), Some("anna@gmail.com")); // normalized
        assert!(claims.email_verified);
        assert_eq!(claims.name.as_deref(), Some("Anna"));
    }

    #[test]
    fn google_email_verified_accepts_string_true() {
        let token = sign_rs256(serde_json::json!({
            "iss": "accounts.google.com",
            "aud": GOOGLE_CLIENT_ID,
            "sub": "u",
            "email": "x@y.io",
            "email_verified": "true",
            "exp": now() + 3600,
        }));
        let value = google_verifier()
            .verify_with_jwk(&token, &rsa_jwk())
            .expect("verify");
        assert!(GoogleClaims::from_claims(value).expect("extract").email_verified);
    }

    #[test]
    fn google_wrong_audience_rejected() {
        let token = sign_rs256(serde_json::json!({
            "iss": "https://accounts.google.com",
            "aud": "attacker-client.apps.googleusercontent.com",
            "sub": "u",
            "exp": now() + 3600,
        }));
        assert!(google_verifier().verify_with_jwk(&token, &rsa_jwk()).is_err());
    }

    #[test]
    fn google_wrong_issuer_rejected() {
        let token = sign_rs256(serde_json::json!({
            "iss": "https://evil.example.com",
            "aud": GOOGLE_CLIENT_ID,
            "sub": "u",
            "exp": now() + 3600,
        }));
        assert!(google_verifier().verify_with_jwk(&token, &rsa_jwk()).is_err());
    }

    #[test]
    fn google_expired_token_rejected() {
        let token = sign_rs256(serde_json::json!({
            "iss": "https://accounts.google.com",
            "aud": GOOGLE_CLIENT_ID,
            "sub": "u",
            "exp": now() - 3600, // already expired (beyond default leeway)
        }));
        assert!(google_verifier().verify_with_jwk(&token, &rsa_jwk()).is_err());
    }

    #[test]
    fn google_tampered_signature_rejected() {
        let token = sign_rs256(serde_json::json!({
            "iss": "https://accounts.google.com",
            "aud": GOOGLE_CLIENT_ID,
            "sub": "u",
            "exp": now() + 3600,
        }));
        // Corrupt the FIRST character of the signature segment (after the last dot).
        let dot = token.rfind('.').unwrap();
        let (head, sig) = token.split_at(dot + 1);
        let first = sig.chars().next().unwrap();
        let swapped = if first == 'a' { 'b' } else { 'a' };
        let tampered = format!("{head}{swapped}{}", &sig[1..]);
        assert!(google_verifier().verify_with_jwk(&tampered, &rsa_jwk()).is_err());
    }

    // ---- Telegram (multi-algorithm OIDC) ----

    const TG_CLIENT_ID: &str = "111222333";

    fn telegram_verifier() -> OidcVerifier {
        OidcVerifier::telegram(TG_CLIENT_ID.to_string())
    }

    // EC P-256 (ES256) — Telegram's non-RSA default candidate.
    const EC_PRIV_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg+AExAiL6DEs0L9W8\nIm4W8Rr77DkGD8O2LhOJkL8ZkXmhRANCAAQwRcNqYyjm0j/SYMMwZtmpWEAaOKsY\nVdudgEhaR/9bUqx9pfrjGdRDIYhSuL8iZ5gVDYpVdWispSldEh3F+npQ\n-----END PRIVATE KEY-----\n";
    const EC_X: &str = "MEXDamMo5tI_0mDDMGbZqVhAGjirGFXbnYBIWkf_W1I";
    const EC_Y: &str = "rH2l-uMZ1EMhiFK4vyJnmBUNilV1aKylKV0SHcX6elA";
    // Ed25519 (EdDSA) — another advertised Telegram algorithm.
    const ED_PRIV_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIDBTCIeSxricHeXDWKXKLJ7fSPc5iMw9FcT3gbdS32Ac\n-----END PRIVATE KEY-----\n";
    const ED_X: &str = "dCyzV-4N_yKTpuGIbTDNxRNi9xE4QFRu7x4MBwi8KoE";

    fn ec_jwk() -> Jwk {
        Jwk {
            kid: "es256".to_string(),
            kty: "EC".to_string(),
            crv: Some("P-256".to_string()),
            n: None,
            e: None,
            x: Some(EC_X.to_string()),
            y: Some(EC_Y.to_string()),
        }
    }

    fn ed_jwk() -> Jwk {
        Jwk {
            kid: "eddsa".to_string(),
            kty: "OKP".to_string(),
            crv: Some("Ed25519".to_string()),
            n: None,
            e: None,
            x: Some(ED_X.to_string()),
            y: None,
        }
    }

    fn sign_es256(claims: serde_json::Value) -> String {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some("es256".to_string());
        let key = EncodingKey::from_ec_pem(EC_PRIV_PEM.as_bytes()).expect("load test EC key");
        encode(&header, &claims, &key).expect("sign ES256 token")
    }

    fn sign_eddsa(claims: serde_json::Value) -> String {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some("eddsa".to_string());
        let key = EncodingKey::from_ed_pem(ED_PRIV_PEM.as_bytes()).expect("load test Ed key");
        encode(&header, &claims, &key).expect("sign EdDSA token")
    }

    fn tg_claims(id: i64) -> serde_json::Value {
        serde_json::json!({
            "iss": "https://oauth.telegram.org",
            "aud": TG_CLIENT_ID,
            "sub": "opaque-oidc-sub",
            "id": id,
            "name": "Ann Telegram",
            "preferred_username": "ann_tg",
            "exp": now() + 3600,
        })
    }

    #[test]
    fn telegram_es256_token_yields_claims_keyed_on_id() {
        // Telegram may sign with ES256; the id claim (NOT sub) is the subject.
        let token = sign_es256(tg_claims(987654321));
        let value = telegram_verifier()
            .verify_with_jwk(&token, &ec_jwk())
            .expect("verify ES256");
        let claims = TelegramClaims::from_claims(value).expect("extract");
        assert_eq!(claims.subject(), "987654321"); // the Telegram user id, not sub
        assert_eq!(claims.display_name().as_deref(), Some("Ann Telegram"));
    }

    #[test]
    fn telegram_id_claim_accepted_as_string() {
        // Telegram serializes the user id as a JSON string in real tokens; the
        // subject is still that id, unchanged (not the opaque `sub`).
        let mut claims = tg_claims(0);
        claims["id"] = serde_json::json!("987654321"); // string, not number
        let token = sign_es256(claims);
        let value = telegram_verifier()
            .verify_with_jwk(&token, &ec_jwk())
            .expect("verify");
        assert_eq!(
            TelegramClaims::from_claims(value).expect("extract").subject(),
            "987654321"
        );
    }

    #[test]
    fn telegram_subject_falls_back_to_sub_when_id_absent() {
        // A token carrying only the standard OIDC `sub` still identifies the user.
        let mut claims = tg_claims(0);
        claims.as_object_mut().unwrap().remove("id");
        claims["sub"] = serde_json::json!("oidc-sub-xyz");
        let token = sign_es256(claims);
        let value = telegram_verifier()
            .verify_with_jwk(&token, &ec_jwk())
            .expect("verify");
        assert_eq!(
            TelegramClaims::from_claims(value).expect("extract").subject(),
            "oidc-sub-xyz"
        );
    }

    #[test]
    fn telegram_eddsa_token_verifies() {
        // The OKP/Ed25519 branch is a real supported algorithm — prove it verifies.
        let token = sign_eddsa(tg_claims(42));
        let value = telegram_verifier()
            .verify_with_jwk(&token, &ed_jwk())
            .expect("verify EdDSA");
        assert_eq!(
            TelegramClaims::from_claims(value).expect("extract").subject(),
            "42"
        );
    }

    #[test]
    fn telegram_wrong_audience_rejected() {
        let mut claims = tg_claims(1);
        claims["aud"] = serde_json::json!("999999"); // a different bot
        let token = sign_es256(claims);
        assert!(telegram_verifier().verify_with_jwk(&token, &ec_jwk()).is_err());
    }

    #[test]
    fn telegram_wrong_issuer_rejected() {
        let mut claims = tg_claims(1);
        claims["iss"] = serde_json::json!("https://evil.example.com");
        let token = sign_es256(claims);
        assert!(telegram_verifier().verify_with_jwk(&token, &ec_jwk()).is_err());
    }

    #[test]
    fn telegram_expired_token_rejected() {
        let mut claims = tg_claims(1);
        claims["exp"] = serde_json::json!(now() - 3600);
        let token = sign_es256(claims);
        assert!(telegram_verifier().verify_with_jwk(&token, &ec_jwk()).is_err());
    }

    #[test]
    fn telegram_tampered_signature_rejected() {
        let token = sign_es256(tg_claims(1));
        let dot = token.rfind('.').unwrap();
        let (head, sig) = token.split_at(dot + 1);
        let first = sig.chars().next().unwrap();
        let swapped = if first == 'a' { 'b' } else { 'a' };
        let tampered = format!("{head}{swapped}{}", &sig[1..]);
        assert!(telegram_verifier().verify_with_jwk(&tampered, &ec_jwk()).is_err());
    }

    #[test]
    fn telegram_display_name_falls_back_to_username() {
        let claims = TelegramClaims {
            subject: "5".to_string(),
            name: Some("  ".to_string()), // blank → skipped
            preferred_username: Some("nick".to_string()),
            picture: None,
        };
        assert_eq!(claims.display_name().as_deref(), Some("@nick"));
        let none = TelegramClaims {
            subject: "6".to_string(),
            name: None,
            preferred_username: None,
            picture: None,
        };
        assert!(none.display_name().is_none());
    }

    // ---- key-type dispatch ----

    #[test]
    fn unsupported_key_type_is_none_not_panic() {
        // secp256k1 (ES256K) is advertised by Telegram but unsupported by our JWT
        // library: dispatch returns None (→ 401 at the call site), never a panic.
        let es256k = Jwk {
            kid: "es256k".to_string(),
            kty: "EC".to_string(),
            crv: Some("secp256k1".to_string()),
            n: None,
            e: None,
            x: Some(EC_X.to_string()),
            y: Some(EC_Y.to_string()),
        };
        assert!(es256k.decoding().is_none());
        // And a token "signed" under it fails closed rather than verifying.
        let token = sign_es256(tg_claims(1));
        assert!(telegram_verifier().verify_with_jwk(&token, &es256k).is_err());
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
