//! Access grants: lifetime "this player owns this quest" records (the gate before
//! attempt creation), mirroring the `facts.rs` split of pure helpers vs. storage.
//!
//! A grant is idempotent by `(user_id, quest_id)` — at most one per pair, ever.
//! The `source` (Payment / CouponRedemption / FreeQuest / Admin) and optional
//! `source_ref` are an audit trail recorded once at creation; a later checkout for
//! the same pair returns the existing grant unchanged (first source wins). Grants
//! are bound to the quest, not a snapshot, so they survive version publishes — old
//! attempts keep their own frozen snapshot via the fact log.
//!
//! The pure helper here makes the idempotency decision; the store
//! ([`crate::store::InMemoryGrantStore`]) owns the short critical section and
//! injects the wall-clock timestamp, keeping this layer deterministic and testable.

use serde::{Deserialize, Serialize};

/// How a grant was obtained, recorded for audit at creation (first wins on an
/// idempotent re-checkout). Mirrors the TypeScript `AccessGrant['source']` union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum GrantSource {
    Payment,
    CouponRedemption,
    FreeQuest,
    Admin,
}

/// A lifetime ownership record: one user's access to one quest.
///
/// Idempotent at most one per `(user_id, quest_id)`. `granted_at` is an RFC3339
/// timestamp stamped once at creation; `source` and `source_ref` are the audit
/// trail (the latter is `None` for free/coupon paths with nothing to reference).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "GrantWire"))]
pub struct AccessGrant {
    pub user_id: String,
    pub quest_id: String,
    pub granted_at: String,
    pub source: GrantSource,
    pub source_ref: Option<String>,
}

/// The idempotency key: `(user_id, quest_id)`. Source is deliberately excluded
/// — a grant is "buy once, own forever", so a second checkout from a different
/// source returns the existing grant rather than creating a new one.
pub fn natural_grant_key(g: &AccessGrant) -> (String, String) {
    (g.user_id.clone(), g.quest_id.clone())
}

/// Pure idempotent grant decision (the logic the store runs under its lock).
///
/// If `existing` already covers this `(user, quest)`, it is returned unchanged
/// (`created = false`) so the first source/ref/timestamp are preserved. Otherwise a
/// new grant is built with the caller-supplied `granted_at` — the store injects the
/// real clock read ([`crate::store::now_rfc3339`]), keeping this function pure and
/// deterministic for tests.
///
/// # Arguments
///
/// * `existing` - the prior grant for this pair, if any (from the store snapshot)
/// * `user_id` - user id (anonymous `dev:<uuid>` or a registered account id)
/// * `quest` - quest id (e.g. `"mystery-fortress-v1"`)
/// * `source` - audit source for a newly created grant (ignored on an idempotent hit)
/// * `source_ref` - optional audit reference (e.g. a payment ref); first wins
/// * `granted_at` - RFC3339 creation timestamp for a newly created grant
///
/// # Returns
///
/// `(grant, created)` where `created` is true only when a new grant was built.
pub fn create_grant_idemp(
    existing: Option<&AccessGrant>,
    user_id: &str,
    quest: &str,
    source: GrantSource,
    source_ref: Option<String>,
    granted_at: String,
) -> (AccessGrant, bool) {
    if let Some(e) = existing
        && e.user_id == user_id
        && e.quest_id == quest
    {
        return (e.clone(), false);
    }
    let grant = AccessGrant {
        user_id: user_id.to_string(),
        quest_id: quest.to_string(),
        granted_at,
        source,
        source_ref,
    };
    (grant, true)
}

/// Full-record equality for audit dedup: the natural key plus every audited field
/// (source, timestamp, ref). Not used for idempotency (that is key-only) — kept as
/// the explicit "are these the same recorded grant" predicate.
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

    /// Fixed timestamp so the idempotency assertions stay deterministic; production
    /// injects the real clock via [`crate::store::now_rfc3339`].
    const TS: &str = "2026-06-10T00:00:00Z";

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
            TS.into(),
        );
        // Assert 1
        assert!(created1);
        assert_eq!(g1.user_id, player);
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
            TS.into(),
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
        let (gc, cc) = create_grant_idemp(
            None,
            player,
            quest,
            GrantSource::CouponRedemption,
            None,
            TS.into(),
        );
        // Assert
        assert!(cc);
        assert_eq!(gc.source, GrantSource::CouponRedemption);
        assert_eq!(gc.source_ref, None);
        // Act free
        let (gf, cf) = create_grant_idemp(
            None,
            player,
            "free-quest",
            GrantSource::FreeQuest,
            None,
            TS.into(),
        );
        assert!(cf);
        assert_eq!(gf.source, GrantSource::FreeQuest);
        // Identical downstream (same shape, different source only; eligibility same via pure)
        assert_eq!(gc.user_id, player);
        assert_ne!(gc.quest_id, gf.quest_id); // different quest ok
    }

    #[test]
    fn grant_natural_key_and_same() {
        let g = AccessGrant {
            user_id: "p".into(),
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
