//! In-memory stores: append-only fact logs keyed by attempt, the attempt registry
//! (grant-gated creation, snapshot binding), and grants/published-quest metadata.
//!
//! The only mutable state is the append-only logs plus the registries; balances and
//! attempt states are always re-folded from facts by the pure projectors. There is
//! no correction machinery: negative balance is a legal persistent state, and sync
//! corrections are derived client-side from projection diffs (SPEC).
//!
//! This module also hosts the backend dispatch ([`FactStores`]/[`GrantStores`]):
//! in-memory (zero-infra dev/tests) or PostgreSQL ([`crate::pg_store`]), selected
//! at startup. The in-memory implementation is the executable specification for
//! the SQL one — the same integration scenarios run against both.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::auth::{UserAccount, UserRecord};
use crate::coupons::{Coupon, CouponRedemption, CouponUsage, check_redeemable, discount_amount};
use crate::errors::AppError;
use crate::facts::{
    Fact, FactKind, MigrationResult, PerVersionStats, ProjectedState, project_state,
    semantically_same,
};
use crate::grants::{AccessGrant, GrantSource, create_grant_idemp};
use crate::payments::{PendingPayment, PendingStatus};
use crate::pg_store::{
    PgAuthStore, PgConstructorStore, PgCouponStore, PgFactStore, PgFlagStore, PgGrantStore,
    PgPaymentStore,
};

/// Unix seconds (0 on clock error; informational only).
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Current UTC time as an RFC3339 string (e.g. `"2026-06-18T12:34:56Z"`).
///
/// This is the impure clock read the pure grant helper injects, so an audit
/// timestamp is a real instant — matching the TypeScript reference
/// (`new Date().toISOString()`). Formatted from [`now_secs`] without a date crate
/// (see [`rfc3339_from_unix`]) to keep the dependency surface minimal.
pub fn now_rfc3339() -> String {
    rfc3339_from_unix(now_secs())
}

/// Current UTC calendar date, `"YYYY-MM-DD"` (the coupon expiry granularity).
pub fn today_utc() -> String {
    now_rfc3339()[..10].to_string()
}

/// Format Unix seconds as a UTC RFC3339 timestamp. Pure and total.
///
/// Uses Howard Hinnant's civil-from-days algorithm (epoch shifted to 0000-03-01
/// so leap days fall at the end of the era), which is exact for every day in the
/// proleptic Gregorian calendar.
pub(crate) fn rfc3339_from_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (hour, minute, second) = (tod / 3600, (tod % 3600) / 60, tod % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // day-of-era [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day-of-year (Mar 1 = 0)
    let mp = (5 * doy + 2) / 153; // month shifted (Mar = 0) [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = yoe + era * 400 + i64::from(month <= 2);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Registry entry for one attempt: who plays which quest on which frozen snapshot.
/// The snapshot binding is set once at creation and never changes (version freeze).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AttemptMeta {
    pub attempt_id: String,
    pub player_id: String,
    pub quest_id: String,
    pub snapshot_id: String,
    /// Unix seconds at creation (0 on clock error; informational only).
    pub created_at: u64,
}

/// The running best rating for a `(quest, player)` while folding attempts —
/// `(created_at, attempt_id, rating, text)`, the max by `(created_at, attempt_id)`.
type BestRating = (u64, String, i64, Option<String>);

/// In-memory append-only fact store + attempt registry.
#[derive(Clone, Debug, Default)]
pub struct InMemoryFactStore {
    fact_logs: HashMap<String, Vec<Fact>>,
    /// Storage-level receive instants, parallel to `fact_logs` (mirrors the
    /// Postgres `facts.recorded_at` column; never part of the wire shape or the
    /// dedup key). INVARIANT: `fact_times[a][i]` is the receive time of
    /// `fact_logs[a][i]` — both vectors are only ever appended together in
    /// [`Self::append_idempotent`] and dropped together, keeping the wire log
    /// borrowable by the pure projectors with zero copies.
    fact_times: HashMap<String, Vec<u64>>,
    attempts: HashMap<String, AttemptMeta>,
    next_attempt_seq: u64,
    /// Idempotency marks for the one-time legacy migration job (phase 4).
    legacy_imported_marks: HashMap<String, bool>,
}

impl InMemoryFactStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create an attempt bound to `snapshot_id` for (player, quest). The caller is
    /// responsible for the grant check (handler layer owns the 403). Returns the
    /// new registry entry with a server-generated attempt id.
    pub fn create_attempt(
        &mut self,
        player_id: &str,
        quest_id: &str,
        snapshot_id: &str,
    ) -> AttemptMeta {
        self.next_attempt_seq += 1;
        let meta = AttemptMeta {
            attempt_id: format!("att-{}", self.next_attempt_seq),
            player_id: player_id.to_string(),
            quest_id: quest_id.to_string(),
            snapshot_id: snapshot_id.to_string(),
            created_at: now_secs(),
        };
        self.fact_logs.insert(meta.attempt_id.clone(), Vec::new());
        self.attempts.insert(meta.attempt_id.clone(), meta.clone());
        meta
    }

    /// Append `incoming` idempotently to a KNOWN attempt's log. Returns the newly
    /// accepted facts, or `None` if the attempt does not exist (handler maps to 404).
    ///
    /// Dedup is by device-agnostic natural key within the attempt. A
    /// `completion_bonus` additionally dedups across ALL attempts of the same
    /// (player, quest): the canonical +5 is awarded once per player+quest, ever —
    /// duplicates from retries, devices, resets, and replays are absorbed.
    pub fn append_idempotent(
        &mut self,
        attempt_id: &str,
        incoming: Vec<Fact>,
    ) -> Option<Vec<Fact>> {
        let meta = self.attempts.get(attempt_id)?.clone();
        let mut accepted: Vec<Fact> = Vec::new();
        for f in incoming {
            let duplicate_in_log = self
                .fact_logs
                .get(attempt_id)
                .is_some_and(|log| log.iter().any(|e| semantically_same(e, &f)));
            let duplicate_bonus = f.kind == FactKind::CompletionBonus
                && self.bonus_already_awarded(&meta.player_id, &meta.quest_id);
            if duplicate_in_log || duplicate_bonus {
                continue;
            }
            self.fact_logs
                .entry(attempt_id.to_string())
                .or_default()
                .push(f.clone());
            self.fact_times
                .entry(attempt_id.to_string())
                .or_default()
                .push(now_secs());
            accepted.push(f);
        }
        Some(accepted)
    }

    /// Effective per-player ratings for the given quests (or ALL quests when
    /// `None`) — the input to the public hide-aware fold in [`crate::facts`]. One
    /// row per `(player_id, quest_id)`: the player's latest rated attempt across
    /// all versions (ties broken by `(created_at, attempt_id)` for determinism).
    /// Star-only ratings are included (with `text = None`); the fold and review
    /// list decide how each is used.
    pub fn quest_rating_rows(
        &self,
        quests: Option<&[String]>,
    ) -> Vec<crate::facts::PlayerRatingRow> {
        let wanted: Option<std::collections::HashSet<&str>> =
            quests.map(|qs| qs.iter().map(String::as_str).collect());
        // (quest_id, player_id) -> (created_at, attempt_id, rating, text) — max wins.
        let mut best: HashMap<(String, String), BestRating> = HashMap::new();
        for meta in self.attempts.values() {
            if let Some(w) = &wanted
                && !w.contains(meta.quest_id.as_str())
            {
                continue;
            }
            let Some(log) = self.fact_logs.get(&meta.attempt_id) else {
                continue;
            };
            let Some((rating, text)) = crate::facts::effective_rating(log) else {
                continue;
            };
            let key = (meta.quest_id.clone(), meta.player_id.clone());
            let newer = match best.get(&key) {
                Some((at, aid, _, _)) => (meta.created_at, meta.attempt_id.as_str()) > (*at, aid),
                None => true,
            };
            if newer {
                best.insert(
                    key,
                    (meta.created_at, meta.attempt_id.clone(), rating, text),
                );
            }
        }
        best.into_iter()
            .map(
                |((quest_id, player_id), (created_at, _aid, rating, text))| {
                    crate::facts::PlayerRatingRow {
                        player_id,
                        quest_id,
                        rating,
                        text,
                        created_at,
                    }
                },
            )
            .collect()
    }

    /// §7.4 delete account: drop the player's attempts and their fact logs.
    pub fn delete_player_data(&mut self, player_id: &str) {
        let attempt_ids: Vec<String> = self
            .attempts
            .iter()
            .filter(|(_, m)| m.player_id == player_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in attempt_ids {
            self.attempts.remove(&id);
            self.fact_logs.remove(&id);
            self.fact_times.remove(&id);
        }
    }

    /// True if any attempt of (player, quest) already holds a completion bonus.
    fn bonus_already_awarded(&self, player_id: &str, quest_id: &str) -> bool {
        self.attempts
            .values()
            .filter(|m| m.player_id == player_id && m.quest_id == quest_id)
            .filter_map(|m| self.fact_logs.get(&m.attempt_id))
            .flatten()
            .any(|f| f.kind == FactKind::CompletionBonus)
    }

    /// Authoritative projected state + bound snapshot + fact count for a known
    /// attempt; `None` for unknown attempts (handler maps to 404).
    pub fn get_projected(&self, attempt_id: &str) -> Option<(ProjectedState, String, usize)> {
        let meta = self.attempts.get(attempt_id)?;
        let log = self
            .fact_logs
            .get(attempt_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        Some((project_state(log), meta.snapshot_id.clone(), log.len()))
    }

    fn attempt_snapshot_map(&self) -> HashMap<String, String> {
        self.attempts
            .iter()
            .map(|(id, m)| (id.clone(), m.snapshot_id.clone()))
            .collect()
    }

    /// Per-version stats (admin visibility), delegating to the pure projector.
    pub fn get_version_stats(
        &self,
        snap: &str,
        grants_count: usize,
    ) -> crate::facts::PerVersionStats {
        crate::facts::project_version_stats(
            snap,
            &self.fact_logs,
            &self.attempt_snapshot_map(),
            grants_count,
        )
    }

    /// Feedback reports for a version (admin visibility), via the pure projector.
    pub fn list_feedbacks_for_version(&self, snap: &str) -> Vec<Fact> {
        crate::facts::list_feedbacks_for_snapshot(
            snap,
            &self.fact_logs,
            &self.attempt_snapshot_map(),
        )
    }

    /// Every `feedback_reported` fact across ALL attempts, carrying its attempt
    /// context (quest, snapshot, player) and server `recorded_at` — the input to the
    /// global feedback-inbox grouping. `recorded_at` comes from the parallel
    /// `fact_times` vector (mirrors the Postgres `facts.recorded_at` column).
    pub fn all_feedback_reports(&self) -> Vec<crate::facts::FeedbackReportRow> {
        let mut out = Vec::new();
        for meta in self.attempts.values() {
            let Some(log) = self.fact_logs.get(&meta.attempt_id) else {
                continue;
            };
            let times = self.fact_times.get(&meta.attempt_id);
            for (i, f) in log.iter().enumerate() {
                if f.kind != FactKind::FeedbackReported {
                    continue;
                }
                let recorded_at = times
                    .and_then(|t| t.get(i).copied())
                    .unwrap_or(meta.created_at);
                out.push(crate::facts::FeedbackReportRow {
                    quest_id: meta.quest_id.clone(),
                    snapshot_id: meta.snapshot_id.clone(),
                    step_position: f.step_position,
                    player_id: meta.player_id.clone(),
                    note: f.note.clone().unwrap_or_default(),
                    recorded_at,
                });
            }
        }
        out
    }

    /// One-time idempotent legacy migration: no-op (marked) on re-run for the same key.
    pub fn run_legacy_migration(
        &mut self,
        historical_grants: Vec<serde_json::Value>,
        answer_cards: Vec<serde_json::Value>,
        key: &str,
    ) -> crate::facts::MigrationResult {
        if self.is_migration_marked(key) {
            return crate::facts::MigrationResult {
                synth_snapshot: serde_json::json!({"note": "idemp no-op (already marked)"}),
                synth_facts: vec![],
                audit_report: "idemp re-run: no change".to_string(),
                marked: true,
            };
        }
        let res =
            crate::facts::synthesize_legacy_snapshot_and_facts(historical_grants, answer_cards);
        self.legacy_imported_marks.insert(key.to_string(), true);
        res
    }

    /// True if the migration job already ran for `key`.
    pub fn is_migration_marked(&self, key: &str) -> bool {
        *self.legacy_imported_marks.get(key).unwrap_or(&false)
    }

    /// All `(quest_id, fact log)` pairs for the player's attempts — the gather
    /// behind the pure player-stats fold (one pair per attempt, empty logs kept
    /// so attempts_count is honest).
    pub fn attempt_logs_for_player(&self, player_id: &str) -> Vec<(String, Vec<Fact>)> {
        self.attempts
            .values()
            .filter(|m| m.player_id == player_id)
            .map(|m| {
                (
                    m.quest_id.clone(),
                    self.fact_logs
                        .get(&m.attempt_id)
                        .cloned()
                        .unwrap_or_default(),
                )
            })
            .collect()
    }

    /// Distinct players who completed each quest (`quest_id` → count) — the
    /// "прохождения" metric the constructor dashboard shows. A completion is
    /// marked by the once-per-(player,quest) `CompletionBonus`; the Postgres
    /// backend counts `bonus_awards` rows, so both report the same number.
    pub fn completions_by_quest(&self) -> HashMap<String, usize> {
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();
        for meta in self.attempts.values() {
            let completed = self
                .fact_logs
                .get(&meta.attempt_id)
                .is_some_and(|log| log.iter().any(|f| f.kind == FactKind::CompletionBonus));
            if completed {
                sets.entry(meta.quest_id.clone())
                    .or_default()
                    .insert(meta.player_id.clone());
            }
        }
        sets.into_iter().map(|(q, s)| (q, s.len())).collect()
    }

    /// Distinct finishers of ONE quest — the single-quest mirror of
    /// `completions_by_quest`, matching its `bonus_awards`-per-(player,quest) count.
    pub fn completions_for_quest(&self, quest_id: &str) -> usize {
        self.attempts
            .values()
            .filter(|meta| {
                meta.quest_id == quest_id
                    && self
                        .fact_logs
                        .get(&meta.attempt_id)
                        .is_some_and(|log| log.iter().any(|f| f.kind == FactKind::CompletionBonus))
            })
            .map(|meta| meta.player_id.clone())
            .collect::<HashSet<String>>()
            .len()
    }

    /// Start events (one per attempt) with `created_at` in `[from, to_excl)` —
    /// the «начато» stream behind `/api/admin/stats`. `quest = Some(id)`
    /// restricts to one quest (the drill-down endpoint).
    pub fn stats_start_events(
        &self,
        from: i64,
        to_excl: i64,
        quest: Option<&str>,
    ) -> Vec<crate::admin_stats::StatEvent> {
        self.attempts
            .values()
            .filter(|m| {
                (from..to_excl).contains(&(m.created_at as i64))
                    && quest.is_none_or(|q| m.quest_id == q)
            })
            .map(|m| crate::admin_stats::StatEvent {
                quest_id: m.quest_id.clone(),
                at: m.created_at as i64,
            })
            .collect()
    }

    /// Finish events: AT MOST ONE per attempt — the earliest
    /// `attempt_completed` fact's receive time. Facts dedup by natural key
    /// (which includes `step_position`), so one attempt CAN hold several
    /// completion facts; counting facts would let «завершено» exceed «начато».
    pub fn stats_finish_events(
        &self,
        from: i64,
        to_excl: i64,
        quest: Option<&str>,
    ) -> Vec<crate::admin_stats::StatEvent> {
        self.attempts
            .values()
            .filter(|m| quest.is_none_or(|q| m.quest_id == q))
            .filter_map(|m| {
                let log = self.fact_logs.get(&m.attempt_id)?;
                let times = self.fact_times.get(&m.attempt_id)?;
                let at = log
                    .iter()
                    .zip(times)
                    .filter(|(f, _)| f.kind == FactKind::AttemptCompleted)
                    .map(|(_, t)| *t as i64)
                    .min()?;
                (from..to_excl)
                    .contains(&at)
                    .then(|| crate::admin_stats::StatEvent {
                        quest_id: m.quest_id.clone(),
                        at,
                    })
            })
            .collect()
    }

    /// Wire fact logs of every attempt bound to `snapshot_id` and STARTED in
    /// `[from, to_excl)` — the funnel input (zero-fact attempts included, so
    /// the funnel denominator is honest).
    pub fn funnel_logs(&self, snapshot_id: &str, from: i64, to_excl: i64) -> Vec<Vec<Fact>> {
        self.attempts
            .values()
            .filter(|m| {
                m.snapshot_id == snapshot_id && (from..to_excl).contains(&(m.created_at as i64))
            })
            .map(|m| {
                self.fact_logs
                    .get(&m.attempt_id)
                    .cloned()
                    .unwrap_or_default()
            })
            .collect()
    }
}

/// Published quest metadata surfaced by the constructor's publish for the
/// marketplace list and for binding new attempts to the latest snapshot.
///
/// `city`/`duration`/`price` are the author's real store-card fields (collected
/// in the constructor settings); they are optional so quests published before the
/// metadata migration simply omit them rather than show fabricated values.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PublishedMeta {
    pub quest_id: String,
    pub name: String,
    pub primary_comic: Option<String>,
    pub template_summary: String,
    pub snapshot_version: u32,
    /// Frozen snapshot identifier new attempts bind to (e.g. "golden-mystery-fortress-v1").
    pub snapshot_id: String,
    /// Store-card city (e.g. "Нови Сад"); None when the author left it blank.
    #[serde(default)]
    pub city: Option<String>,
    /// Store-card duration label (e.g. "1.5 часа"); None when blank.
    #[serde(default)]
    pub duration: Option<String>,
    /// Price in whole rubles; Some(0) is an explicitly free quest, None is unset.
    #[serde(default)]
    pub price: Option<i64>,
    /// Store description from the constructor settings (product page, §3.1).
    #[serde(default)]
    pub description: Option<String>,
    /// Content chips derived from the frozen snapshot at publish time; None for
    /// versions published before the chips existed (the UI hides unknown chips).
    #[serde(default)]
    pub pages: Option<u32>,
    #[serde(default)]
    pub tasks: Option<u32>,
    #[serde(default)]
    pub paid_hints: Option<bool>,
    /// Marketing padding added to the real completions count for the PUBLIC
    /// players counter (store card / product page). Author-set in the constructor
    /// settings. Kept out of the client payload (`skip_serializing`) so the raw
    /// padding is never revealed alone — handlers fold it into the `players` total.
    #[serde(default, skip_serializing)]
    pub players_bonus: i64,
}

