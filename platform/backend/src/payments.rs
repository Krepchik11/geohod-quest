//! Payment provider seam (locked owner decision: "payment provider = stub behind
//! interface"). The MVP provider is an always-approving mock whose `payment_ref`
//! is recorded on the grant (`source_ref`) for audit. Coupon-100% and free paths
//! bypass the provider entirely — there is nothing to charge.

/// Outcome of a charge. The mock only approves; a real provider adds declined /
/// pending variants behind this same seam (the checkout handler is the one caller).
#[derive(Clone, Debug, PartialEq)]
pub enum PaymentOutcome {
    /// Charge accepted; `payment_ref` is the provider's transaction reference.
    Approved { payment_ref: String },
}

/// The seam a real provider (e.g. YooKassa redirect + webhook) will implement.
pub trait PaymentProvider: Send + Sync + std::fmt::Debug {
    /// Charge the player for the quest. The mock is synchronous and infallible;
    /// a real provider returns a redirect/pending flow behind this method.
    fn charge(&self, player_id: &str, quest_id: &str) -> PaymentOutcome;
}

/// Always-approving mock. The ref is deterministic per (player, quest) so the
/// idempotent grant keeps a stable audit trail across retries and tests.
#[derive(Clone, Debug, Default)]
pub struct MockPaymentProvider;

impl PaymentProvider for MockPaymentProvider {
    fn charge(&self, player_id: &str, quest_id: &str) -> PaymentOutcome {
        PaymentOutcome::Approved {
            payment_ref: format!("mock-pay-{player_id}-{quest_id}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_always_approves_with_deterministic_ref() {
        let p = MockPaymentProvider;
        let first = p.charge("dev:abc", "quest-q");
        let again = p.charge("dev:abc", "quest-q");
        assert_eq!(first, again, "stable ref for the idempotent grant");
        let PaymentOutcome::Approved { payment_ref } = first;
        assert_eq!(payment_ref, "mock-pay-dev:abc-quest-q");
    }
}
