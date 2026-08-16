//! Feature toggles: the registry is code, the switch is runtime.
//!
//! Each toggleable feature is an enum variant with a stable wire key and a
//! compiled-in default — adding a flag is a code change, so the set of flags
//! is always reviewable and exhaustively matched. What an admin controls at
//! runtime is only the *override* (a persisted bool per key; see
//! `store::FlagStores` and the `feature_overrides` table).
//!
//! Evaluation is two independent gates, both fail-closed:
//! - **capability** — the deployment is configured for the feature
//!   (credentials present); a flag can never switch on what the deployment
//!   cannot do.
//! - **toggle** — `override.unwrap_or(default)`; clearing the override
//!   returns the flag to its code default.

use crate::AppState;
use crate::errors::AppError;

/// A feature an admin can switch at runtime. Variants are the whole registry;
/// overrides stored under keys no variant claims are ignored (stale rows from
/// removed flags are harmless).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feature {
    /// "Sign in with Google" (`/api/auth/google` + its button).
    AuthGoogle,
    /// Telegram login (`/api/auth/telegram` + its button).
    AuthTelegram,
    /// The always-approving mock payment provider (dev/test checkout path).
    PaymentsMock,
    /// The YooKassa redirect payment provider.
    PaymentsYookassa,
    /// Player runtime: the browser/system back button rewinds one quest step
    /// instead of leaving the play screen.
    PlayerBackButton,
    /// Player runtime: the platform-wide universal answer (its value is the
    /// `universal_answer` runtime setting — `crate::settings`) is accepted on
    /// every answer step of every quest.
    PlayerUniversalAnswer,
}

impl Feature {
    /// Every registered feature, in the order the admin panel lists them.
    pub const ALL: [Self; 6] = [
        Self::AuthGoogle,
        Self::AuthTelegram,
        Self::PaymentsMock,
        Self::PaymentsYookassa,
        Self::PlayerBackButton,
        Self::PlayerUniversalAnswer,
    ];

    /// Stable wire/storage key. Never reuse a retired key for a new feature —
    /// a stale override row would silently apply to it.
    pub fn key(self) -> &'static str {
        match self {
            Self::AuthGoogle => "auth_google",
            Self::AuthTelegram => "auth_telegram",
            Self::PaymentsMock => "payments_mock",
            Self::PaymentsYookassa => "payments_yookassa",
            Self::PlayerBackButton => "player_back_button",
            Self::PlayerUniversalAnswer => "player_universal_answer",
        }
    }

    /// Whether the flag's effective verdict is served to unauthenticated
    /// clients via GET /api/features. Only flags the client *runtime* keys
    /// behavior off belong here — server-enforced flags (auth, payments)
    /// already reach the client through their provider capability endpoints.
    pub fn client_visible(self) -> bool {
        matches!(self, Self::PlayerBackButton | Self::PlayerUniversalAnswer)
    }

    /// Compiled-in default, used when no override is stored. Every flag ships
    /// OFF — enabling a feature is always an explicit admin decision (a stored
    /// override). Nothing seeds overrides, so a fresh deployment of either
    /// backing store starts with every feature off.
    pub fn default_enabled(self) -> bool {
        false
    }

    /// Inverse of [`Self::key`]: `None` for unknown keys (admin API answers 404).
    pub fn parse(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.key() == key)
    }

    /// THE toggle rule, in one place: the stored override when present, the
    /// code default otherwise. Every evaluation site goes through here.
    pub fn effective(self, override_enabled: Option<bool>) -> bool {
        override_enabled.unwrap_or(self.default_enabled())
    }
}

/// The runtime toggle verdict for a feature: the admin override when one is
/// stored, the code default otherwise. This is only the *toggle* half of the
/// evaluation — capability ([`feature_available`]) is enforced by the gated
/// endpoints themselves, so a flag can never enable what the deployment
/// cannot do.
pub async fn feature_enabled(state: &AppState, feature: Feature) -> Result<bool, AppError> {
    Ok(feature.effective(state.flags.get(feature.key()).await?))
}

/// The capability half: whether this deployment is configured for the feature
/// at all (credentials present). Reported to the admin panel so a switched-on
/// but unconfigured flag is visibly inert.
pub(crate) fn feature_available(state: &AppState, feature: Feature) -> bool {
    match feature {
        Feature::AuthGoogle => state.google.is_some(),
        Feature::AuthTelegram => state.telegram.is_some(),
        Feature::PaymentsMock => true,
        Feature::PaymentsYookassa => state.yookassa.is_some(),
        // Pure client behavior — nothing to configure server-side.
        Feature::PlayerBackButton => true,
        // Client-side matching; the answer value is a runtime setting, so
        // there is no deployment capability to check.
        Feature::PlayerUniversalAnswer => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_and_are_unique() {
        for f in Feature::ALL {
            assert_eq!(Feature::parse(f.key()), Some(f));
        }
        let mut keys: Vec<_> = Feature::ALL.iter().map(|f| f.key()).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), Feature::ALL.len());
    }

    #[test]
    fn unknown_key_is_rejected() {
        assert_eq!(Feature::parse("payments_paypal"), None);
        assert_eq!(Feature::parse(""), None);
        // Keys are exact — no case folding, no trimming.
        assert_eq!(Feature::parse("Auth_Google"), None);
    }

    #[test]
    fn all_flags_default_off() {
        for f in Feature::ALL {
            assert!(!f.default_enabled(), "{} must default off", f.key());
        }
    }

    #[test]
    fn effective_is_override_or_default() {
        let f = Feature::PaymentsMock; // defaults off, like every flag
        assert!(!f.effective(None));
        assert!(f.effective(Some(true)));
        assert!(!f.effective(Some(false)));
    }

    /// Player-runtime flags key client behavior, so the player reads their
    /// verdict from GET /api/features. Server-enforced flags (auth, payments)
    /// must NOT be listed there — their state already reaches the client
    /// through the provider capability endpoints.
    #[test]
    fn only_player_runtime_flags_are_client_visible() {
        for key in ["player_back_button", "player_universal_answer"] {
            let f = Feature::parse(key).expect("registered");
            assert!(f.client_visible(), "{key} must be client visible");
        }
        for key in [
            "auth_google",
            "auth_telegram",
            "payments_mock",
            "payments_yookassa",
        ] {
            let f = Feature::parse(key).expect("registered");
            assert!(!f.client_visible(), "{key} must not be client visible");
        }
    }
}