/// In-memory grants + published-quest store. `snapshots` holds the frozen snapshot
/// JSON per snapshot_id (immutable once set — version freeze at the storage layer).
#[derive(Clone, Debug, Default)]
pub struct InMemoryGrantStore {
    grants: HashMap<(String, String), AccessGrant>,
    published: HashMap<String, PublishedMeta>,
    snapshots: HashMap<String, Option<serde_json::Value>>,
}

impl InMemoryGrantStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Idempotent lifetime grant for (player, quest); first source + ref win.
    pub fn create_grant_idemp(
        &mut self,
        player: &str,
        quest: &str,
        source: GrantSource,
        source_ref: Option<String>,
    ) -> (AccessGrant, bool) {
        let key = (player.to_string(), quest.to_string());
        let existing = self.grants.get(&key).cloned();
        let (grant, created) = create_grant_idemp(
            existing.as_ref(),
            player,
            quest,
            source,
            source_ref,
            now_rfc3339(),
        );
        if created {
            self.grants.insert(key, grant.clone());
        }
        (grant, created)
    }

    /// True if (player, quest) holds a grant — the gate before attempt creation.
    pub fn has_grant(&self, player: &str, quest: &str) -> bool {
        self.grants
            .contains_key(&(player.to_string(), quest.to_string()))
    }

    /// Published quests sorted by id (marketplace list).
    pub fn list_published(&self) -> Vec<PublishedMeta> {
        let mut v: Vec<_> = self.published.values().cloned().collect();
        v.sort_by(|a, b| a.quest_id.cmp(&b.quest_id));
        v
    }

    /// Latest published metadata for a quest (new attempts bind its snapshot).
    pub fn get_published(&self, quest_id: &str) -> Option<&PublishedMeta> {
        self.published.get(quest_id)
    }

    /// Register/update published metadata and store the frozen snapshot JSON.
    /// Snapshot content is immutable per snapshot_id: identical content (or no new
    /// content) is an idempotent no-op, NULL data may be filled once, and differing
    /// content is rejected — publish a new version instead.
    pub fn register_published(
        &mut self,
        quest_id: &str,
        meta: PublishedMeta,
        snapshot: Option<serde_json::Value>,
    ) -> Result<(), AppError> {
        match (self.snapshots.get(&meta.snapshot_id), &snapshot) {
            (Some(Some(old)), Some(new)) if old != new => {
                return Err(AppError::BadRequest(format!(
                    "snapshot '{}' is frozen; publish a new version instead",
                    meta.snapshot_id
                )));
            }
            (None, _) | (Some(None), Some(_)) => {
                self.snapshots.insert(meta.snapshot_id.clone(), snapshot);
            }
            _ => {} // identical content or no new content: idempotent no-op
        }
        self.published.insert(quest_id.to_string(), meta);
        Ok(())
    }

    /// Latest published meta + frozen snapshot JSON for the bundle endpoint.
    pub fn get_bundle(&self, quest_id: &str) -> Option<(PublishedMeta, Option<serde_json::Value>)> {
        let meta = self.published.get(quest_id)?.clone();
        let data = self.snapshots.get(&meta.snapshot_id).cloned().flatten();
        Some((meta, data))
    }

    /// Frozen snapshot JSON by id — for callers that already hold the meta
    /// (skips the published-row fetch `get_bundle` would repeat).
    pub fn get_snapshot(&self, snapshot_id: &str) -> Option<serde_json::Value> {
        self.snapshots.get(snapshot_id).cloned().flatten()
    }

    /// All grants — internal/admin use only (exposes every player's purchases
    /// and payment refs; never serve to player-scoped callers).
    pub fn list_all_grants(&self) -> Vec<AccessGrant> {
        self.grants.values().cloned().collect()
    }

    /// Distinct grant holders per quest — the honest «{N} купивших» number the
    /// editor's status-change confirm shows. Counts only, no player ids leak.
    pub fn buyers_by_quest(&self) -> std::collections::HashMap<String, usize> {
        let mut m: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for g in self.grants.values() {
            *m.entry(g.quest_id.clone()).or_default() += 1;
        }
        m
    }

    /// Distinct buyers of ONE quest — the single-quest mirror of `buyers_by_quest`
    /// (grants are unique per (player, quest), so a plain count is the distinct one).
    pub fn buyers_for_quest(&self, quest_id: &str) -> usize {
        self.grants
            .values()
            .filter(|g| g.quest_id == quest_id)
            .count()
    }

    /// §7.4 delete account: purge every grant of the player. Returns the count
    /// (the confirm dialog shows honest numbers).
    pub fn delete_grants_for_player(&mut self, player_id: &str) -> usize {
        let before = self.grants.len();
        self.grants.retain(|(p, _), _| p != player_id);
        before - self.grants.len()
    }

    /// Purchase events (one per grant, any source) with `granted_at` in
    /// `[from, to_excl)` Unix seconds — the «куплено» stream behind
    /// `/api/admin/stats`. Grants whose timestamp fails to parse are skipped
    /// (defensive; the store only ever writes `now_rfc3339`).
    pub fn stats_purchase_events(
        &self,
        from: i64,
        to_excl: i64,
        quest: Option<&str>,
    ) -> Vec<crate::admin_stats::StatEvent> {
        self.grants
            .values()
            .filter(|g| quest.is_none_or(|q| g.quest_id == q))
            .filter_map(|g| {
                let at = crate::admin_stats::parse_rfc3339_utc(&g.granted_at)?;
                (from..to_excl)
                    .contains(&at)
                    .then(|| crate::admin_stats::StatEvent {
                        quest_id: g.quest_id.clone(),
                        at,
                    })
            })
            .collect()
    }

    /// Grants owned by a single player — the only grant view safe to return to a
    /// player-scoped request (no cross-player leakage).
    pub fn grants_for_player(&self, player_id: &str) -> Vec<AccessGrant> {
        self.grants
            .values()
            .filter(|g| g.player_id == player_id)
            .cloned()
            .collect()
    }
}

/// One single-use auth token (password reset / email confirmation), stored by
/// sha256 hash — a leaked store never yields working links.
#[derive(Clone, Debug)]
pub struct AuthTokenRecord {
    pub player_id: String,
    pub kind: String,
    /// sha256 of the emailed 6-digit code (§6.2 R2); `""` when none was minted
    /// (legacy rows) — no sha256 hex ever matches it.
    pub code_hash: String,
    pub expires_at: u64,
    pub used_at: Option<u64>,
    /// Code-verify attempts so far; the code stops verifying at
    /// [`MAX_CODE_ATTEMPTS`] (low-entropy codes must not be brute-forceable).
    pub attempts: u32,
}

pub const TOKEN_KIND_RESET: &str = "reset";
pub const TOKEN_KIND_CONFIRM: &str = "confirm";

/// One linked social identity (`auth_identities` row): a `(provider, subject)`
/// pair that resolves to an account `player_id`. `email` is the provider-supplied
/// address (Google) kept for display/reference — NOT the account's login email.
#[derive(Clone, Debug, PartialEq)]
pub struct AuthIdentity {
    pub provider: String,
    pub subject: String,
    pub player_id: String,
    pub email: Option<String>,
    /// Provider handle for contact — the Telegram `@username` (without the `@`),
    /// captured so admins can reach a Telegram-only reporter at `t.me/<username>`.
    /// `None` for Google/email identities and for a handleless Telegram user.
    pub username: Option<String>,
    pub created_at: u64,
}

/// A 6-digit code survives at most this many verify attempts (right or wrong):
/// 5 guesses against 10^6 codes in a 30-minute window is negligible.
pub const MAX_CODE_ATTEMPTS: u32 = 5;

/// In-memory identity store: registrations (the `users` table) + opaque sessions.
/// A record exists ONLY for registered users — anonymous ids have no row by
/// design (registration is metadata on an existing id, never a migration).
#[derive(Clone, Debug, Default)]
pub struct InMemoryAuthStore {
    users: HashMap<String, UserRecord>,
    email_index: HashMap<String, String>,
    sessions: HashMap<String, String>,
    /// Single-use auth tokens keyed by sha256(token): reset/confirm (§6).
    auth_tokens: HashMap<String, AuthTokenRecord>,
    /// Linked social identities keyed by `(provider, subject)` (the `auth_identities`
    /// table). One account (`player_id`) may hold several rows.
    identities: HashMap<(String, String), AuthIdentity>,
}

