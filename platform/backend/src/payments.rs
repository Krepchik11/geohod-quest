//! Payment domain: the always-approving mock (dev/test provider, selectable at
//! checkout) and the pending state of redirect payments (YooKassa, `yookassa.rs`).
//! Checkout dispatches per request on `CheckoutRequest.provider`; coupon-100%
//! and free paths bypass every provider — there is nothing to charge.

/// Always-approving mock: settles instantly with a payment ref recorded on the
/// grant (`source_ref`) for audit. The ref is deterministic per (player, quest)
/// so the idempotent grant keeps a stable audit trail across retries and tests.
pub fn mock_payment_ref(user_id: &str, quest_id: &str) -> String {
    format!("mock-pay-{user_id}-{quest_id}")
}

/// Lifecycle of a redirect-provider payment (YooKassa). One-way:
/// `Pending -> Succeeded | Canceled`; the succeeded transition is a CAS in the
/// store so exactly one settle call wins (and redeems the attached coupon).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PendingStatus {
    Pending,
    Succeeded,
    Canceled,
}

impl PendingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Succeeded => "succeeded",
            Self::Canceled => "canceled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "succeeded" => Some(Self::Succeeded),
            "canceled" => Some(Self::Canceled),
            _ => None,
        }
    }
}

/// An in-flight redirect payment, persisted between checkout and settlement.
///
/// `id` is OUR identifier: it rides the return_url back to the frontend, keys
/// the poll endpoint, and doubles as the YooKassa `Idempotence-Key` (so a
/// crashed checkout retried with the same row cannot double-charge).
/// `coupon_code` is the promo held for settlement — redeemed ONLY when the
/// payment succeeds, so an abandoned payment never burns the code.
#[derive(Clone, Debug, PartialEq)]
pub struct PendingPayment {
    pub id: String,
    pub provider_payment_id: String,
    pub user_id: String,
    pub quest_id: String,
    pub coupon_code: Option<String>,
    /// Whole rubles actually charged (price minus any partial discount).
    pub amount: i64,
    /// Full quest price at checkout time — the discount base the settlement
    /// passes to the coupon redemption (no re-fetch, no repricing drift).
    pub price: i64,
    /// Payer-facing gateway page; replayed on repeat checkouts while pending.
    pub confirmation_url: String,
    pub status: PendingStatus,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_status_round_trips_and_rejects_unknown() {
        for s in [
            PendingStatus::Pending,
            PendingStatus::Succeeded,
            PendingStatus::Canceled,
        ] {
            assert_eq!(PendingStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(PendingStatus::parse("waiting_for_capture"), None);
    }

    #[test]
    fn mock_ref_is_deterministic_per_player_and_quest() {
        assert_eq!(
            mock_payment_ref("dev:abc", "quest-q"),
            mock_payment_ref("dev:abc", "quest-q"),
            "stable ref for the idempotent grant"
        );
        assert_eq!(
            mock_payment_ref("dev:abc", "quest-q"),
            "mock-pay-dev:abc-quest-q"
        );
    }
}
