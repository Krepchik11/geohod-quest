//! Feature toggles: the registry is code, the switch is runtime.
//!
//! Each toggleable feature is an enum variant with a stable wire key and a
//! compiled-in default — adding a flag is a code change, so the set of flags
//! is always reviewable and exhaustively matched. What an admin controls at
//! runtime is only the *override* (a persisted bool per key; see
//! `store::FlagStores` and `migrations/0012_feature_flags.sql`).
//!
//! Evaluation is two independent gates, both fail-closed:
//! - **capability** — the deployment is configured for the feature
//!   (credentials present); a flag can never switch on what the deployment
//!   cannot do.
//! - **toggle** — `override.unwrap_or(default)`; clearing the override
//!   returns the flag to its code default.

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
    /// override). Nothing seeds overrides, so a fresh deployment starts fully off.
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

    /// The player back-button flag: registered, off by default, not seeded on
    /// (it postdates the default-off policy), and exposed to the client — the
    /// player runtime reads it from GET /api/features.
    #[test]
    fn player_back_button_registered_off_and_client_visible() {
        // One contract for every post-policy player-runtime flag: off by
        // default, not seeded, and served via GET /api/features.
        for key in ["player_back_button", "player_universal_answer"] {
            let f = Feature::parse(key).expect("registered");
            assert!(!f.default_enabled(), "{key} must default off");
            assert!(f.client_visible(), "{key} must be client visible");
        }
    }

}