impl InMemoryAuthStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `player_id` with credentials. Rejects (409) a taken email or an
    /// already-registered user atomically (no partial state on failure).
    pub fn register_user(
        &mut self,
        player_id: &str,
        email: &str,
        password_hash: &str,
        display_name: Option<String>,
    ) -> Result<UserAccount, AppError> {
        if self.users.contains_key(player_id) {
            return Err(AppError::Conflict("player is already registered".into()));
        }
        if self.email_index.contains_key(email) {
            return Err(AppError::Conflict("email is already taken".into()));
        }
        let account = UserAccount {
            player_id: player_id.to_string(),
            email: Some(email.to_string()),
            display_name,
            role: crate::auth::DEFAULT_ROLE.to_string(),
            created_at: now_secs(),
            email_confirmed_at: None,
        };
        self.users.insert(
            player_id.to_string(),
            UserRecord {
                account: account.clone(),
                password_hash: password_hash.to_string(),
            },
        );
        self.email_index
            .insert(email.to_string(), player_id.to_string());
        Ok(account)
    }

    /// Full record (account + hash) by email — the login lookup.
    pub fn find_by_email(&self, email: &str) -> Option<UserRecord> {
        let player_id = self.email_index.get(email)?;
        self.users.get(player_id).cloned()
    }

    /// Public account by player id; `None` for anonymous (unregistered) ids.
    pub fn get_user(&self, player_id: &str) -> Option<UserAccount> {
        self.users.get(player_id).map(|r| r.account.clone())
    }

    /// Accounts for a batch of player ids (unknown/anonymous ids are simply
    /// absent) — the in-memory mirror of the Postgres `ANY($1)` batch lookup.
    pub fn get_users_by_ids(&self, player_ids: &[String]) -> HashMap<String, UserAccount> {
        player_ids
            .iter()
            .filter_map(|id| self.users.get(id).map(|r| (id.clone(), r.account.clone())))
            .collect()
    }

    /// Assign `role` to a registered account (admin-users spec). Returns 404 for
    /// an unknown/anonymous id — only registered accounts have a role. The caller
    /// validates `role` against the known set before reaching here.
    pub fn set_role(&mut self, player_id: &str, role: &str) -> Result<UserAccount, AppError> {
        let record = self
            .users
            .get_mut(player_id)
            .ok_or_else(|| AppError::NotFound(format!("no account for player '{player_id}'")))?;
        record.account.role = role.to_string();
        Ok(record.account.clone())
    }

    /// All registered accounts, newest registration first (admin user list).
    /// Anonymous devices have no row, so only real accounts are returned. Two stable
    /// passes give the total order (created_at desc, then player_id asc) without a
    /// hand-formatted comparator chain.
    pub fn list_users(&self) -> Vec<UserAccount> {
        let mut accounts: Vec<UserAccount> =
            self.users.values().map(|r| r.account.clone()).collect();
        accounts.sort_by_key(|a| a.player_id.clone());
        accounts.sort_by_key(|a| std::cmp::Reverse(a.created_at));
        accounts
    }

    /// Store an opaque session token for the player.
    pub fn create_session(&mut self, token: &str, player_id: &str) {
        self.sessions
            .insert(token.to_string(), player_id.to_string());
    }

    /// Resolve a session token to its player id.
    pub fn get_session(&self, token: &str) -> Option<String> {
        self.sessions.get(token).cloned()
    }

    /// The account behind a session token in one step — mirror of the Postgres
    /// single-JOIN path. An anonymous session (no account row) yields `None`.
    pub fn account_for_session(&self, token: &str) -> Option<UserAccount> {
        let player_id = self.sessions.get(token)?;
        self.users.get(player_id).map(|r| r.account.clone())
    }

    /// §7.3 «Изменить имя» — set/clear the display name.
    pub fn set_display_name(
        &mut self,
        player_id: &str,
        display_name: Option<String>,
    ) -> Result<UserAccount, AppError> {
        let record = self
            .users
            .get_mut(player_id)
            .ok_or_else(|| AppError::NotFound(format!("no account for player '{player_id}'")))?;
        record.account.display_name = display_name;
        Ok(record.account.clone())
    }

    /// Replace the account's password hash (§6.2 reset / §7.3 change).
    pub fn set_password(&mut self, player_id: &str, password_hash: &str) -> Result<(), AppError> {
        let record = self
            .users
            .get_mut(player_id)
            .ok_or_else(|| AppError::NotFound(format!("no account for player '{player_id}'")))?;
        record.password_hash = password_hash.to_string();
        Ok(())
    }

    /// Mark the email confirmed (§6.3); idempotent — the first timestamp wins.
    pub fn confirm_email(&mut self, player_id: &str, at: u64) -> Result<UserAccount, AppError> {
        let record = self
            .users
            .get_mut(player_id)
            .ok_or_else(|| AppError::NotFound(format!("no account for player '{player_id}'")))?;
        if record.account.email_confirmed_at.is_none() {
            record.account.email_confirmed_at = Some(at);
        }
        Ok(record.account.clone())
    }

    /// Store a single-use token (hashed by the caller). Latest mail wins:
    /// issuing invalidates prior unused tokens of the same kind — with codes
    /// in play, N outstanding credentials would be N× guessable.
    pub fn create_auth_token(&mut self, token_hash: &str, rec: AuthTokenRecord) {
        self.auth_tokens.retain(|_, r| {
            r.player_id != rec.player_id || r.kind != rec.kind || r.used_at.is_some()
        });
        self.auth_tokens.insert(token_hash.to_string(), rec);
    }

    /// Consume a token: valid kind + not expired + unused → marks used and
    /// returns the player id; anything else is None (one opaque failure).
    pub fn consume_auth_token(&mut self, token_hash: &str, kind: &str, now: u64) -> Option<String> {
        let rec = self.auth_tokens.get_mut(token_hash)?;
        if rec.kind != kind || rec.used_at.is_some() || rec.expires_at < now {
            return None;
        }
        rec.used_at = Some(now);
        Some(rec.player_id.clone())
    }

    /// Consume by emailed code (§6.2 R2): the player's active (unused,
    /// unexpired, under-budget) token of `kind`. EVERY call spends one attempt;
    /// only a code_hash match consumes the token and returns the player id.
    pub fn consume_auth_token_by_code(
        &mut self,
        player_id: &str,
        kind: &str,
        code_hash: &str,
        now: u64,
    ) -> Option<String> {
        let rec = self.auth_tokens.values_mut().find(|r| {
            r.player_id == player_id
                && r.kind == kind
                && r.used_at.is_none()
                && r.expires_at >= now
                && r.attempts < MAX_CODE_ATTEMPTS
        })?;
        rec.attempts += 1;
        if rec.code_hash.is_empty() || rec.code_hash != code_hash {
            return None;
        }
        rec.used_at = Some(now);
        Some(rec.player_id.clone())
    }

    /// §7.4 delete account: user row, email index, sessions and tokens.
    pub fn delete_user(&mut self, player_id: &str) -> bool {
        let Some(record) = self.users.remove(player_id) else {
            return false;
        };
        if let Some(email) = &record.account.email {
            self.email_index.remove(email);
        }
        self.sessions.retain(|_, p| p != player_id);
        self.auth_tokens.retain(|_, r| r.player_id != player_id);
        self.identities.retain(|_, i| i.player_id != player_id);
        true
    }

    /// The account a verified `(provider, subject)` identity resolves to, if linked.
    pub fn find_identity(&self, provider: &str, subject: &str) -> Option<String> {
        self.identities
            .get(&(provider.to_string(), subject.to_string()))
            .map(|i| i.player_id.clone())
    }

    /// Link a social identity to an account. Rejects (409) a `(provider, subject)`
    /// already linked (to any account) — the caller has already resolved that an
    /// existing link means "login", so reaching here with a duplicate is a bug/race.
    pub fn create_identity(&mut self, identity: AuthIdentity) -> Result<(), AppError> {
        let key = (identity.provider.clone(), identity.subject.clone());
        if self.identities.contains_key(&key) {
            return Err(AppError::Conflict("identity already linked".into()));
        }
        self.identities.insert(key, identity);
        Ok(())
    }

    /// Refresh a linked identity's stored `username` (e.g. a changed Telegram
    /// handle). Only overwrites when a new value is present — an absent claim
    /// leaves the prior value untouched. No-op when the identity is not linked.
    pub fn set_identity_username(
        &mut self,
        provider: &str,
        subject: &str,
        username: Option<String>,
    ) {
        let Some(username) = username else {
            return;
        };
        if let Some(id) = self
            .identities
            .get_mut(&(provider.to_string(), subject.to_string()))
        {
            id.username = Some(username);
        }
    }

    /// All social identities linked to an account (for the profile method list).
    pub fn identities_for_player(&self, player_id: &str) -> Vec<AuthIdentity> {
        let mut out: Vec<AuthIdentity> = self
            .identities
            .values()
            .filter(|i| i.player_id == player_id)
            .cloned()
            .collect();
        out.sort_by(|a, b| a.provider.cmp(&b.provider));
        out
    }

    /// Identities for MANY accounts in one pass — `player_id -> its identities` —
    /// so admin identity resolution avoids an N+1 over `identities_for_player`.
    pub fn identities_for_players(
        &self,
        player_ids: &[String],
    ) -> HashMap<String, Vec<AuthIdentity>> {
        let wanted: std::collections::HashSet<&str> =
            player_ids.iter().map(String::as_str).collect();
        let mut out: HashMap<String, Vec<AuthIdentity>> = HashMap::new();
        for id in self.identities.values() {
            if wanted.contains(id.player_id.as_str()) {
                out.entry(id.player_id.clone())
                    .or_default()
                    .push(id.clone());
            }
        }
        out
    }

    /// Unlink a provider from an account. Returns whether a row was removed.
    pub fn delete_identity(&mut self, provider: &str, player_id: &str) -> bool {
        let before = self.identities.len();
        self.identities
            .retain(|_, i| !(i.provider == provider && i.player_id == player_id));
        self.identities.len() != before
    }

    /// Create an account row for a social-only sign-in on `player_id` (no password;
    /// email present only for a verified Google address). Preserves the id so any
    /// prior anonymous grants/coins survive. Rejects a taken player_id or email (409).
    pub fn create_social_account(
        &mut self,
        player_id: &str,
        email: Option<String>,
        display_name: Option<String>,
        email_confirmed_at: Option<u64>,
    ) -> Result<UserAccount, AppError> {
        if self.users.contains_key(player_id) {
            return Err(AppError::Conflict("player is already registered".into()));
        }
        if let Some(e) = &email
            && self.email_index.contains_key(e)
        {
            return Err(AppError::Conflict("email is already taken".into()));
        }
        let account = UserAccount {
            player_id: player_id.to_string(),
            email: email.clone(),
            display_name,
            role: crate::auth::DEFAULT_ROLE.to_string(),
            created_at: now_secs(),
            email_confirmed_at,
        };
        self.users.insert(
            player_id.to_string(),
            UserRecord {
                account: account.clone(),
                // No password for a social account; an empty hash never verifies.
                password_hash: String::new(),
            },
        );
        if let Some(e) = email {
            self.email_index.insert(e, player_id.to_string());
        }
        Ok(account)
    }

    /// Attach a verified Google email to an EXISTING account that has none yet
    /// (so the account gains an email login/display). No-op-safe: rejects if the
    /// email is taken by another account (409). Sets `email_confirmed_at` since
    /// Google is authoritative for a verified address.
    pub fn attach_email(
        &mut self,
        player_id: &str,
        email: &str,
        confirmed_at: u64,
    ) -> Result<UserAccount, AppError> {
        if let Some(owner) = self.email_index.get(email)
            && owner != player_id
        {
            return Err(AppError::Conflict("email is already taken".into()));
        }
        let record = self
            .users
            .get_mut(player_id)
            .ok_or_else(|| AppError::NotFound(format!("no account for player '{player_id}'")))?;
        if record.account.email.is_none() {
            record.account.email = Some(email.to_string());
            if record.account.email_confirmed_at.is_none() {
                record.account.email_confirmed_at = Some(confirmed_at);
            }
            self.email_index
                .insert(email.to_string(), player_id.to_string());
        }
        Ok(record.account.clone())
    }
}

/// Fact/attempt storage backend, selected at startup. Both variants expose the
/// same async API and identical behavior; the in-memory implementation is the
/// executable specification for the Postgres one (parity enforced by running the
/// same integration scenarios against both).
#[derive(Clone, Debug)]
pub enum FactStores {
    /// Non-durable, zero-infra (tests + dev without DATABASE_URL).
    InMemory(std::sync::Arc<std::sync::Mutex<InMemoryFactStore>>),
    /// Durable PostgreSQL (DATABASE_URL set; migrations run at startup).
    Postgres(PgFactStore),
}

impl FactStores {
    fn lock_inmem(
        m: &std::sync::Mutex<InMemoryFactStore>,
    ) -> Result<std::sync::MutexGuard<'_, InMemoryFactStore>, AppError> {
        m.lock()
            .map_err(|e| AppError::Internal(anyhow::anyhow!("store lock poisoned: {e}")))
    }

    /// See [`InMemoryFactStore::quest_rating_rows`].
    pub async fn quest_rating_rows(
        &self,
        quests: Option<&[String]>,
    ) -> Result<Vec<crate::facts::PlayerRatingRow>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.quest_rating_rows(quests)),
            Self::Postgres(pg) => pg.quest_rating_rows(quests).await,
        }
    }

    /// See [`InMemoryFactStore::delete_player_data`].
    pub async fn delete_player_data(&self, player_id: &str) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.delete_player_data(player_id);
                Ok(())
            }
            Self::Postgres(pg) => pg.delete_player_data(player_id).await,
        }
    }

    /// See [`InMemoryFactStore::create_attempt`].
    pub async fn create_attempt(
        &self,
        player_id: &str,
        quest_id: &str,
        snapshot_id: &str,
    ) -> Result<AttemptMeta, AppError> {
        match self {
            Self::InMemory(m) => {
                Ok(Self::lock_inmem(m)?.create_attempt(player_id, quest_id, snapshot_id))
            }
            Self::Postgres(pg) => pg.create_attempt(player_id, quest_id, snapshot_id).await,
        }
    }

    /// See [`InMemoryFactStore::append_idempotent`].
    pub async fn append_idempotent(
        &self,
        attempt_id: &str,
        incoming: Vec<Fact>,
    ) -> Result<Option<Vec<Fact>>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.append_idempotent(attempt_id, incoming)),
            Self::Postgres(pg) => pg.append_idempotent(attempt_id, incoming).await,
        }
    }

    /// See [`InMemoryFactStore::get_projected`].
    pub async fn get_projected(
        &self,
        attempt_id: &str,
    ) -> Result<Option<(ProjectedState, String, usize)>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_projected(attempt_id)),
            Self::Postgres(pg) => pg.get_projected(attempt_id).await,
        }
    }

    /// See [`InMemoryFactStore::get_version_stats`].
    pub async fn get_version_stats(
        &self,
        snap: &str,
        grants_count: usize,
    ) -> Result<PerVersionStats, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_version_stats(snap, grants_count)),
            Self::Postgres(pg) => pg.get_version_stats(snap, grants_count).await,
        }
    }

    /// See [`InMemoryFactStore::list_feedbacks_for_version`].
    pub async fn list_feedbacks_for_version(&self, snap: &str) -> Result<Vec<Fact>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.list_feedbacks_for_version(snap)),
            Self::Postgres(pg) => pg.list_feedbacks_for_version(snap).await,
        }
    }

    /// See [`InMemoryFactStore::all_feedback_reports`].
    pub async fn all_feedback_reports(
        &self,
    ) -> Result<Vec<crate::facts::FeedbackReportRow>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.all_feedback_reports()),
            Self::Postgres(pg) => pg.all_feedback_reports().await,
        }
    }

    /// See [`InMemoryFactStore::stats_start_events`].
    pub async fn stats_start_events(
        &self,
        from: i64,
        to_excl: i64,
        quest: Option<&str>,
    ) -> Result<Vec<crate::admin_stats::StatEvent>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.stats_start_events(from, to_excl, quest)),
            Self::Postgres(pg) => pg.stats_start_events(from, to_excl, quest).await,
        }
    }

    /// See [`InMemoryFactStore::stats_finish_events`].
    pub async fn stats_finish_events(
        &self,
        from: i64,
        to_excl: i64,
        quest: Option<&str>,
    ) -> Result<Vec<crate::admin_stats::StatEvent>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.stats_finish_events(from, to_excl, quest)),
            Self::Postgres(pg) => pg.stats_finish_events(from, to_excl, quest).await,
        }
    }

    /// See [`InMemoryFactStore::funnel_logs`].
    pub async fn funnel_logs(
        &self,
        snapshot_id: &str,
        from: i64,
        to_excl: i64,
    ) -> Result<Vec<Vec<Fact>>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.funnel_logs(snapshot_id, from, to_excl)),
            Self::Postgres(pg) => pg.funnel_logs(snapshot_id, from, to_excl).await,
        }
    }

    /// See [`InMemoryFactStore::run_legacy_migration`].
    pub async fn run_legacy_migration(
        &self,
        historical_grants: Vec<serde_json::Value>,
        answer_cards: Vec<serde_json::Value>,
        key: &str,
    ) -> Result<MigrationResult, AppError> {
        match self {
            Self::InMemory(m) => {
                Ok(Self::lock_inmem(m)?.run_legacy_migration(historical_grants, answer_cards, key))
            }
            Self::Postgres(pg) => {
                pg.run_legacy_migration(historical_grants, answer_cards, key)
                    .await
            }
        }
    }

    /// See [`InMemoryFactStore::attempt_logs_for_player`].
    pub async fn attempt_logs_for_player(
        &self,
        player_id: &str,
    ) -> Result<Vec<(String, Vec<Fact>)>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.attempt_logs_for_player(player_id)),
            Self::Postgres(pg) => pg.attempt_logs_for_player(player_id).await,
        }
    }

    /// See [`InMemoryFactStore::completions_by_quest`].
    pub async fn completions_by_quest(&self) -> Result<HashMap<String, usize>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.completions_by_quest()),
            Self::Postgres(pg) => pg.completions_by_quest().await,
        }
    }

    /// See [`InMemoryFactStore::completions_for_quest`].
    pub async fn completions_for_quest(&self, quest_id: &str) -> Result<usize, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.completions_for_quest(quest_id)),
            Self::Postgres(pg) => pg.completions_for_quest(quest_id).await,
        }
    }
}

/// Identity storage backend (see [`FactStores`] for the pattern).
#[derive(Clone, Debug)]
pub enum AuthStores {
    /// Non-durable, zero-infra (tests + dev without DATABASE_URL).
    InMemory(std::sync::Arc<std::sync::Mutex<InMemoryAuthStore>>),
    /// Durable PostgreSQL.
    Postgres(PgAuthStore),
}

