//! YooKassa gateway (redirect + webhook flow, <https://yookassa.ru/developers/api>).
//!
//! Split per the repo convention: PURE helpers (request bodies, response and
//! notification parsing, amount formatting) carry all the decisions and are
//! unit-tested without I/O; the HTTP shell is a thin blocking attohttpc call
//! moved off the runtime with `spawn_blocking` (same idiom and TLS stack as the
//! JWKS fetch in `social.rs`). Tests inject the scripted `Fake` variant — the
//! real API is never called from a test (mailer-recorder pattern).

use std::sync::{Arc, Mutex};

use crate::config::YookassaConfig;
use crate::errors::AppError;

/// Production API base; overridable via `YOOKASSA_API_BASE` (local mock only).
pub const DEFAULT_API_BASE: &str = "https://api.yookassa.ru/v3";

/// YooKassa caps `description` at 128 characters.
const MAX_DESCRIPTION_CHARS: usize = 128;

/// Payment status as YooKassa reports it. `capture: true` (one-stage) payments
/// go `pending -> succeeded | canceled`; `WaitingForCapture` cannot occur for
/// them but is parsed defensively (it is NOT a settled state — no grant).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RemoteStatus {
    Pending,
    WaitingForCapture,
    Succeeded,
    Canceled,
}

impl RemoteStatus {
    /// Parse the wire status. Unknown strings map to `Pending` (fail-safe: an
    /// unrecognized status must never mint a grant) and are logged by callers.
    fn parse(s: &str) -> Self {
        match s {
            "succeeded" => Self::Succeeded,
            "canceled" => Self::Canceled,
            "waiting_for_capture" => Self::WaitingForCapture,
            _ => Self::Pending,
        }
    }
}

/// The slice of a YooKassa payment object this integration consumes.
#[derive(Clone, Debug, PartialEq)]
pub struct RemotePayment {
    pub id: String,
    pub status: RemoteStatus,
    /// Present while the payment awaits the payer (confirmation.confirmation_url).
    pub confirmation_url: Option<String>,
}

/// Format a whole-ruble price as the YooKassa decimal string (`490 -> "490.00"`).
pub fn format_amount(rub: i64) -> String {
    format!("{rub}.00")
}

/// Build the `POST /v3/payments` body: one-stage charge (`capture: true`) with
/// a redirect confirmation back to `return_url`. `metadata` carries our ids for
/// human audit in the YooKassa dashboard; the webhook does NOT rely on it.
pub fn build_create_payment(
    amount_rub: i64,
    description: &str,
    return_url: &str,
    user_id: &str,
    quest_id: &str,
) -> serde_json::Value {
    let description: String = description.chars().take(MAX_DESCRIPTION_CHARS).collect();
    serde_json::json!({
        "amount": { "value": format_amount(amount_rub), "currency": "RUB" },
        "capture": true,
        "confirmation": { "type": "redirect", "return_url": return_url },
        "description": description,
        "metadata": { "user_id": user_id, "quest_id": quest_id },
    })
}

/// Parse a payment object (create response, GET response, or the `object` of a
/// notification) into the fields we consume.
pub fn parse_payment(v: &serde_json::Value) -> Result<RemotePayment, AppError> {
    let id = v
        .get("id")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("yookassa payment without id: {v}")))?;
    let status = v
        .get("status")
        .and_then(|x| x.as_str())
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("yookassa payment without status")))?;
    let confirmation_url = v
        .get("confirmation")
        .and_then(|c| c.get("confirmation_url"))
        .and_then(|u| u.as_str())
        .map(String::from);
    Ok(RemotePayment {
        id: id.to_string(),
        status: RemoteStatus::parse(status),
        confirmation_url,
    })
}

/// Extract the payment id a webhook notification points at. The body is used
/// ONLY as a pointer — settlement re-fetches the payment from the API, so a
/// forged notification can never mint a grant. `None` = not a payment event.
pub fn notification_payment_id(v: &serde_json::Value) -> Option<String> {
    let event = v.get("event")?.as_str()?;
    if !event.starts_with("payment.") {
        return None;
    }
    let id = v.get("object")?.get("id")?.as_str()?;
    (!id.is_empty()).then(|| id.to_string())
}

/// A scripted in-process YooKassa for tests: `create_payment` mints sequential
/// pending payments; the test flips statuses with [`FakeYookassa::set_status`].
#[derive(Debug, Default)]
pub struct FakeYookassa {
    payments: std::collections::HashMap<String, RemotePayment>,
    next_id: u64,
    /// Last create request body, for asserting amount/description/return_url.
    pub last_create_body: Option<serde_json::Value>,
}

