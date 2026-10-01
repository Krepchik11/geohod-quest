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
    /// The cities announced as «скоро» on the storefront while the
    /// `store_cities` feature flag is on — a comma-separated list (see
    /// [`soon_cities`]).
    SoonCities,
}

impl Setting {
    /// Every registered setting.
    pub const ALL: [Self; 2] = [Self::UniversalAnswer, Self::SoonCities];

    /// Stable wire/storage key. Never reuse a retired key for a new setting —
    /// a stale row would silently become its value.
    pub fn key(self) -> &'static str {
        match self {
            Self::UniversalAnswer => "universal_answer",
            Self::SoonCities => "soon_cities",
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

/// The `soon_cities` value as a list: split on commas and line breaks, each
/// name trimmed, blanks and repeats dropped, the admin's order kept.
///
/// # Arguments
///
/// * `value` - The stored setting, `None` when unset
///
/// # Returns
///
/// The city names in the order the admin typed them; empty when unset.
pub fn soon_cities(value: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in value.unwrap_or_default().split([',', '\n']).map(str::trim) {
        if !name.is_empty() && !out.iter().any(|c| c == name) {
            out.push(name.to_string());
        }
    }
    out
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
    fn soon_cities_splits_trims_and_dedups_in_order() {
        assert_eq!(
            soon_cities(Some(" Белград, Стамбул ,\nМосква,,Белград ")),
            vec!["Белград", "Стамбул", "Москва"]
        );
        assert!(soon_cities(None).is_empty());
        assert!(soon_cities(Some(" , ")).is_empty());
    }

    #[test]
    fn normalize_trims_and_empties_to_unset() {
        assert_eq!(Setting::normalize(Some("  11 ")), Some("11".to_string()));
        assert_eq!(Setting::normalize(Some("")), None);
        assert_eq!(Setting::normalize(Some("   ")), None);
        assert_eq!(Setting::normalize(None), None);
    }
}