impl AuthStores {
    fn lock_inmem(
        m: &std::sync::Mutex<InMemoryAuthStore>,
    ) -> Result<std::sync::MutexGuard<'_, InMemoryAuthStore>, AppError> {
        m.lock()
            .map_err(|e| AppError::Internal(anyhow::anyhow!("auth lock poisoned: {e}")))
    }

    /// See [`InMemoryAuthStore::register_user`].
    pub async fn register_user(
        &self,
        player_id: &str,
        email: &str,
        password_hash: &str,
        display_name: Option<String>,
    ) -> Result<UserAccount, AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.register_user(player_id, email, password_hash, display_name)
            }
            Self::Postgres(pg) => {
                pg.register_user(player_id, email, password_hash, display_name)
                    .await
            }
        }
    }

    /// See [`InMemoryAuthStore::find_by_email`].
    pub async fn find_by_email(&self, email: &str) -> Result<Option<UserRecord>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.find_by_email(email)),
            Self::Postgres(pg) => pg.find_by_email(email).await,
        }
    }

    /// See [`InMemoryAuthStore::get_user`].
    pub async fn get_user(&self, player_id: &str) -> Result<Option<UserAccount>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_user(player_id)),
            Self::Postgres(pg) => pg.get_user(player_id).await,
        }
    }

    /// See [`InMemoryAuthStore::get_users_by_ids`].
    pub async fn get_users_by_ids(
        &self,
        player_ids: &[String],
    ) -> Result<std::collections::HashMap<String, UserAccount>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_users_by_ids(player_ids)),
            Self::Postgres(pg) => pg.get_users_by_ids(player_ids).await,
        }
    }

    /// See [`InMemoryAuthStore::set_role`].
    pub async fn set_role(&self, player_id: &str, role: &str) -> Result<UserAccount, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.set_role(player_id, role),
            Self::Postgres(pg) => pg.set_role(player_id, role).await,
        }
    }

    /// See [`InMemoryAuthStore::list_users`].
    pub async fn list_users(&self) -> Result<Vec<UserAccount>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.list_users()),
            Self::Postgres(pg) => pg.list_users().await,
        }
    }

    /// See [`InMemoryAuthStore::create_session`].
    pub async fn create_session(&self, token: &str, player_id: &str) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.create_session(token, player_id);
                Ok(())
            }
            Self::Postgres(pg) => pg.create_session(token, player_id).await,
        }
    }

    /// See [`InMemoryAuthStore::set_display_name`].
    pub async fn set_display_name(
        &self,
        player_id: &str,
        display_name: Option<String>,
    ) -> Result<UserAccount, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.set_display_name(player_id, display_name),
            Self::Postgres(pg) => pg.set_display_name(player_id, display_name).await,
        }
    }

    /// See [`InMemoryAuthStore::set_password`].
    pub async fn set_password(&self, player_id: &str, password_hash: &str) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.set_password(player_id, password_hash),
            Self::Postgres(pg) => pg.set_password(player_id, password_hash).await,
        }
    }

    /// See [`InMemoryAuthStore::confirm_email`].
    pub async fn confirm_email(&self, player_id: &str, at: u64) -> Result<UserAccount, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.confirm_email(player_id, at),
            Self::Postgres(pg) => pg.confirm_email(player_id, at).await,
        }
    }

    /// See [`InMemoryAuthStore::create_auth_token`].
    pub async fn create_auth_token(
        &self,
        token_hash: &str,
        rec: AuthTokenRecord,
    ) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.create_auth_token(token_hash, rec);
                Ok(())
            }
            Self::Postgres(pg) => pg.create_auth_token(token_hash, rec).await,
        }
    }

    /// See [`InMemoryAuthStore::consume_auth_token`].
    pub async fn consume_auth_token(
        &self,
        token_hash: &str,
        kind: &str,
        now: u64,
    ) -> Result<Option<String>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.consume_auth_token(token_hash, kind, now)),
            Self::Postgres(pg) => pg.consume_auth_token(token_hash, kind, now).await,
        }
    }

    /// See [`InMemoryAuthStore::consume_auth_token_by_code`].
    pub async fn consume_auth_token_by_code(
        &self,
        player_id: &str,
        kind: &str,
        code_hash: &str,
        now: u64,
    ) -> Result<Option<String>, AppError> {
        match self {
            Self::InMemory(m) => Ok(
                Self::lock_inmem(m)?.consume_auth_token_by_code(player_id, kind, code_hash, now)
            ),
            Self::Postgres(pg) => {
                pg.consume_auth_token_by_code(player_id, kind, code_hash, now)
                    .await
            }
        }
    }

    /// See [`InMemoryAuthStore::delete_user`].
    pub async fn delete_user(&self, player_id: &str) -> Result<bool, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.delete_user(player_id)),
            Self::Postgres(pg) => pg.delete_user(player_id).await,
        }
    }

    /// See [`InMemoryAuthStore::get_session`].
    pub async fn get_session(&self, token: &str) -> Result<Option<String>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_session(token)),
            Self::Postgres(pg) => pg.get_session(token).await,
        }
    }

    /// See [`InMemoryAuthStore::account_for_session`].
    pub async fn account_for_session(&self, token: &str) -> Result<Option<UserAccount>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.account_for_session(token)),
            Self::Postgres(pg) => pg.account_for_session(token).await,
        }
    }

    /// See [`InMemoryAuthStore::find_identity`].
    pub async fn find_identity(
        &self,
        provider: &str,
        subject: &str,
    ) -> Result<Option<String>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.find_identity(provider, subject)),
            Self::Postgres(pg) => pg.find_identity(provider, subject).await,
        }
    }

    /// See [`InMemoryAuthStore::create_identity`].
    pub async fn create_identity(&self, identity: AuthIdentity) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.create_identity(identity),
            Self::Postgres(pg) => pg.create_identity(identity).await,
        }
    }

    /// See [`InMemoryAuthStore::set_identity_username`].
    pub async fn set_identity_username(
        &self,
        provider: &str,
        subject: &str,
        username: Option<String>,
    ) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.set_identity_username(provider, subject, username);
                Ok(())
            }
            Self::Postgres(pg) => pg.set_identity_username(provider, subject, username).await,
        }
    }

    /// See [`InMemoryAuthStore::identities_for_player`].
    pub async fn identities_for_player(
        &self,
        player_id: &str,
    ) -> Result<Vec<AuthIdentity>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.identities_for_player(player_id)),
            Self::Postgres(pg) => pg.identities_for_player(player_id).await,
        }
    }

    /// See [`InMemoryAuthStore::identities_for_players`].
    pub async fn identities_for_players(
        &self,
        player_ids: &[String],
    ) -> Result<HashMap<String, Vec<AuthIdentity>>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.identities_for_players(player_ids)),
            Self::Postgres(pg) => pg.identities_for_players(player_ids).await,
        }
    }

    /// See [`InMemoryAuthStore::delete_identity`].
    pub async fn delete_identity(&self, provider: &str, player_id: &str) -> Result<bool, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.delete_identity(provider, player_id)),
            Self::Postgres(pg) => pg.delete_identity(provider, player_id).await,
        }
    }

    /// See [`InMemoryAuthStore::create_social_account`].
    pub async fn create_social_account(
        &self,
        player_id: &str,
        email: Option<String>,
        display_name: Option<String>,
        email_confirmed_at: Option<u64>,
    ) -> Result<UserAccount, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.create_social_account(
                player_id,
                email,
                display_name,
                email_confirmed_at,
            ),
            Self::Postgres(pg) => {
                pg.create_social_account(player_id, email, display_name, email_confirmed_at)
                    .await
            }
        }
    }

    /// See [`InMemoryAuthStore::attach_email`].
    pub async fn attach_email(
        &self,
        player_id: &str,
        email: &str,
        confirmed_at: u64,
    ) -> Result<UserAccount, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.attach_email(player_id, email, confirmed_at),
            Self::Postgres(pg) => pg.attach_email(player_id, email, confirmed_at).await,
        }
    }
}

/// Grant/published-quest storage backend (see [`FactStores`] for the pattern).
#[derive(Clone, Debug)]
pub enum GrantStores {
    /// Non-durable, zero-infra (tests + dev without DATABASE_URL).
    InMemory(std::sync::Arc<std::sync::Mutex<InMemoryGrantStore>>),
    /// Durable PostgreSQL.
    Postgres(PgGrantStore),
}

impl GrantStores {
    fn lock_inmem(
        m: &std::sync::Mutex<InMemoryGrantStore>,
    ) -> Result<std::sync::MutexGuard<'_, InMemoryGrantStore>, AppError> {
        m.lock()
            .map_err(|e| AppError::Internal(anyhow::anyhow!("grants lock poisoned: {e}")))
    }

    /// See [`InMemoryGrantStore::create_grant_idemp`].
    pub async fn create_grant_idemp(
        &self,
        player: &str,
        quest: &str,
        source: GrantSource,
        source_ref: Option<String>,
    ) -> Result<(AccessGrant, bool), AppError> {
        match self {
            Self::InMemory(m) => {
                Ok(Self::lock_inmem(m)?.create_grant_idemp(player, quest, source, source_ref))
            }
            Self::Postgres(pg) => {
                pg.create_grant_idemp(player, quest, source, source_ref)
                    .await
            }
        }
    }

    /// See [`InMemoryGrantStore::has_grant`].
    pub async fn has_grant(&self, player: &str, quest: &str) -> Result<bool, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.has_grant(player, quest)),
            Self::Postgres(pg) => pg.has_grant(player, quest).await,
        }
    }

    /// See [`InMemoryGrantStore::list_published`].
    pub async fn list_published(&self) -> Result<Vec<PublishedMeta>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.list_published()),
            Self::Postgres(pg) => pg.list_published().await,
        }
    }

    /// See [`InMemoryGrantStore::get_published`].
    pub async fn get_published(&self, quest_id: &str) -> Result<Option<PublishedMeta>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_published(quest_id).cloned()),
            Self::Postgres(pg) => pg.get_published(quest_id).await,
        }
    }

    /// See [`InMemoryGrantStore::register_published`].
    pub async fn register_published(
        &self,
        quest_id: &str,
        meta: PublishedMeta,
        snapshot: Option<serde_json::Value>,
    ) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.register_published(quest_id, meta, snapshot),
            Self::Postgres(pg) => pg.register_published(quest_id, meta, snapshot).await,
        }
    }

    /// See [`InMemoryGrantStore::stats_purchase_events`].
    pub async fn stats_purchase_events(
        &self,
        from: i64,
        to_excl: i64,
        quest: Option<&str>,
    ) -> Result<Vec<crate::admin_stats::StatEvent>, AppError> {
        match self {
            Self::InMemory(m) => {
                Ok(Self::lock_inmem(m)?.stats_purchase_events(from, to_excl, quest))
            }
            Self::Postgres(pg) => pg.stats_purchase_events(from, to_excl, quest).await,
        }
    }

    /// See [`InMemoryGrantStore::list_all_grants`].
    pub async fn list_all_grants(&self) -> Result<Vec<AccessGrant>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.list_all_grants()),
            Self::Postgres(pg) => pg.list_all_grants().await,
        }
    }

    /// See [`InMemoryGrantStore::buyers_by_quest`].
    pub async fn buyers_by_quest(
        &self,
    ) -> Result<std::collections::HashMap<String, usize>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.buyers_by_quest()),
            Self::Postgres(pg) => pg.buyers_by_quest().await,
        }
    }

    /// See [`InMemoryGrantStore::buyers_for_quest`].
    pub async fn buyers_for_quest(&self, quest_id: &str) -> Result<usize, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.buyers_for_quest(quest_id)),
            Self::Postgres(pg) => pg.buyers_for_quest(quest_id).await,
        }
    }

    /// See [`InMemoryGrantStore::delete_grants_for_player`].
    pub async fn delete_grants_for_player(&self, player_id: &str) -> Result<usize, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.delete_grants_for_player(player_id)),
            Self::Postgres(pg) => pg.delete_grants_for_player(player_id).await,
        }
    }

    /// See [`InMemoryGrantStore::grants_for_player`].
    pub async fn grants_for_player(&self, player_id: &str) -> Result<Vec<AccessGrant>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.grants_for_player(player_id)),
            Self::Postgres(pg) => pg.grants_for_player(player_id).await,
        }
    }

    /// See [`InMemoryGrantStore::get_bundle`].
    pub async fn get_bundle(
        &self,
        quest_id: &str,
    ) -> Result<Option<(PublishedMeta, Option<serde_json::Value>)>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_bundle(quest_id)),
            Self::Postgres(pg) => pg.get_bundle(quest_id).await,
        }
    }

    /// See [`InMemoryGrantStore::get_snapshot`].
    pub async fn get_snapshot(
        &self,
        snapshot_id: &str,
    ) -> Result<Option<serde_json::Value>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_snapshot(snapshot_id)),
            Self::Postgres(pg) => pg.get_snapshot(snapshot_id).await,
        }
    }
}

/// Editorial lifecycle of a constructor quest — the status the dashboard shows
/// and edits. `published` is set by the publish flow; `draft`/`test` are
/// author-chosen. Stored as a plain string, constrained in code
/// ([`validate_ctor_status`]) and at the DB (a CHECK constraint).
pub const CTOR_STATUS_DRAFT: &str = "draft";
pub const CTOR_STATUS_TEST: &str = "test";
pub const CTOR_STATUS_PUBLISHED: &str = "published";
pub const CTOR_STATUSES: [&str; 3] = [CTOR_STATUS_DRAFT, CTOR_STATUS_TEST, CTOR_STATUS_PUBLISHED];

/// Reject any status outside the known set (400). Keeps the column honest in the
/// in-memory store too, where no DB CHECK constraint exists.
pub fn validate_ctor_status(status: &str) -> Result<(), AppError> {
    if CTOR_STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "invalid status '{status}' (expected one of: draft, test, published)"
        )))
    }
}

/// Quest complexity — a closed set, same TEXT+CHECK+validate pattern as
/// [`validate_ctor_status`].
pub const COMPLEXITY_LOW: &str = "low";
pub const COMPLEXITY_MEDIUM: &str = "medium";
pub const COMPLEXITY_HIGH: &str = "high";
pub const COMPLEXITIES: [&str; 3] = [COMPLEXITY_LOW, COMPLEXITY_MEDIUM, COMPLEXITY_HIGH];

/// Audience of the quest — a closed set.
pub const AGE_KIDS: &str = "kids";
pub const AGE_EVERYONE: &str = "everyone";
pub const AGE_18PLUS: &str = "18plus";
pub const AGE_TARGETS: [&str; 3] = [AGE_KIDS, AGE_EVERYONE, AGE_18PLUS];

/// Tag caps — validation limits, not silent truncation (over-limit input is a 400).
pub const MAX_TAGS: usize = 20;
pub const MAX_TAG_LEN: usize = 40;

/// Author-facing quest attributes: complexity, audience, free-form tags. Stored
/// as denormalized list columns on the constructor row (the dashboard filters on
/// list rows), while the same values also live inside the opaque `body.meta` for
/// the builder's working copy.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QuestAttributes {
    pub complexity: String,
    pub age_target: String,
    pub tags: Vec<String>,
}

/// Store-catalog projection of a constructor row: the lifecycle status that
/// governs marketplace visibility plus the author's attributes (the store page
/// filters on them). One scan feeds both concerns.
#[derive(Clone, Debug)]
pub struct CatalogListing {
    pub status: String,
    pub attrs: QuestAttributes,
}

impl Default for QuestAttributes {
    /// Neutral values for quests that never set attributes (old clients, old rows).
    fn default() -> Self {
        Self {
            complexity: COMPLEXITY_MEDIUM.to_string(),
            age_target: AGE_EVERYONE.to_string(),
            tags: Vec::new(),
        }
    }
}