impl FakeYookassa {
    /// Flip a scripted payment's status (what the payer/bank did remotely).
    /// Called only from #[cfg(test)] code, hence the allow.
    #[allow(dead_code)]
    pub fn set_status(&mut self, payment_id: &str, status: RemoteStatus) {
        if let Some(p) = self.payments.get_mut(payment_id) {
            p.status = status;
        }
    }
}

/// Outbound YooKassa transport: real HTTP in production, scripted state in
/// tests. Selected once at startup from config (see `main.rs` state builders).
#[derive(Clone, Debug)]
pub enum YookassaGateway {
    Http(YookassaConfig),
    /// Constructed only from #[cfg(test)] code, hence the allow.
    #[allow(dead_code)]
    Fake(Arc<Mutex<FakeYookassa>>),
}

/// Run a blocking gateway call off the async runtime (social.rs JWKS idiom).
async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("yookassa task: {e}")))?
}

impl YookassaGateway {
    #[allow(dead_code)]
    pub fn fake() -> (Self, Arc<Mutex<FakeYookassa>>) {
        let state = Arc::new(Mutex::new(FakeYookassa::default()));
        (Self::Fake(state.clone()), state)
    }

    /// `POST /v3/payments` under the given idempotence key (YooKassa replays
    /// the original result for a repeated key within 24h).
    pub async fn create_payment(
        &self,
        idempotence_key: &str,
        body: serde_json::Value,
    ) -> Result<RemotePayment, AppError> {
        match self {
            Self::Http(cfg) => {
                let cfg = cfg.clone();
                let key = idempotence_key.to_string();
                run_blocking(move || {
                    let resp = attohttpc::post(format!("{}/payments", cfg.api_base))
                        .basic_auth(cfg.shop_id, Some(cfg.secret_key))
                        .header("Idempotence-Key", &key)
                        .json(&body)
                        .map_err(|e| gateway_err("encode create payment", &e))?
                        .send()
                        .map_err(|e| gateway_err("create payment", &e))?;
                    read_payment(resp)
                })
                .await
            }
            Self::Fake(state) => {
                let mut fake = lock_fake(state)?;
                fake.next_id += 1;
                fake.last_create_body = Some(body);
                let payment = RemotePayment {
                    id: format!("yk-{}", fake.next_id),
                    status: RemoteStatus::Pending,
                    confirmation_url: Some(format!(
                        "https://yookassa.test/confirm/yk-{}",
                        fake.next_id
                    )),
                };
                fake.payments.insert(payment.id.clone(), payment.clone());
                Ok(payment)
            }
        }
    }

    /// `GET /v3/payments/{id}` — the authoritative status used by settlement.
    pub async fn fetch_payment(&self, payment_id: &str) -> Result<RemotePayment, AppError> {
        match self {
            Self::Http(cfg) => {
                let cfg = cfg.clone();
                let url = format!("{}/payments/{payment_id}", cfg.api_base);
                run_blocking(move || {
                    let resp = attohttpc::get(&url)
                        .basic_auth(cfg.shop_id, Some(cfg.secret_key))
                        .send()
                        .map_err(|e| gateway_err("fetch payment", &e))?;
                    read_payment(resp)
                })
                .await
            }
            Self::Fake(state) => lock_fake(state)?
                .payments
                .get(payment_id)
                .cloned()
                .ok_or_else(|| {
                    AppError::Internal(anyhow::anyhow!("fake yookassa: unknown {payment_id}"))
                }),
        }
    }
}

fn lock_fake(
    state: &Arc<Mutex<FakeYookassa>>,
) -> Result<std::sync::MutexGuard<'_, FakeYookassa>, AppError> {
    state
        .lock()
        .map_err(|_| AppError::Internal(anyhow::anyhow!("fake yookassa lock poisoned")))
}

/// Map a transport error without ever logging credentials (they live only in
/// the request builder, never in `e`).
fn gateway_err(what: &str, e: &dyn std::fmt::Display) -> AppError {
    AppError::Internal(anyhow::anyhow!("yookassa {what} failed: {e}"))
}

