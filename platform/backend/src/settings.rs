//! Runtime string settings: the registry is code, the value is runtime.
//!
//! The same philosophy as `crate::features` — each admin-editable setting is
//! an enum variant with a stable wire key, so the set of settings is always
//! reviewable and exhaustively matched. What an admin controls at runtime is
//! only the stored *value* (a persisted string per key; see
//! `store::SettingsStores` and the `app_settings` table). Absence of
//! a row means "unset" — there are no compiled-in default values.
//!
//! Values are normalized on write: surrounding whitespace is trimmed and an
//! empty result clears the row, so "unset" has exactly one representation.

/// A runtime setting an admin can edit. Variants are the whole registry;
/// stored rows under keys no variant claims are ignored (stale rows from
/// retired settings are harmless).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Setting {
    /// The platform-wide universal answer accepted on every answer step while
    /// the `player_universal_answer` feature flag is on.
    UniversalAnswer,
}

impl Setting {
    /// Every registered setting.
    pub const ALL: [Self; 1] = [Self::UniversalAnswer];

    /// Stable wire/storage key. Never reuse a retired key for a new setting —
    /// a stale row would silently become its value.
    pub fn key(self) -> &'static str {
        match self {
            Self::UniversalAnswer => "universal_answer",
        }
    }

    /// Inverse of [`Self::key`]: `None` for unknown keys (admin API answers 404).
    pub fn parse(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.key() == key)
    }

    /// THE write normalization, in one place: trim, and treat empty as unset.
    /// Every write path goes through here so "unset" has one representation.
    pub fn normalize(value: Option<&str>) -> Option<String> {
        value
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_and_are_unique() {
        for s in Setting::ALL {
            assert_eq!(Setting::parse(s.key()), Some(s));
        }
        let mut keys: Vec<_> = Setting::ALL.iter().map(|s| s.key()).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), Setting::ALL.len());
    }

    #[test]
    fn unknown_key_is_rejected() {
        assert_eq!(Setting::parse("smtp_url"), None);
        assert_eq!(Setting::parse(""), None);
        // Keys are exact — no case folding, no trimming.
        assert_eq!(Setting::parse("Universal_Answer"), None);
    }

    #[test]
    fn normalize_trims_and_empties_to_unset() {
        assert_eq!(Setting::normalize(Some("  11 ")), Some("11".to_string()));
        assert_eq!(Setting::normalize(Some("")), None);
        assert_eq!(Setting::normalize(Some("   ")), None);
        assert_eq!(Setting::normalize(None), None);
    }
}