impl QuestAttributes {
    /// Validate + normalize wire input. Absent fields fall back to the neutral
    /// defaults (old clients that do not send attributes keep working); present
    /// fields must belong to the closed sets. Tags are trimmed, blanks dropped,
    /// order-preserving deduped; over-cap input is rejected, never truncated.
    pub fn from_wire(
        complexity: Option<String>,
        age_target: Option<String>,
        tags: Option<Vec<String>>,
    ) -> Result<Self, AppError> {
        let defaults = Self::default();
        let complexity = complexity.unwrap_or(defaults.complexity);
        if !COMPLEXITIES.contains(&complexity.as_str()) {
            return Err(AppError::BadRequest(format!(
                "invalid complexity '{complexity}' (expected one of: low, medium, high)"
            )));
        }
        let age_target = age_target.unwrap_or(defaults.age_target);
        if !AGE_TARGETS.contains(&age_target.as_str()) {
            return Err(AppError::BadRequest(format!(
                "invalid age_target '{age_target}' (expected one of: kids, everyone, 18plus)"
            )));
        }
        let mut seen = std::collections::HashSet::new();
        let mut normalized = Vec::new();
        for tag in tags.unwrap_or_default() {
            let tag = tag.trim();
            if tag.is_empty() {
                continue;
            }
            if tag.chars().count() > MAX_TAG_LEN {
                return Err(AppError::BadRequest(format!(
                    "tag '{tag}' is longer than {MAX_TAG_LEN} characters"
                )));
            }
            if seen.insert(tag.to_string()) {
                normalized.push(tag.to_string());
            }
        }
        if normalized.len() > MAX_TAGS {
            return Err(AppError::BadRequest(format!(
                "too many tags ({}, max {MAX_TAGS})",
                normalized.len()
            )));
        }
        Ok(Self {
            complexity,
            age_target,
            tags: normalized,
        })
    }
}

/// A constructor quest: the full editable authoring `body` (the CtorQuest JSON,
/// opaque to the backend) plus the denormalized list columns the dashboard reads.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ConstructorQuest {
    pub quest_id: String,
    pub author_id: String,
    pub author_name: String,
    pub name: String,
    pub status: String,
    pub cover: Option<String>,
    pub steps_count: u32,
    /// Complexity / audience / tags — the dashboard's filterable columns.
    pub attrs: QuestAttributes,
    pub created_at: u64,
    pub updated_at: u64,
    /// Full editable CtorQuest JSON — the builder's working copy.
    pub body: serde_json::Value,
}

/// Dashboard list row — everything in [`ConstructorQuest`] except the two HEAVY
/// columns: the `body` and the `cover`. The dashboard renders a name-derived
/// thumbnail, never the stored cover image, so shipping each quest's base64
/// `cover` in the list was pure dead weight — for media-heavy (e.g. imported)
/// quests that meant megabytes per page load. The cover stays on the full
/// [`ConstructorQuest`] (GET-one); the list omits it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ConstructorQuestSummary {
    pub quest_id: String,
    pub author_id: String,
    pub author_name: String,
    pub name: String,
    pub status: String,
    pub steps_count: u32,
    /// Complexity / audience / tags — the dashboard's filterable columns.
    pub attrs: QuestAttributes,
    pub created_at: u64,
    pub updated_at: u64,
}

impl ConstructorQuest {
    /// Strip the body for the list view.
    pub fn summary(&self) -> ConstructorQuestSummary {
        ConstructorQuestSummary {
            quest_id: self.quest_id.clone(),
            author_id: self.author_id.clone(),
            author_name: self.author_name.clone(),
            name: self.name.clone(),
            status: self.status.clone(),
            steps_count: self.steps_count,
            attrs: self.attrs.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// In-memory constructor-quest registry (drafts + bodies + lifecycle).
#[derive(Clone, Debug, Default)]
pub struct InMemoryConstructorStore {
    quests: HashMap<String, ConstructorQuest>,
}

impl InMemoryConstructorStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a new quest; rejects a duplicate id (409).
    pub fn create(&mut self, quest: ConstructorQuest) -> Result<ConstructorQuestSummary, AppError> {
        if self.quests.contains_key(&quest.quest_id) {
            return Err(AppError::Conflict(format!(
                "constructor quest '{}' already exists",
                quest.quest_id
            )));
        }
        let summary = quest.summary();
        self.quests.insert(quest.quest_id.clone(), quest);
        Ok(summary)
    }

    /// One author's quests as list rows, newest first (ties by id for a stable
    /// order). The dashboard is a personal workspace: an editor/admin sees only
    /// the quests they authored, never anyone else's — author scoping is the
    /// invariant, not a UI filter (a player could otherwise read the list via the
    /// raw API).
    pub fn list_summaries_for_author(&self, author_id: &str) -> Vec<ConstructorQuestSummary> {
        let mut v: Vec<_> = self
            .quests
            .values()
            .filter(|q| q.author_id == author_id)
            .map(|q| q.summary())
            .collect();
        v.sort_by_key(|q| q.quest_id.clone());
        v.sort_by_key(|q| std::cmp::Reverse(q.created_at));
        v
    }

    /// Full quest (with body) by id.
    pub fn get(&self, quest_id: &str) -> Option<ConstructorQuest> {
        self.quests.get(quest_id).cloned()
    }

    /// Replace the editable body + denormalized list fields (autosave). 404 if unknown.
    #[allow(clippy::too_many_arguments)] // autosave payload; pre-existing shape
    pub fn save_body(
        &mut self,
        quest_id: &str,
        name: &str,
        cover: Option<String>,
        steps_count: u32,
        attrs: QuestAttributes,
        body: serde_json::Value,
        updated_at: u64,
    ) -> Result<ConstructorQuestSummary, AppError> {
        let q = self.quests.get_mut(quest_id).ok_or_else(|| {
            AppError::NotFound(format!("constructor quest '{quest_id}' not found"))
        })?;
        q.name = name.to_string();
        q.cover = cover;
        q.steps_count = steps_count;
        q.attrs = attrs;
        q.body = body;
        q.updated_at = updated_at;
        Ok(q.summary())
    }

    /// Set the lifecycle status; `None` if the quest does not exist (the publish
    /// flow calls this best-effort for quests that were never constructor-tracked).
    pub fn set_status(
        &mut self,
        quest_id: &str,
        status: &str,
        updated_at: u64,
    ) -> Option<ConstructorQuestSummary> {
        let q = self.quests.get_mut(quest_id)?;
        q.status = status.to_string();
        q.updated_at = updated_at;
        Some(q.summary())
    }

    /// Every author's quests as list rows, newest first (ties by id). The admin
    /// view: an admin account is the superuser and manages every author's quest in
    /// any state, so — unlike [`Self::list_summaries_for_author`] — this is NOT
    /// scoped. Editors and the ops-token path keep the per-author list.
    pub fn list_all_summaries(&self) -> Vec<ConstructorQuestSummary> {
        let mut v: Vec<_> = self.quests.values().map(|q| q.summary()).collect();
        v.sort_by_key(|q| q.quest_id.clone());
        v.sort_by_key(|q| std::cmp::Reverse(q.created_at));
        v
    }

    /// `quest_id` → catalog listing info for every constructor quest. The store
    /// catalog consults this so marketplace visibility is a function of the
    /// AUTHORITATIVE status (a single source of truth), not the mere presence of a
    /// frozen snapshot — a quest the author moved to `test`/`draft` keeps its
    /// snapshot (still resolvable by direct link, grant-gated) but leaves the
    /// store. The attributes ride along for the store-page filters.
    pub fn listings_by_quest(&self) -> HashMap<String, CatalogListing> {
        self.quests
            .iter()
            .map(|(id, q)| {
                (
                    id.clone(),
                    CatalogListing {
                        status: q.status.clone(),
                        attrs: q.attrs.clone(),
                    },
                )
            })
            .collect()
    }

    /// Delete a quest; `true` if a row was removed.
    pub fn delete(&mut self, quest_id: &str) -> bool {
        self.quests.remove(quest_id).is_some()
    }
}

/// Constructor-quest storage backend (see [`FactStores`] for the pattern).
#[derive(Clone, Debug)]
pub enum ConstructorStores {
    /// Non-durable, zero-infra (tests + dev without DATABASE_URL).
    InMemory(std::sync::Arc<std::sync::Mutex<InMemoryConstructorStore>>),
    /// Durable PostgreSQL.
    Postgres(PgConstructorStore),
}

impl ConstructorStores {
    fn lock_inmem(
        m: &std::sync::Mutex<InMemoryConstructorStore>,
    ) -> Result<std::sync::MutexGuard<'_, InMemoryConstructorStore>, AppError> {
        m.lock()
            .map_err(|e| AppError::Internal(anyhow::anyhow!("constructor lock poisoned: {e}")))
    }

    /// See [`InMemoryConstructorStore::create`].
    pub async fn create(
        &self,
        quest: ConstructorQuest,
    ) -> Result<ConstructorQuestSummary, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.create(quest),
            Self::Postgres(pg) => pg.create(quest).await,
        }
    }

    /// See [`InMemoryConstructorStore::list_summaries_for_author`].
    pub async fn list_summaries_for_author(
        &self,
        author_id: &str,
    ) -> Result<Vec<ConstructorQuestSummary>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.list_summaries_for_author(author_id)),
            Self::Postgres(pg) => pg.list_summaries_for_author(author_id).await,
        }
    }

    /// See [`InMemoryConstructorStore::get`].
    pub async fn get(&self, quest_id: &str) -> Result<Option<ConstructorQuest>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get(quest_id)),
            Self::Postgres(pg) => pg.get(quest_id).await,
        }
    }

    /// See [`InMemoryConstructorStore::save_body`].
    #[allow(clippy::too_many_arguments)] // autosave payload; pre-existing shape
    pub async fn save_body(
        &self,
        quest_id: &str,
        name: &str,
        cover: Option<String>,
        steps_count: u32,
        attrs: QuestAttributes,
        body: serde_json::Value,
        updated_at: u64,
    ) -> Result<ConstructorQuestSummary, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.save_body(
                quest_id,
                name,
                cover,
                steps_count,
                attrs,
                body,
                updated_at,
            ),
            Self::Postgres(pg) => {
                pg.save_body(quest_id, name, cover, steps_count, attrs, body, updated_at)
                    .await
            }
        }
    }

    /// See [`InMemoryConstructorStore::set_status`].
    pub async fn set_status(
        &self,
        quest_id: &str,
        status: &str,
        updated_at: u64,
    ) -> Result<Option<ConstructorQuestSummary>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.set_status(quest_id, status, updated_at)),
            Self::Postgres(pg) => pg.set_status(quest_id, status, updated_at).await,
        }
    }

    /// See [`InMemoryConstructorStore::list_all_summaries`].
    pub async fn list_all_summaries(&self) -> Result<Vec<ConstructorQuestSummary>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.list_all_summaries()),
            Self::Postgres(pg) => pg.list_all_summaries().await,
        }
    }

    /// See [`InMemoryConstructorStore::listings_by_quest`].
    pub async fn listings_by_quest(&self) -> Result<HashMap<String, CatalogListing>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.listings_by_quest()),
            Self::Postgres(pg) => pg.listings_by_quest().await,
        }
    }

    /// See [`InMemoryConstructorStore::delete`].
    pub async fn delete(&self, quest_id: &str) -> Result<bool, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.delete(quest_id)),
            Self::Postgres(pg) => pg.delete(quest_id).await,
        }
    }
}

/// In-memory coupon registry + redemption log (the executable spec the
/// Postgres store mirrors). Redemptions are unique per
/// `(coupon_id, player_id, quest_id)` — same granularity as access grants —
/// so a checkout retry never double-consumes a coupon.
#[derive(Clone, Debug, Default)]
pub struct InMemoryCouponStore {
    coupons: HashMap<String, Coupon>,
    redemptions: Vec<CouponRedemption>,
}

impl InMemoryCouponStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    fn code_taken(&self, code: &str, except_id: &str) -> bool {
        self.coupons
            .values()
            .any(|c| c.code == code && c.coupon_id != except_id)
    }

    fn usage_of(&self, coupon_id: &str) -> CouponUsage {
        let mut usage = CouponUsage::default();
        for r in self.redemptions.iter().filter(|r| r.coupon_id == coupon_id) {
            usage.used += 1;
            usage.total_discounted += r.amount_discounted;
            if usage.last_redeemed_at.as_deref() < Some(r.redeemed_at.as_str()) {
                usage.last_redeemed_at = Some(r.redeemed_at.clone());
            }
        }
        usage
    }

    fn used_by(&self, coupon_id: &str, player_id: &str) -> u32 {
        self.redemptions
            .iter()
            .filter(|r| r.coupon_id == coupon_id && r.player_id == player_id)
            .count() as u32
    }

    /// Register a new coupon; the code must be unique among all coupons.
    pub fn create(&mut self, coupon: Coupon) -> Result<Coupon, AppError> {
        if self.code_taken(&coupon.code, &coupon.coupon_id) {
            return Err(AppError::Conflict(format!(
                "купон с кодом '{}' уже существует",
                coupon.code
            )));
        }
        self.coupons
            .insert(coupon.coupon_id.clone(), coupon.clone());
        Ok(coupon)
    }

    /// Replace the editable fields of an existing coupon (created_at and the
    /// redemption log are preserved by construction — the handler builds the
    /// updated record from the stored one).
    pub fn update(&mut self, coupon: Coupon) -> Result<Coupon, AppError> {
        if !self.coupons.contains_key(&coupon.coupon_id) {
            return Err(AppError::NotFound(format!(
                "unknown coupon '{}'",
                coupon.coupon_id
            )));
        }
        if self.code_taken(&coupon.code, &coupon.coupon_id) {
            return Err(AppError::Conflict(format!(
                "купон с кодом '{}' уже существует",
                coupon.code
            )));
        }
        self.coupons
            .insert(coupon.coupon_id.clone(), coupon.clone());
        Ok(coupon)
    }

    /// Fetch one coupon by id.
    pub fn get(&self, coupon_id: &str) -> Option<Coupon> {
        self.coupons.get(coupon_id).cloned()
    }

    /// Delete a coupon and its redemption log. Grants stay — «уже применённые
    /// скидки сохраняются». Returns NotFound for an unknown id.
    pub fn delete(&mut self, coupon_id: &str) -> Result<(), AppError> {
        if self.coupons.remove(coupon_id).is_none() {
            return Err(AppError::NotFound(format!("unknown coupon '{coupon_id}'")));
        }
        self.redemptions.retain(|r| r.coupon_id != coupon_id);
        Ok(())
    }

    /// All coupons with their folded usage, newest first (admin list).
    pub fn list_with_usage(&self) -> Vec<(Coupon, CouponUsage)> {
        let mut rows: Vec<_> = self
            .coupons
            .values()
            .map(|c| (c.clone(), self.usage_of(&c.coupon_id)))
            .collect();
        rows.sort_by(|(a, _), (b, _)| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.coupon_id.cmp(&b.coupon_id))
        });
        rows
    }

    /// One coupon with usage (admin detail).
    pub fn get_with_usage(&self, coupon_id: &str) -> Option<(Coupon, CouponUsage)> {
        self.coupons
            .get(coupon_id)
            .map(|c| (c.clone(), self.usage_of(coupon_id)))
    }

    /// Redeemability snapshot for the purchase-sheet preview: the coupon (by
    /// normalized code) plus the counts the pure decision needs.
    pub fn preview(&self, code: &str, player_id: &str) -> Option<(Coupon, u32, u32)> {
        let coupon = self.coupons.values().find(|c| c.code == code)?.clone();
        let used_total = self.usage_of(&coupon.coupon_id).used;
        let used_by_player = self.used_by(&coupon.coupon_id, player_id);
        Some((coupon, used_total, used_by_player))
    }

    /// Atomically re-check and record a redemption (the store owns the whole
    /// critical section, so the counts cannot move between check and insert).
    /// A repeat for the same `(coupon, player, quest)` returns the recorded
    /// redemption unchanged — idempotent, mirroring the grant path.
    pub fn redeem(
        &mut self,
        code: &str,
        player_id: &str,
        quest_id: &str,
        price: i64,
    ) -> Result<CouponRedemption, AppError> {
        let coupon = self
            .coupons
            .values()
            .find(|c| c.code == code)
            .cloned()
            .ok_or_else(|| AppError::NotFound("промокод не найден".into()))?;
        if let Some(existing) = self.redemptions.iter().find(|r| {
            r.coupon_id == coupon.coupon_id && r.player_id == player_id && r.quest_id == quest_id
        }) {
            return Ok(existing.clone());
        }
        let now = now_rfc3339();
        let today = &now[..10];
        let used_total = self.usage_of(&coupon.coupon_id).used;
        let used_by_player = self.used_by(&coupon.coupon_id, player_id);
        check_redeemable(&coupon, quest_id, used_total, used_by_player, today)
            .map_err(|reject| AppError::Conflict(reject.message().into()))?;
        let redemption = CouponRedemption {
            coupon_id: coupon.coupon_id.clone(),
            player_id: player_id.to_string(),
            quest_id: quest_id.to_string(),
            amount_discounted: discount_amount(&coupon.discount, price),
            redeemed_at: now,
        };
        self.redemptions.push(redemption.clone());
        Ok(redemption)
    }
}