/// Read a payment object out of a YooKassa HTTP response, surfacing API errors
/// (4xx/5xx carry `{type: "error", description}`) with their description.
fn read_payment(resp: attohttpc::Response) -> Result<RemotePayment, AppError> {
    let status = resp.status();
    let body: serde_json::Value = resp.json().map_err(|e| gateway_err("parse response", &e))?;
    if !status.is_success() {
        let desc = body
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("no description");
        return Err(AppError::Internal(anyhow::anyhow!(
            "yookassa API {status}: {desc}"
        )));
    }
    parse_payment(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amount_is_decimal_rubles() {
        assert_eq!(format_amount(490), "490.00");
        assert_eq!(format_amount(0), "0.00");
        assert_eq!(format_amount(1), "1.00");
    }

    #[test]
    fn create_body_carries_redirect_and_capture() {
        let body = build_create_payment(
            490,
            "Квест «Тест»",
            "https://f/q?payment=p1",
            "dev:a",
            "q-1",
        );
        assert_eq!(body["amount"]["value"], "490.00");
        assert_eq!(body["amount"]["currency"], "RUB");
        assert_eq!(body["capture"], true);
        assert_eq!(body["confirmation"]["type"], "redirect");
        assert_eq!(body["confirmation"]["return_url"], "https://f/q?payment=p1");
        assert_eq!(body["description"], "Квест «Тест»");
        assert_eq!(body["metadata"]["user_id"], "dev:a");
        assert_eq!(body["metadata"]["quest_id"], "q-1");
    }

    #[test]
    fn create_body_truncates_description_to_128_chars() {
        let long = "х".repeat(200);
        let body = build_create_payment(1, &long, "https://f", "p", "q");
        let desc = body["description"].as_str().expect("description");
        assert_eq!(desc.chars().count(), 128);
    }

    #[test]
    fn payment_parses_status_and_confirmation_url() {
        let v = serde_json::json!({
            "id": "2e8b3f4a", "status": "pending",
            "confirmation": {"type": "redirect", "confirmation_url": "https://yookassa.ru/c/x"}
        });
        assert_eq!(
            parse_payment(&v).expect("parse"),
            RemotePayment {
                id: "2e8b3f4a".into(),
                status: RemoteStatus::Pending,
                confirmation_url: Some("https://yookassa.ru/c/x".into()),
            }
        );
    }

    #[test]
    fn payment_statuses_parse_and_unknown_is_pending() {
        for (wire, want) in [
            ("succeeded", RemoteStatus::Succeeded),
            ("canceled", RemoteStatus::Canceled),
            ("waiting_for_capture", RemoteStatus::WaitingForCapture),
            ("pending", RemoteStatus::Pending),
            ("some_future_status", RemoteStatus::Pending),
        ] {
            let v = serde_json::json!({"id": "p", "status": wire});
            assert_eq!(parse_payment(&v).expect("parse").status, want, "{wire}");
        }
    }

    #[test]
    fn payment_without_id_or_status_is_rejected() {
        assert!(parse_payment(&serde_json::json!({"status": "pending"})).is_err());
        assert!(parse_payment(&serde_json::json!({"id": "p"})).is_err());
        assert!(parse_payment(&serde_json::json!({"id": "", "status": "pending"})).is_err());
    }

    #[test]
    fn notification_yields_payment_id_only_for_payment_events() {
        let succeeded = serde_json::json!({
            "type": "notification", "event": "payment.succeeded",
            "object": {"id": "yk-9", "status": "succeeded"}
        });
        assert_eq!(notification_payment_id(&succeeded).as_deref(), Some("yk-9"));
        let refund = serde_json::json!({
            "type": "notification", "event": "refund.succeeded", "object": {"id": "r-1"}
        });
        assert_eq!(notification_payment_id(&refund), None);
        assert_eq!(notification_payment_id(&serde_json::json!({})), None);
        let empty_id = serde_json::json!({"event": "payment.canceled", "object": {"id": ""}});
        assert_eq!(notification_payment_id(&empty_id), None);
    }

    #[tokio::test]
    async fn fake_gateway_scripts_the_remote_lifecycle() {
        let (gw, state) = YookassaGateway::fake();
        let body = build_create_payment(100, "d", "https://r", "p", "q");
        let created = gw.create_payment("key-1", body).await.expect("create");
        assert_eq!(created.status, RemoteStatus::Pending);
        let url = created.confirmation_url.clone().expect("url");
        assert!(url.contains(&created.id));

        state
            .lock()
            .expect("lock")
            .set_status(&created.id, RemoteStatus::Succeeded);
        let fetched = gw.fetch_payment(&created.id).await.expect("fetch");
        assert_eq!(fetched.status, RemoteStatus::Succeeded);
        assert!(gw.fetch_payment("ghost").await.is_err());
    }
}
