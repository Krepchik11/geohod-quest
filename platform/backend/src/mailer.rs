//! §6.2/§6.3 — transactional email (password reset links, email confirmation).
//!
//! One trait-like enum, three transports:
//! - `Smtp` — real delivery via `SMTP_URL` (`smtps://user:pass@host[:port]`);
//! - `Log` — no SMTP configured: the full mail (incl. the action link) goes to
//!   the server log, so a dev/staging operator can still complete the flow;
//! - `Recorder` — tests capture outgoing mail to extract tokens.
//!
//! Sending is best-effort at call sites: an unreachable SMTP must never fail
//! the registration that triggered the mail.

use std::sync::{Arc, Mutex};

use lettre::{
    AsyncTransport, Message, Tokio1Executor, message::header::ContentType,
    transport::smtp::AsyncSmtpTransport,
};

#[derive(Clone, Debug, PartialEq)]
pub struct OutgoingMail {
    pub to: String,
    pub subject: String,
    pub body: String,
}

#[derive(Clone)]
pub enum Mailer {
    Smtp {
        transport: AsyncSmtpTransport<Tokio1Executor>,
        from: String,
    },
    Log,
    /// Test transport — integration tests read tokens out of the outbox.
    /// Constructed only from #[cfg(test)] code, hence the allow.
    #[allow(dead_code)]
    Recorder(Arc<Mutex<Vec<OutgoingMail>>>),
}

impl std::fmt::Debug for Mailer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Smtp { from, .. } => write!(f, "Mailer::Smtp{{from:{from}}}"),
            Self::Log => write!(f, "Mailer::Log"),
            Self::Recorder(_) => write!(f, "Mailer::Recorder"),
        }
    }
}

impl Mailer {
    /// Build from env-style config: `smtp_url` (`smtps://user:pass@host[:port]`)
    /// + `from`. No URL → the honest Log transport.
    pub fn from_config(smtp_url: Option<&str>, from: &str) -> Self {
        match smtp_url {
            Some(url) if !url.trim().is_empty() => {
                match AsyncSmtpTransport::<Tokio1Executor>::from_url(url) {
                    Ok(builder) => Self::Smtp {
                        transport: builder.build(),
                        from: from.to_string(),
                    },
                    Err(e) => {
                        tracing::error!("invalid SMTP_URL ({e}); falling back to log mailer");
                        Self::Log
                    }
                }
            }
            _ => Self::Log,
        }
    }

    #[allow(dead_code)]
    pub fn recorder() -> (Self, Arc<Mutex<Vec<OutgoingMail>>>) {
        let store = Arc::new(Mutex::new(Vec::new()));
        (Self::Recorder(store.clone()), store)
    }

    /// Send one plain-text mail. Errors are returned so the caller can decide
    /// whether the flow is best-effort (registration) or should surface.
    pub async fn send(&self, to: &str, subject: &str, body: &str) -> Result<(), String> {
        match self {
            Self::Smtp { transport, from } => {
                let msg = Message::builder()
                    .from(from.parse().map_err(|e| format!("from: {e}"))?)
                    .to(to.parse().map_err(|e| format!("to: {e}"))?)
                    .subject(subject)
                    .header(ContentType::TEXT_PLAIN)
                    .body(body.to_string())
                    .map_err(|e| format!("build: {e}"))?;
                transport
                    .send(msg)
                    .await
                    .map(|_| ())
                    .map_err(|e| format!("smtp: {e}"))
            }
            Self::Log => {
                tracing::info!(to, subject, body, "MAIL (no SMTP configured — logged only)");
                Ok(())
            }
            Self::Recorder(store) => {
                store
                    .lock()
                    .map_err(|_| "recorder poisoned".to_string())?
                    .push(OutgoingMail {
                        to: to.to_string(),
                        subject: subject.to_string(),
                        body: body.to_string(),
                    });
                Ok(())
            }
        }
    }
}

/// Mask an email for the «Письмо ушло» copy: `anna@gmail.com` → `an***@gmail.com`.
pub fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let keep: String = local.chars().take(2).collect();
            format!("{keep}***@{domain}")
        }
        None => "***".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn recorder_captures_mail() {
        let (mailer, store) = Mailer::recorder();
        mailer.send("a@b.c", "Тема", "Тело").await.expect("send");
        assert_eq!(
            store.lock().expect("lock").as_slice(),
            &[OutgoingMail {
                to: "a@b.c".into(),
                subject: "Тема".into(),
                body: "Тело".into()
            }]
        );
    }

    #[test]
    fn masking_keeps_two_chars_and_domain() {
        assert_eq!(mask_email("anna@gmail.com"), "an***@gmail.com");
        assert_eq!(mask_email("a@x.ru"), "a***@x.ru");
        assert_eq!(mask_email("garbage"), "***");
    }

    #[test]
    fn from_config_without_url_logs() {
        assert!(matches!(Mailer::from_config(None, "x@y.z"), Mailer::Log));
        assert!(matches!(
            Mailer::from_config(Some(""), "x@y.z"),
            Mailer::Log
        ));
    }
}