/// Coupon storage behind the same enum-dispatch seam as the other stores.
#[derive(Clone, Debug)]
pub enum CouponStores {
    /// Non-durable, zero-infra (tests + dev without DATABASE_URL).
    InMemory(std::sync::Arc<std::sync::Mutex<InMemoryCouponStore>>),
    /// Durable PostgreSQL.
    Postgres(PgCouponStore),
}

impl CouponStores {
    fn lock_inmem(
        m: &std::sync::Mutex<InMemoryCouponStore>,
    ) -> Result<std::sync::MutexGuard<'_, InMemoryCouponStore>, AppError> {
        m.lock()
            .map_err(|e| AppError::Internal(anyhow::anyhow!("coupons lock poisoned: {e}")))
    }

    /// See [`InMemoryCouponStore::create`].
    pub async fn create(&self, coupon: Coupon) -> Result<Coupon, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.create(coupon),
            Self::Postgres(pg) => pg.create(coupon).await,
        }
    }

    /// See [`InMemoryCouponStore::update`].
    pub async fn update(&self, coupon: Coupon) -> Result<Coupon, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.update(coupon),
            Self::Postgres(pg) => pg.update(coupon).await,
        }
    }

    /// See [`InMemoryCouponStore::get`].
    pub async fn get(&self, coupon_id: &str) -> Result<Option<Coupon>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get(coupon_id)),
            Self::Postgres(pg) => pg.get(coupon_id).await,
        }
    }

    /// See [`InMemoryCouponStore::delete`].
    pub async fn delete(&self, coupon_id: &str) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.delete(coupon_id),
            Self::Postgres(pg) => pg.delete(coupon_id).await,
        }
    }

    /// See [`InMemoryCouponStore::list_with_usage`].
    pub async fn list_with_usage(&self) -> Result<Vec<(Coupon, CouponUsage)>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.list_with_usage()),
            Self::Postgres(pg) => pg.list_with_usage().await,
        }
    }

    /// See [`InMemoryCouponStore::get_with_usage`].
    pub async fn get_with_usage(
        &self,
        coupon_id: &str,
    ) -> Result<Option<(Coupon, CouponUsage)>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_with_usage(coupon_id)),
            Self::Postgres(pg) => pg.get_with_usage(coupon_id).await,
        }
    }

    /// See [`InMemoryCouponStore::preview`].
    pub async fn preview(
        &self,
        code: &str,
        player_id: &str,
    ) -> Result<Option<(Coupon, u32, u32)>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.preview(code, player_id)),
            Self::Postgres(pg) => pg.preview(code, player_id).await,
        }
    }

    /// See [`InMemoryCouponStore::redeem`].
    pub async fn redeem(
        &self,
        code: &str,
        player_id: &str,
        quest_id: &str,
        price: i64,
    ) -> Result<CouponRedemption, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.redeem(code, player_id, quest_id, price),
            Self::Postgres(pg) => pg.redeem(code, player_id, quest_id, price).await,
        }
    }
}

/// In-flight redirect payments (YooKassa), keyed by our id. See
/// `migrations/0011_pending_payments.sql` for the model rationale.
#[derive(Debug, Default)]
pub struct InMemoryPaymentStore {
    payments: HashMap<String, PendingPayment>,
}

impl InMemoryPaymentStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Persist a freshly created gateway payment (status = Pending).
    pub fn insert(&mut self, payment: PendingPayment) {
        self.payments.insert(payment.id.clone(), payment);
    }

    pub fn get(&self, id: &str) -> Option<&PendingPayment> {
        self.payments.get(id)
    }

    /// Webhook lookup: notifications carry only the provider's payment id.
    pub fn find_by_provider_id(&self, provider_payment_id: &str) -> Option<&PendingPayment> {
        self.payments
            .values()
            .find(|p| p.provider_payment_id == provider_payment_id)
    }

    /// An open payment for (player, quest), replayed by checkout instead of
    /// creating a duplicate at the gateway.
    pub fn find_pending_for(&self, player_id: &str, quest_id: &str) -> Option<&PendingPayment> {
        self.payments.values().find(|p| {
            p.status == PendingStatus::Pending && p.player_id == player_id && p.quest_id == quest_id
        })
    }

    /// Compare-and-set `Pending -> Succeeded`. Returns whether THIS call made
    /// the transition — the winner (and only the winner) redeems the coupon.
    pub fn settle_succeeded(&mut self, id: &str) -> bool {
        match self.payments.get_mut(id) {
            Some(p) if p.status == PendingStatus::Pending => {
                p.status = PendingStatus::Succeeded;
                true
            }
            _ => false,
        }
    }

    /// Mark `Pending -> Canceled` (no-op unless pending): frees the player to
    /// start a fresh checkout.
    pub fn mark_canceled(&mut self, id: &str) {
        if let Some(p) = self.payments.get_mut(id)
            && p.status == PendingStatus::Pending
        {
            p.status = PendingStatus::Canceled;
        }
    }
}

/// Pending-payment storage behind the same enum-dispatch seam as the others.
#[derive(Clone, Debug)]
pub enum PaymentStores {
    /// Non-durable, zero-infra (tests + dev without DATABASE_URL).
    InMemory(std::sync::Arc<std::sync::Mutex<InMemoryPaymentStore>>),
    /// Durable PostgreSQL.
    Postgres(PgPaymentStore),
}

impl PaymentStores {
    fn lock_inmem(
        m: &std::sync::Mutex<InMemoryPaymentStore>,
    ) -> Result<std::sync::MutexGuard<'_, InMemoryPaymentStore>, AppError> {
        m.lock()
            .map_err(|e| AppError::Internal(anyhow::anyhow!("payments lock poisoned: {e}")))
    }

    /// See [`InMemoryPaymentStore::insert`].
    pub async fn insert(&self, payment: PendingPayment) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.insert(payment);
                Ok(())
            }
            Self::Postgres(pg) => pg.insert(payment).await,
        }
    }

    /// See [`InMemoryPaymentStore::get`].
    pub async fn get(&self, id: &str) -> Result<Option<PendingPayment>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get(id).cloned()),
            Self::Postgres(pg) => pg.get(id).await,
        }
    }

    /// See [`InMemoryPaymentStore::find_by_provider_id`].
    pub async fn find_by_provider_id(
        &self,
        provider_payment_id: &str,
    ) -> Result<Option<PendingPayment>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?
                .find_by_provider_id(provider_payment_id)
                .cloned()),
            Self::Postgres(pg) => pg.find_by_provider_id(provider_payment_id).await,
        }
    }

    /// See [`InMemoryPaymentStore::find_pending_for`].
    pub async fn find_pending_for(
        &self,
        player_id: &str,
        quest_id: &str,
    ) -> Result<Option<PendingPayment>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?
                .find_pending_for(player_id, quest_id)
                .cloned()),
            Self::Postgres(pg) => pg.find_pending_for(player_id, quest_id).await,
        }
    }

    /// See [`InMemoryPaymentStore::settle_succeeded`].
    pub async fn settle_succeeded(&self, id: &str) -> Result<bool, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.settle_succeeded(id)),
            Self::Postgres(pg) => pg.settle_succeeded(id).await,
        }
    }

    /// See [`InMemoryPaymentStore::mark_canceled`].
    pub async fn mark_canceled(&self, id: &str) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.mark_canceled(id);
                Ok(())
            }
            Self::Postgres(pg) => pg.mark_canceled(id).await,
        }
    }
}

/// Admin-set feature-toggle overrides, keyed by `Feature::key()` (the flag
/// registry itself is code — `crate::features`). Absence of a key means "use
/// the compiled-in default"; that is why `clear` exists as a first-class
/// operation rather than storing the default as a row.
#[derive(Debug)]
pub struct InMemoryFlagStore {
    overrides: HashMap<String, bool>,
}

impl Default for InMemoryFlagStore {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryFlagStore {
    /// A fresh store holds no overrides, so every flag reads its code default —
    /// the in-memory twin of an empty `feature_overrides` table.
    pub fn new() -> Self {
        Self {
            overrides: HashMap::new(),
        }
    }

    /// The stored override for `key`, or `None` when the default applies.
    pub fn get(&self, key: &str) -> Option<bool> {
        self.overrides.get(key).copied()
    }

    /// Every stored override at once (the registry is small; callers that
    /// evaluate several flags read the store a single time).
    pub fn all(&self) -> HashMap<String, bool> {
        self.overrides.clone()
    }

    /// Upsert the override (last write wins — a single bool has no merge).
    pub fn set(&mut self, key: &str, enabled: bool) {
        self.overrides.insert(key.to_string(), enabled);
    }

    /// Remove the override so the flag reverts to its code default.
    pub fn clear(&mut self, key: &str) {
        self.overrides.remove(key);
    }
}

/// Feature-override storage behind the same enum-dispatch seam as the others.
#[derive(Clone, Debug)]
pub enum FlagStores {
    /// Non-durable, zero-infra (tests + dev without DATABASE_URL).
    InMemory(std::sync::Arc<std::sync::Mutex<InMemoryFlagStore>>),
    /// Durable PostgreSQL.
    Postgres(PgFlagStore),
}

impl FlagStores {
    fn lock_inmem(
        m: &std::sync::Mutex<InMemoryFlagStore>,
    ) -> Result<std::sync::MutexGuard<'_, InMemoryFlagStore>, AppError> {
        m.lock()
            .map_err(|e| AppError::Internal(anyhow::anyhow!("flags lock poisoned: {e}")))
    }

    /// See [`InMemoryFlagStore::get`].
    pub async fn override_for(&self, key: &str) -> Result<Option<bool>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get(key)),
            Self::Postgres(pg) => pg.get(key).await,
        }
    }

    /// See [`InMemoryFlagStore::all`] — one round trip for multi-flag callers.
    pub async fn all_overrides(&self) -> Result<HashMap<String, bool>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.all()),
            Self::Postgres(pg) => pg.all().await,
        }
    }

    /// See [`InMemoryFlagStore::set`].
    pub async fn set_override(&self, key: &str, enabled: bool) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.set(key, enabled);
                Ok(())
            }
            Self::Postgres(pg) => pg.set(key, enabled).await,
        }
    }

    /// See [`InMemoryFlagStore::clear`].
    pub async fn clear_override(&self, key: &str) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.clear(key);
                Ok(())
            }
            Self::Postgres(pg) => pg.clear(key).await,
        }
    }
}

/// In-memory moderation overlay — the mutable admin decisions that sit *beside* the
/// immutable fact log (content-moderation). Nothing here ever reads or writes `facts`.
///
/// Two independent maps:
/// - `hidden_reviews`: `(player_id, quest_id) -> (hidden_at, hidden_by)`. Presence is
///   the whole signal — the pair's rating is dropped from the public page + average.
/// - `resolved_feedback`: `(quest_id, snapshot_id, step_position) -> (acknowledged,
///   resolved_by)`. `acknowledged` is the report count the admin marked resolved; a
///   group reads resolved only while its current count has not grown past it, so an
///   appended report reopens it (the fold lives in `crate::facts`).
#[derive(Clone, Debug, Default)]
pub struct InMemoryModerationStore {
    hidden_reviews: HashMap<(String, String), (u64, String)>,
    resolved_feedback: HashMap<(String, String, i32), (u64, String)>,
}

impl InMemoryModerationStore {
    /// Create an empty overlay.
    pub fn new() -> Self {
        Self::default()
    }

    /// Hide `(player, quest)` — idempotent (a repeat keeps the original hide).
    pub fn hide_review(&mut self, player: &str, quest: &str, at: u64, by: &str) {
        self.hidden_reviews
            .entry((player.to_string(), quest.to_string()))
            .or_insert_with(|| (at, by.to_string()));
    }

    /// Unhide `(player, quest)` — idempotent (a no-op when not hidden).
    pub fn unhide_review(&mut self, player: &str, quest: &str) {
        self.hidden_reviews
            .remove(&(player.to_string(), quest.to_string()));
    }

    /// The set of hidden `(player_id, quest_id)` pairs — the fold's drop list.
    pub fn hidden_review_keys(&self) -> std::collections::HashSet<(String, String)> {
        self.hidden_reviews.keys().cloned().collect()
    }

    /// Mark a feedback group resolved, recording `acknowledged` = the group's report
    /// count at resolve time (closes the whole group). It reopens automatically once
    /// a newer report pushes the current count past this watermark.
    pub fn resolve_feedback(
        &mut self,
        quest: &str,
        snap: &str,
        step: i32,
        acknowledged: u64,
        by: &str,
    ) {
        self.resolved_feedback.insert(
            (quest.to_string(), snap.to_string(), step),
            (acknowledged, by.to_string()),
        );
    }

    /// Reopen a feedback group — clears the watermark (idempotent when absent).
    pub fn reopen_feedback(&mut self, quest: &str, snap: &str, step: i32) {
        self.resolved_feedback
            .remove(&(quest.to_string(), snap.to_string(), step));
    }

    /// The resolution watermarks `(quest, snapshot, step) -> acknowledged count`.
    pub fn feedback_resolutions(&self) -> HashMap<(String, String, i32), u64> {
        self.resolved_feedback
            .iter()
            .map(|(k, (at, _))| (k.clone(), *at))
            .collect()
    }
}

/// Moderation-overlay storage backend (see [`FactStores`] for the pattern). Holds the
/// mutable admin decisions; never mixed into the immutable fact log.
#[derive(Clone, Debug)]
pub enum ModerationStores {
    /// Non-durable, zero-infra (tests + dev without DATABASE_URL).
    InMemory(std::sync::Arc<std::sync::Mutex<InMemoryModerationStore>>),
    /// Durable PostgreSQL.
    Postgres(crate::pg_store::PgModerationStore),
}

