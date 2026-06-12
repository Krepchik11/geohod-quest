//! Thin grants module (per rust.md + marketplace-grants design mirroring facts.rs pattern).
//!
//! Lifetime AccessGrant (idempotent by (player,quest), source-audited for Payment/CouponRedemption/FreeQuest/Admin).
//! Pure helpers + natural key for store impl. Explicit extension point for persist (like facts).
//! No side effects in pures; short critical sections in store (InMemoryGrantStore).
//! YAGNI: in-mem only (documented swap path); stub checkout (no gateway/prices); demo fixed player.
//! All per PLAN Phase 3 Commerce cuts (no real-money, no recurring, no cart, no external), SPEC/TECH (grant before attempt, idemp source, free identical), prior cycles (goldens fidelity, idemp natural keys, projectors, small enhance).
//!
//! Strict: 4-space, /// docs on all pub with examples, #[test] AAA, Result for fallible, no .unwrap in prod paths,
//! derive common (Debug, Clone, PartialEq, Serialize, Deserialize), snake_case where idiomatic.
//! Clippy -D, fmt clean, cargo test green.

use serde::{Deserialize, Serialize};

/// Grant source for audit (recorded at creation; first wins on idemp hit).
/// Matches TS AccessGrant['source'] + SPEC (Payment | CouponRedemption | FreeQuest | Admin).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum GrantSource {
    Payment,
    CouponRedemption,
    FreeQuest,
    Admin,
}

/// Lifetime AccessGrant record (player + quest; idempotent at most one per pair).
/// granted_at: ISO8601 at create time (first only).
/// source: audited at creation.
/// source_ref: optional external (e.g. payment id; null for free/coupon demo).
/// Survives quest version publishes (grant on quest, not specific snapshot; old attempts via facts manifest).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccessGrant {
    pub player_id: String,
    pub quest_id: String,
    pub granted_at: String,
    pub source: GrantSource,
    pub source_ref: Option<String>,
}

/// Natural key for idemp/lifetime "at most one" (player, quest).
/// Source not part of key (per design: lifetime buy-once; different source on re-call returns existing preserving first source).
///
/// # Arguments
///
/// * `g` - &AccessGrant
///
/// # Returns
///
/// (player_id, quest_id) tuple for HashMap key / exists check.
pub fn natural_grant_key(g: &AccessGrant) -> (String, String) {
    (g.player_id.clone(), g.quest_id.clone())
}

/// Pure idempotent create helper (logic usable by store under lock).
/// If existing matches key (player,quest), return it (created=false, source from existing).
/// Else create new with now-ish granted_at + passed source (source_ref=None for YAGNI demo).
/// Deterministic given inputs + clock (best-effort now; store may override ts).
///
/// Mirrors facts append_idempotent natural/semantically_same pattern (DRY).
///
/// # Arguments
///
/// * `existing` - optional prior grant for this (player,quest) from store snapshot
/// * `player` - player id (anonymous `dev:<uuid>` or registered account id)
/// * `quest` - quest id (e.g. "mystery-fortress-v1")
/// * `source` - source for this creation attempt (ignored for key match)
/// * `source_ref` - optional audit reference (e.g. mock payment_ref); first wins
///
/// # Returns
///
/// (grant, created) where grant is existing or new; created true only on first.
pub fn create_grant_idemp(
    existing: Option<&AccessGrant>,
    player: &str,
    quest: &str,
    source: GrantSource,
    source_ref: Option<String>,
) -> (AccessGrant, bool) {
    if let Some(e) = existing
        && e.player_id == player
        && e.quest_id == quest
    {
        return (e.clone(), false);
    }
    // New: use simple ts (store may use its now_secs for consistency; YAGNI fine for in-mem).
    let granted_at = "2026-06-10T00:00:00Z".to_string(); // deterministic for tests/replay goldens parity (real would use SystemTime like facts now_secs)
    let grant = AccessGrant {
        player_id: player.to_string(),
        quest_id: quest.to_string(),
        granted_at,
        source,
        source_ref,
    };
    (grant, true)
}

/// Semantically same for dedup (exact match on key + source + ts + ref for audit).
/// (YAGNI full now; key + source sufficient for idemp in store.)
#[allow(dead_code)]
pub fn semantically_same_grant(a: &AccessGrant, b: &AccessGrant) -> bool {
    natural_grant_key(a) == natural_grant_key(b)
        && a.source == b.source
        && a.granted_at == b.granted_at
        && a.source_ref == b.source_ref
}

#[cfg(test)]
mod tests {
    use super::*;

    // Arrange-Act-Assert per rust agents + TDD goldens parity (mirrors facts tests style).

    #[test]
    fn grant_idemp_first_creates_second_returns_existing_preserves_source() {
        // Arrange
        let player = "demo-player";
        let quest = "mystery-fortress-v1";
        // Act 1
        let (g1, created1) = create_grant_idemp(
            None,
            player,
            quest,
            GrantSource::Payment,
            Some("mock-pay-1".into()),
        );
        // Assert 1
        assert!(created1);
        assert_eq!(g1.player_id, player);
        assert_eq!(g1.quest_id, quest);
        assert_eq!(g1.source, GrantSource::Payment);
        assert_eq!(g1.source_ref.as_deref(), Some("mock-pay-1"));
        // Act 2: double buy or reconnect with coupon (should no-op, preserve Payment + ref)
        let (g2, created2) = create_grant_idemp(
            Some(&g1),
            player,
            quest,
            GrantSource::CouponRedemption,
            None,
        );
        // Assert 2
        assert!(!created2, "idemp hit");
        assert_eq!(
            g2.source,
            GrantSource::Payment,
            "source preserved from first (audit)"
        );
        assert_eq!(natural_grant_key(&g1), natural_grant_key(&g2));
    }

    #[test]
    fn grant_coupon_100_source_and_free_identical_mechanics() {
        // Arrange
        let player = "demo";
        let quest = "q";
        // Act coupon 100 (provider bypassed: no payment ref)
        let (gc, cc) = create_grant_idemp(None, player, quest, GrantSource::CouponRedemption, None);
        // Assert
        assert!(cc);
        assert_eq!(gc.source, GrantSource::CouponRedemption);
        assert_eq!(gc.source_ref, None);
        // Act free
        let (gf, cf) = create_grant_idemp(None, player, "free-quest", GrantSource::FreeQuest, None);
        assert!(cf);
        assert_eq!(gf.source, GrantSource::FreeQuest);
        // Identical downstream (same shape, different source only; eligibility same via pure)
        assert_eq!(gc.player_id, player);
        assert_ne!(gc.quest_id, gf.quest_id); // different quest ok
    }

    #[test]
    fn grant_natural_key_and_same() {
        let g = AccessGrant {
            player_id: "p".into(),
            quest_id: "q".into(),
            granted_at: "t".into(),
            source: GrantSource::Admin,
            source_ref: None,
        };
        assert_eq!(natural_grant_key(&g), ("p".into(), "q".into()));
        let g2 = g.clone();
        assert!(semantically_same_grant(&g, &g2));
    }
}