impl ModerationStores {
    fn lock_inmem(
        m: &std::sync::Mutex<InMemoryModerationStore>,
    ) -> Result<std::sync::MutexGuard<'_, InMemoryModerationStore>, AppError> {
        m.lock()
            .map_err(|e| AppError::Internal(anyhow::anyhow!("moderation lock poisoned: {e}")))
    }

    /// See [`InMemoryModerationStore::hide_review`].
    pub async fn hide_review(
        &self,
        player: &str,
        quest: &str,
        at: u64,
        by: &str,
    ) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.hide_review(player, quest, at, by);
                Ok(())
            }
            Self::Postgres(pg) => pg.hide_review(player, quest, at, by).await,
        }
    }

    /// See [`InMemoryModerationStore::unhide_review`].
    pub async fn unhide_review(&self, player: &str, quest: &str) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.unhide_review(player, quest);
                Ok(())
            }
            Self::Postgres(pg) => pg.unhide_review(player, quest).await,
        }
    }

    /// See [`InMemoryModerationStore::hidden_review_keys`].
    pub async fn hidden_review_keys(
        &self,
    ) -> Result<std::collections::HashSet<(String, String)>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.hidden_review_keys()),
            Self::Postgres(pg) => pg.hidden_review_keys().await,
        }
    }

    /// See [`InMemoryModerationStore::resolve_feedback`].
    pub async fn resolve_feedback(
        &self,
        quest: &str,
        snap: &str,
        step: i32,
        acknowledged: u64,
        by: &str,
    ) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.resolve_feedback(quest, snap, step, acknowledged, by);
                Ok(())
            }
            Self::Postgres(pg) => {
                pg.resolve_feedback(quest, snap, step, acknowledged, by)
                    .await
            }
        }
    }

    /// See [`InMemoryModerationStore::reopen_feedback`].
    pub async fn reopen_feedback(
        &self,
        quest: &str,
        snap: &str,
        step: i32,
    ) -> Result<(), AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.reopen_feedback(quest, snap, step);
                Ok(())
            }
            Self::Postgres(pg) => pg.reopen_feedback(quest, snap, step).await,
        }
    }

    /// See [`InMemoryModerationStore::feedback_resolutions`].
    pub async fn feedback_resolutions(
        &self,
    ) -> Result<HashMap<(String, String, i32), u64>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.feedback_resolutions()),
            Self::Postgres(pg) => pg.feedback_resolutions().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh store holds NO overrides: every flag is off until an admin turns
    /// it on — the in-memory twin of an empty `feature_overrides` table.
    #[test]
    fn fresh_flag_store_has_no_overrides() {
        let mut store = InMemoryFlagStore::new();
        assert!(store.all().is_empty(), "a fresh store stores nothing");
        store.set(crate::features::Feature::PaymentsMock.key(), true);
        assert_eq!(store.get("payments_mock"), Some(true));
        store.clear(crate::features::Feature::PaymentsMock.key());
        assert_eq!(store.get("payments_mock"), None);
    }

    fn fact(kind: FactKind, step: i32, delta: i32) -> Fact {
        Fact {
            kind,
            step_position: step,
            submitted_value: None,
            local_is_correct: true,
            coins_delta: delta,
            note: None,
            device_id: "device-a".into(),
        }
    }

    fn store_with_attempt(quest: &str) -> (InMemoryFactStore, AttemptMeta) {
        let mut s = InMemoryFactStore::new();
        let meta = s.create_attempt("player-1", quest, "snap-v1");
        (s, meta)
    }

    #[test]
    fn rfc3339_formats_known_unix_instants() {
        // Anchors verifiable by hand: epoch, one day later, one (non-leap) year
        // later, and the well-known 10^9 instant — the last only lands correctly
        // if the 2000 leap day is counted, so it exercises the calendar math.
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix(86_400), "1970-01-02T00:00:00Z");
        assert_eq!(rfc3339_from_unix(31_536_000), "1971-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix(1_000_000_000), "2001-09-09T01:46:40Z");
    }

    #[test]
    fn append_rejected_for_unknown_attempt() {
        let mut s = InMemoryFactStore::new();
        assert!(
            s.append_idempotent("ghost", vec![fact(FactKind::PhysicalConfirmed, 0, 0)])
                .is_none()
        );
        assert!(s.get_projected("ghost").is_none());
    }

    #[test]
    fn append_idempotent_and_projection_happy() {
        let (mut s, meta) = store_with_attempt("quest-q");
        let happy = vec![
            fact(FactKind::PhysicalConfirmed, 0, 0),
            Fact {
                submitted_value: Some("МИХАЙЛО ПУПИН".into()),
                ..fact(FactKind::AnswerSubmitted, 1, 0)
            },
            fact(FactKind::GiftClaimed, 2, 5),
            fact(FactKind::AttemptCompleted, 3, 0),
        ];

        let acc1 = s
            .append_idempotent(&meta.attempt_id, happy.clone())
            .expect("known attempt");
        assert_eq!(acc1.len(), 4);
        let (proj, snap, count) = s.get_projected(&meta.attempt_id).expect("projected");
        assert_eq!(proj.balance, 5);
        assert_eq!(proj.completed_steps, vec![0, 1, 3]);
        assert_eq!(snap, "snap-v1");
        assert_eq!(count, 4);

        let acc2 = s
            .append_idempotent(&meta.attempt_id, happy)
            .expect("known attempt");
        assert!(acc2.is_empty(), "identical reconnect is a no-op");
        assert_eq!(s.get_projected(&meta.attempt_id).expect("projected").2, 4);
    }

    #[test]
    fn cross_device_duplicate_award_absorbed() {
        let (mut s, meta) = store_with_attempt("quest-q");
        let gift_a = fact(FactKind::GiftClaimed, 2, 5);
        let gift_b = Fact {
            device_id: "device-b".into(),
            ..gift_a.clone()
        };
        let acc1 = s
            .append_idempotent(&meta.attempt_id, vec![gift_a])
            .expect("known");
        let acc2 = s
            .append_idempotent(&meta.attempt_id, vec![gift_b])
            .expect("known");
        assert_eq!(acc1.len(), 1);
        assert!(
            acc2.is_empty(),
            "same gift from second device must not double-count"
        );
        assert_eq!(
            s.get_projected(&meta.attempt_id)
                .expect("projected")
                .0
                .balance,
            5
        );
    }

    #[test]
    fn overdraft_stays_negative_no_corrections() {
        let (mut s, meta) = store_with_attempt("quest-q");
        s.append_idempotent(&meta.attempt_id, vec![fact(FactKind::GiftClaimed, 2, 3)])
            .expect("known");
        let acc = s
            .append_idempotent(
                &meta.attempt_id,
                vec![Fact {
                    note: Some("hint".into()),
                    ..fact(FactKind::HintPurchased, 1, -5)
                }],
            )
            .expect("known");
        assert_eq!(acc.len(), 1, "hint spend accepted regardless of balance");
        let (proj, _, count) = s.get_projected(&meta.attempt_id).expect("projected");
        assert_eq!(
            proj.balance, -2,
            "negative balance is the legal final state"
        );
        assert_eq!(count, 2, "no compensation facts appended");
    }

    #[test]
    fn completion_bonus_once_per_player_quest_across_attempts() {
        let mut s = InMemoryFactStore::new();
        let first = s.create_attempt("player-1", "quest-q", "snap-v1");
        let bonus = fact(FactKind::CompletionBonus, 3, 5);

        let acc1 = s
            .append_idempotent(&first.attempt_id, vec![bonus.clone()])
            .expect("known");
        assert_eq!(acc1.len(), 1);

        // Reset + replay on a NEW attempt (even a newer version): no second bonus.
        let second = s.create_attempt("player-1", "quest-q", "snap-v2");
        let acc2 = s
            .append_idempotent(&second.attempt_id, vec![bonus.clone()])
            .expect("known");
        assert!(acc2.is_empty(), "bonus is once per (player, quest), ever");

        // A different player on the same quest still earns it.
        let other = s.create_attempt("player-2", "quest-q", "snap-v2");
        let acc3 = s
            .append_idempotent(&other.attempt_id, vec![bonus])
            .expect("known");
        assert_eq!(acc3.len(), 1);
    }

    #[test]
    fn snapshot_binding_frozen_at_creation() {
        let mut s = InMemoryFactStore::new();
        let meta = s.create_attempt("player-1", "quest-q", "snap-v1");
        // A later publish never rebinds existing attempts; new attempts get the new snap.
        let newer = s.create_attempt("player-1", "quest-q", "snap-v2");
        assert_eq!(
            s.get_projected(&meta.attempt_id).expect("known").1,
            "snap-v1"
        );
        assert_eq!(
            s.get_projected(&newer.attempt_id).expect("known").1,
            "snap-v2"
        );
    }

    #[test]
    fn migration_idempotent_by_mark() {
        let mut s = InMemoryFactStore::new();
        let cards = vec![serde_json::json!({"step": 2, "type": "gift", "coins": 5})];
        let first = s.run_legacy_migration(vec![], cards.clone(), "legacy:q");
        assert!(first.marked);
        assert_eq!(first.synth_facts.len(), 1);
        let rerun = s.run_legacy_migration(vec![], cards, "legacy:q");
        assert!(rerun.synth_facts.is_empty(), "re-run is a no-op");
    }
}

#[cfg(test)]
mod grant_tests {
    use super::*;

    #[test]
    fn grant_idempotent_first_source_wins() {
        let mut s = InMemoryGrantStore::new();
        let (_g1, c1) = s.create_grant_idemp(
            "demo-player",
            "quest-q",
            GrantSource::Payment,
            Some("mock-pay-1".into()),
        );
        assert!(c1);
        let (g2, c2) = s.create_grant_idemp(
            "demo-player",
            "quest-q",
            GrantSource::CouponRedemption,
            None,
        );
        assert!(!c2);
        assert_eq!(g2.source, GrantSource::Payment);
        assert_eq!(
            g2.source_ref.as_deref(),
            Some("mock-pay-1"),
            "first audit ref preserved on idemp hit"
        );
        assert!(s.has_grant("demo-player", "quest-q"));
        assert!(!s.has_grant("demo-player", "other"));
    }

    fn meta(snapshot_id: &str, version: u32) -> PublishedMeta {
        PublishedMeta {
            quest_id: "quest-q".into(),
            name: "Q".into(),
            primary_comic: None,
            template_summary: "7 steps".into(),
            snapshot_version: version,
            snapshot_id: snapshot_id.into(),
            city: None,
            duration: None,
            price: None,
            description: None,
            pages: None,
            tasks: None,
            paid_hints: None,
            players_bonus: 0,
        }
    }

    #[test]
    fn publish_register_and_lookup() {
        let mut s = InMemoryGrantStore::new();
        s.register_published("quest-q", meta("quest-q-v1", 1), None)
            .expect("register");
        assert_eq!(s.list_published().len(), 1);
        assert_eq!(
            s.get_published("quest-q").expect("published").snapshot_id,
            "quest-q-v1"
        );
    }

    #[test]
    fn snapshot_content_is_frozen_per_id() {
        let mut s = InMemoryGrantStore::new();
        let v1 = serde_json::json!({"steps": [1, 2, 3]});

        s.register_published("quest-q", meta("s1", 1), Some(v1.clone()))
            .expect("first publish");
        // Identical content: idempotent no-op.
        s.register_published("quest-q", meta("s1", 1), Some(v1.clone()))
            .expect("idempotent re-publish");
        // Different content under the same frozen id: rejected.
        let changed = serde_json::json!({"steps": [1, 2, 3, 4]});
        assert!(
            s.register_published("quest-q", meta("s1", 1), Some(changed.clone()))
                .is_err(),
            "frozen snapshot must not be rewritten"
        );
        // New version with a new id: fine; bundle serves the latest, old stays intact.
        s.register_published("quest-q", meta("s2", 2), Some(changed))
            .expect("new version publishes");
        let (latest, data) = s.get_bundle("quest-q").expect("bundle");
        assert_eq!(latest.snapshot_id, "s2");
        assert_eq!(
            data.expect("data")["steps"]
                .as_array()
                .expect("steps")
                .len(),
            4
        );
    }
}

#[cfg(test)]
mod coupon_tests {
    use super::*;
    use crate::coupons::Discount;

    fn coupon(id: &str, code: &str) -> Coupon {
        Coupon {
            coupon_id: id.into(),
            code: code.into(),
            discount: Discount::Percent(20),
            valid_until: None,
            max_redemptions: None,
            per_user_limit: Some(1),
            quest_ids: None,
            paused: false,
            created_at: now_rfc3339(),
        }
    }

    #[test]
    fn create_rejects_duplicate_code_update_allows_own() {
        let mut s = InMemoryCouponStore::new();
        s.create(coupon("c1", "LETO-20")).expect("first create");
        let dup = s.create(coupon("c2", "LETO-20"));
        assert!(matches!(dup, Err(AppError::Conflict(_))), "duplicate code");
        // Updating c1 keeping its own code is fine; stealing another's is not.
        s.create(coupon("c2", "OTHER")).expect("second create");
        s.update(coupon("c1", "LETO-20")).expect("own code kept");
        let steal = s.update(coupon("c1", "OTHER"));
        assert!(matches!(steal, Err(AppError::Conflict(_))));
        let ghost = s.update(coupon("ghost", "GHOST-1"));
        assert!(matches!(ghost, Err(AppError::NotFound(_))));
    }

    #[test]
    fn redeem_records_usage_and_enforces_limits_atomically() {
        let mut s = InMemoryCouponStore::new();
        let mut c = coupon("c1", "GEOHOD300");
        c.discount = Discount::Fixed(300);
        c.max_redemptions = Some(2);
        c.per_user_limit = Some(1);
        s.create(c).expect("create");

        let r1 = s.redeem("GEOHOD300", "p1", "q1", 900).expect("first");
        assert_eq!(r1.amount_discounted, 300);
        // Same (coupon, player, quest) is idempotent — no second consumption.
        let again = s.redeem("GEOHOD300", "p1", "q1", 900).expect("retry");
        assert_eq!(again, r1);
        assert_eq!(s.usage_of("c1").used, 1);
        // Per-user cap: same player, different quest.
        let per_user = s.redeem("GEOHOD300", "p1", "q2", 900);
        assert!(matches!(per_user, Err(AppError::Conflict(_))));
        // Second player takes the last slot; a third is exhausted.
        s.redeem("GEOHOD300", "p2", "q1", 200).expect("second");
        let spent = s.redeem("GEOHOD300", "p3", "q1", 900);
        assert!(matches!(spent, Err(AppError::Conflict(_))), "exhausted");
        let usage = s.usage_of("c1");
        assert_eq!(usage.used, 2);
        assert_eq!(usage.total_discounted, 300 + 200, "fixed clamps to price");
        assert!(usage.last_redeemed_at.is_some());
        // Unknown code is NotFound, not Conflict.
        assert!(matches!(
            s.redeem("NOPE", "p1", "q1", 100),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn delete_removes_coupon_and_its_log_list_sorts_newest_first() {
        let mut s = InMemoryCouponStore::new();
        let mut old = coupon("c-old", "OLD-1");
        old.created_at = "2026-01-01T00:00:00Z".into();
        let mut new = coupon("c-new", "NEW-1");
        new.created_at = "2026-06-01T00:00:00Z".into();
        s.create(old).expect("old");
        s.create(new).expect("new");
        s.redeem("OLD-1", "p1", "q1", 500).expect("redeem");

        let list = s.list_with_usage();
        assert_eq!(list[0].0.coupon_id, "c-new", "newest first");
        assert_eq!(list[1].1.used, 1);

        s.delete("c-old").expect("delete");
        assert!(s.get("c-old").is_none());
        assert!(s.preview("OLD-1", "p1").is_none());
        assert!(matches!(s.delete("c-old"), Err(AppError::NotFound(_))));
        // The other coupon's log is untouched.
        assert_eq!(s.list_with_usage().len(), 1);
    }

    #[test]
    fn preview_returns_counts_for_the_pure_decision() {
        let mut s = InMemoryCouponStore::new();
        let mut c = coupon("c1", "FRIENDS");
        c.per_user_limit = None;
        s.create(c).expect("create");
        s.redeem("FRIENDS", "p1", "q1", 600).expect("r1");
        s.redeem("FRIENDS", "p2", "q1", 600).expect("r2");
        let (coupon, total, by_p1) = s.preview("FRIENDS", "p1").expect("known code");
        assert_eq!(coupon.coupon_id, "c1");
        assert_eq!(total, 2);
        assert_eq!(by_p1, 1);
        assert!(s.preview("MISSING", "p1").is_none());
    }
}

#[cfg(test)]
mod constructor_tests {
    use super::*;

    fn quest(id: &str, name: &str, created: u64) -> ConstructorQuest {
        ConstructorQuest {
            quest_id: id.into(),
            author_id: "seed:a".into(),
            author_name: "Автор".into(),
            name: name.into(),
            status: CTOR_STATUS_DRAFT.into(),
            cover: None,
            steps_count: 2,
            attrs: QuestAttributes::default(),
            created_at: created,
            updated_at: created,
            body: serde_json::json!({ "id": id, "steps": [] }),
        }
    }

    #[test]
    fn create_lists_newest_first_and_rejects_duplicate() {
        let mut s = InMemoryConstructorStore::new();
        assert!(s.list_summaries_for_author("seed:a").is_empty());
        s.create(quest("q-old", "Old", 100)).expect("create old");
        s.create(quest("q-new", "New", 200)).expect("create new");

        let list = s.list_summaries_for_author("seed:a");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].quest_id, "q-new", "newest created_at first");
        assert_eq!(list[1].quest_id, "q-old");

        assert!(
            s.create(quest("q-old", "Dup", 300)).is_err(),
            "duplicate id rejected"
        );
    }

    #[test]
    fn list_is_scoped_to_the_author() {
        // The dashboard is per-author: each editor sees ONLY their own quests, so
        // the list filters by author_id and never leaks another author's drafts.
        let mut s = InMemoryConstructorStore::new();
        let mut by_a = quest("q-a", "A's quest", 100);
        by_a.author_id = "author-a".into();
        let mut by_b = quest("q-b", "B's quest", 200);
        by_b.author_id = "author-b".into();
        s.create(by_a).expect("create a");
        s.create(by_b).expect("create b");

        let a_list = s.list_summaries_for_author("author-a");
        assert_eq!(a_list.len(), 1);
        assert_eq!(a_list[0].quest_id, "q-a");

        let b_list = s.list_summaries_for_author("author-b");
        assert_eq!(b_list.len(), 1);
        assert_eq!(b_list[0].quest_id, "q-b");

        assert!(
            s.list_summaries_for_author("author-c").is_empty(),
            "a third author sees nothing"
        );
    }

    #[test]
    fn save_body_updates_list_fields_and_404s_unknown() {
        let mut s = InMemoryConstructorStore::new();
        s.create(quest("q1", "Name", 1)).expect("create");
        let attrs = QuestAttributes {
            complexity: "high".into(),
            age_target: "18plus".into(),
            tags: vec!["хоррор".into()],
        };
        let updated = s
            .save_body(
                "q1",
                "Renamed",
                Some("cover.png".into()),
                7,
                attrs.clone(),
                serde_json::json!({ "id": "q1", "steps": [1, 2] }),
                42,
            )
            .expect("save");
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.steps_count, 7);
        assert_eq!(updated.updated_at, 42);
        // Attributes are list columns: the dashboard filters on the summary row.
        assert_eq!(updated.attrs, attrs);
        let full = s.get("q1").expect("present");
        // The cover lives on the full entity, not the (slimmed) list summary.
        assert_eq!(full.cover.as_deref(), Some("cover.png"));
        assert_eq!(full.body["steps"].as_array().expect("steps").len(), 2);

        assert!(
            s.save_body(
                "ghost",
                "x",
                None,
                0,
                QuestAttributes::default(),
                serde_json::json!({}),
                0
            )
            .is_err()
        );
    }

    #[test]
    fn set_status_and_delete() {
        let mut s = InMemoryConstructorStore::new();
        s.create(quest("q1", "Name", 1)).expect("create");
        let r = s.set_status("q1", CTOR_STATUS_PUBLISHED, 9).expect("known");
        assert_eq!(r.status, CTOR_STATUS_PUBLISHED);
        assert_eq!(s.get("q1").expect("present").status, CTOR_STATUS_PUBLISHED);
        // Unknown quest: None (publish calls this best-effort).
        assert!(s.set_status("ghost", CTOR_STATUS_PUBLISHED, 9).is_none());

        assert!(s.delete("q1"));
        assert!(!s.delete("q1"), "second delete is a no-op");
        assert!(s.get("q1").is_none());
    }

    #[test]
    fn status_validation() {
        assert!(validate_ctor_status("draft").is_ok());
        assert!(validate_ctor_status("test").is_ok());
        assert!(validate_ctor_status("published").is_ok());
        assert!(validate_ctor_status("live").is_err());
        assert!(validate_ctor_status("").is_err());
    }

    #[test]
    fn attributes_closed_sets_are_enforced() {
        assert!(QuestAttributes::from_wire(Some("high".into()), Some("kids".into()), None).is_ok());
        assert!(QuestAttributes::from_wire(Some("extreme".into()), None, None).is_err());
        assert!(QuestAttributes::from_wire(Some("".into()), None, None).is_err());
        assert!(QuestAttributes::from_wire(None, Some("adults".into()), None).is_err());
        assert!(QuestAttributes::from_wire(None, Some("".into()), None).is_err());
    }

    #[test]
    fn attributes_default_when_absent() {
        let a = QuestAttributes::from_wire(None, None, None).expect("defaults");
        assert_eq!(a, QuestAttributes::default());
        assert_eq!(a.complexity, "medium");
        assert_eq!(a.age_target, "everyone");
        assert!(a.tags.is_empty());
    }

    #[test]
    fn attributes_tags_are_normalized_and_capped() {
        // Trimmed, blanks dropped, order-preserving dedupe.
        let a = QuestAttributes::from_wire(
            None,
            None,
            Some(vec![
                "  хоррор ".into(),
                "".into(),
                "   ".into(),
                "юмор".into(),
                "хоррор".into(),
            ]),
        )
        .expect("tags normalize");
        assert_eq!(a.tags, vec!["хоррор".to_string(), "юмор".to_string()]);

        // Caps: too many tags / an over-long tag are 400s, not silent truncation.
        let many: Vec<String> = (0..=MAX_TAGS).map(|i| format!("t{i}")).collect();
        assert!(QuestAttributes::from_wire(None, None, Some(many)).is_err());
        assert!(
            QuestAttributes::from_wire(None, None, Some(vec!["я".repeat(MAX_TAG_LEN + 1)]))
                .is_err(),
            "length is measured in chars, not bytes"
        );
        assert!(
            QuestAttributes::from_wire(None, None, Some(vec!["я".repeat(MAX_TAG_LEN)])).is_ok()
        );
    }

    #[test]
    fn completions_count_distinct_finishers_per_quest() {
        // Completions flow through the real append path (a CompletionBonus fact),
        // not any seed helper — the dashboard metric is a pure projection of facts.
        fn complete(s: &mut InMemoryFactStore, player: &str, quest: &str) {
            let m = s.create_attempt(player, quest, "snap");
            s.append_idempotent(
                &m.attempt_id,
                vec![Fact {
                    kind: FactKind::CompletionBonus,
                    step_position: 0,
                    submitted_value: None,
                    local_is_correct: true,
                    coins_delta: 5,
                    note: None,
                    device_id: format!("{player}-dev"),
                }],
            );
        }

        let mut s = InMemoryFactStore::new();
        // Two distinct players complete quest-a; one of them replays on a fresh
        // attempt (bonus is once-ever, so still one distinct finisher).
        complete(&mut s, "p1", "quest-a");
        complete(&mut s, "p2", "quest-a");
        complete(&mut s, "p1", "quest-a");
        // One player completes quest-b.
        complete(&mut s, "p3", "quest-b");
        // An attempt with no completion fact contributes nothing.
        s.create_attempt("p9", "quest-a", "snap");

        let by_quest = s.completions_by_quest();
        assert_eq!(by_quest.get("quest-a").copied(), Some(2));
        assert_eq!(by_quest.get("quest-b").copied(), Some(1));
        assert_eq!(by_quest.get("quest-c").copied(), None);
    }
}

#[cfg(test)]
mod moderation_tests {
    use super::*;

    fn hkey(p: &str, q: &str) -> (String, String) {
        (p.to_string(), q.to_string())
    }

    #[test]
    fn hide_is_idempotent_and_unhide_removes() {
        let mut m = InMemoryModerationStore::new();
        m.hide_review("p1", "q1", 100, "admin");
        m.hide_review("p1", "q1", 200, "admin2"); // idempotent: the first hide is kept
        let keys = m.hidden_review_keys();
        assert!(keys.contains(&hkey("p1", "q1")));
        assert_eq!(keys.len(), 1);
        m.unhide_review("p1", "q1");
        assert!(m.hidden_review_keys().is_empty());
        m.unhide_review("p1", "q1"); // idempotent no-op
    }

    #[test]
    fn hide_keys_are_per_player_and_quest() {
        let mut m = InMemoryModerationStore::new();
        m.hide_review("p1", "q1", 1, "a");
        m.hide_review("p1", "q2", 1, "a");
        m.hide_review("p2", "q1", 1, "a");
        let keys = m.hidden_review_keys();
        assert_eq!(keys.len(), 3);
        assert!(!keys.contains(&hkey("p2", "q2")));
    }

    #[test]
    fn resolve_upserts_and_reopen_deletes() {
        let mut m = InMemoryModerationStore::new();
        let key = ("q1".to_string(), "snap1".to_string(), 4);
        m.resolve_feedback("q1", "snap1", 4, 500, "admin");
        assert_eq!(m.feedback_resolutions().get(&key).copied(), Some(500));
        // Re-resolving advances the watermark (upsert, not first-write-wins).
        m.resolve_feedback("q1", "snap1", 4, 900, "admin");
        assert_eq!(m.feedback_resolutions().get(&key).copied(), Some(900));
        m.reopen_feedback("q1", "snap1", 4);
        assert!(m.feedback_resolutions().is_empty());
        m.reopen_feedback("q1", "snap1", 4); // idempotent no-op
    }

    #[test]
    fn resolutions_are_keyed_by_quest_snapshot_and_step() {
        let mut m = InMemoryModerationStore::new();
        m.resolve_feedback("q1", "snap1", 4, 1, "a");
        m.resolve_feedback("q1", "snap1", 5, 1, "a"); // different step
        m.resolve_feedback("q1", "snap2", 4, 1, "a"); // different snapshot
        assert_eq!(m.feedback_resolutions().len(), 3);
    }
}

#[cfg(test)]
mod rating_row_tests {
    use super::*;

    fn rated_fact(stars: &str, text: Option<&str>) -> Fact {
        Fact {
            kind: FactKind::QuestRated,
            step_position: 0,
            submitted_value: Some(stars.into()),
            local_is_correct: true,
            coins_delta: 0,
            note: text.map(str::to_string),
            device_id: "d".into(),
        }
    }

    #[test]
    fn quest_rating_rows_one_per_player_latest_across_versions() {
        let mut s = InMemoryFactStore::new();
        // p1 rated 3 on a v1 attempt, then replayed and rated 5 on v2 — 5 wins
        // (later attempt), and the two attempts collapse to ONE effective rating.
        let a1 = s.create_attempt("p1", "q1", "snap-v1");
        s.append_idempotent(&a1.attempt_id, vec![rated_fact("3", Some("old"))]);
        let a2 = s.create_attempt("p1", "q1", "snap-v2");
        s.append_idempotent(&a2.attempt_id, vec![rated_fact("5", Some("new"))]);
        // p2 left a star-only rating on q1.
        let b = s.create_attempt("p2", "q1", "snap-v2");
        s.append_idempotent(&b.attempt_id, vec![rated_fact("1", None)]);
        // p3 rated a DIFFERENT quest — must not appear when scoping to q1.
        let c = s.create_attempt("p3", "q2", "snap-x");
        s.append_idempotent(&c.attempt_id, vec![rated_fact("4", Some("q2"))]);

        let mut rows = s.quest_rating_rows(Some(&["q1".to_string()]));
        rows.sort_by(|x, y| x.player_id.cmp(&y.player_id));
        assert_eq!(rows.len(), 2, "one row per player for q1");
        assert_eq!(rows[0].player_id, "p1");
        assert_eq!(rows[0].rating, 5, "latest attempt's rating");
        assert_eq!(rows[0].text.as_deref(), Some("new"));
        assert_eq!(rows[1].player_id, "p2");
        assert_eq!(rows[1].rating, 1);
        assert_eq!(rows[1].text, None, "star-only carries no text");

        // `None` scans every quest.
        assert_eq!(s.quest_rating_rows(None).len(), 3);
        // Scoping to an unrated quest yields nothing.
        assert!(s.quest_rating_rows(Some(&["nope".to_string()])).is_empty());
    }

    #[test]
    fn quest_rating_rows_folds_hide_aware_average() {
        let mut s = InMemoryFactStore::new();
        let a = s.create_attempt("p1", "q1", "snap");
        s.append_idempotent(&a.attempt_id, vec![rated_fact("5", Some("great"))]);
        let b = s.create_attempt("p2", "q1", "snap");
        s.append_idempotent(&b.attempt_id, vec![rated_fact("1", Some("spam"))]);

        let rows = s.quest_rating_rows(Some(&["q1".to_string()]));
        assert_eq!(
            crate::facts::fold_rating_rows(&rows, &std::collections::HashSet::new()),
            (3.0, 2)
        );
        let hidden: std::collections::HashSet<(String, String)> =
            [("p2".to_string(), "q1".to_string())].into_iter().collect();
        assert_eq!(
            crate::facts::fold_rating_rows(&rows, &hidden),
            (5.0, 1),
            "hidden 1★ dropped"
        );
    }
}

#[cfg(test)]
mod feedback_report_tests {
    use super::*;

    fn fb(step: i32, note: &str) -> Fact {
        Fact {
            kind: FactKind::FeedbackReported,
            step_position: step,
            submitted_value: None,
            local_is_correct: true,
            coins_delta: 0,
            note: Some(note.into()),
            device_id: "d".into(),
        }
    }

    #[test]
    fn all_feedback_reports_gathers_context_and_excludes_non_feedback() {
        let mut s = InMemoryFactStore::new();
        let a = s.create_attempt("p1", "q1", "snap-v1");
        s.append_idempotent(&a.attempt_id, vec![fb(4, "stuck at fountain")]);
        let b = s.create_attempt("p2", "q1", "snap-v1");
        s.append_idempotent(&b.attempt_id, vec![fb(4, "same bug")]);
        // A non-feedback fact on another quest must not surface as feedback.
        let c = s.create_attempt("p3", "q2", "snap-x");
        s.append_idempotent(
            &c.attempt_id,
            vec![Fact {
                kind: FactKind::PhysicalConfirmed,
                step_position: 0,
                submitted_value: None,
                local_is_correct: true,
                coins_delta: 0,
                note: None,
                device_id: "d".into(),
            }],
        );

        let mut reports = s.all_feedback_reports();
        assert_eq!(
            reports.len(),
            2,
            "only feedback_reported facts, across attempts"
        );
        reports.sort_by(|x, y| x.player_id.cmp(&y.player_id));
        assert_eq!(reports[0].quest_id, "q1");
        assert_eq!(reports[0].snapshot_id, "snap-v1");
        assert_eq!(reports[0].step_position, 4);
        assert_eq!(reports[0].player_id, "p1");
        assert_eq!(reports[0].note, "stuck at fountain");
        assert!(reports[0].recorded_at > 0, "server recorded_at populated");
    }
}
