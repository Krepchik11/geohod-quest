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
use crate::errors::AppError;
use crate::facts::{
    Fact, FactKind, MigrationResult, PerVersionStats, ProjectedState, project_state,
    semantically_same,
};
use crate::grants::{AccessGrant, GrantSource, create_grant_idemp};
use crate::pg_store::{PgAuthStore, PgConstructorStore, PgFactStore, PgGrantStore};

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

/// Format Unix seconds as a UTC RFC3339 timestamp. Pure and total.
///
/// Uses Howard Hinnant's civil-from-days algorithm (epoch shifted to 0000-03-01
/// so leap days fall at the end of the era), which is exact for every day in the
/// proleptic Gregorian calendar.
fn rfc3339_from_unix(secs: u64) -> String {
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

/// In-memory append-only fact store + attempt registry.
#[derive(Clone, Debug, Default)]
pub struct InMemoryFactStore {
    fact_logs: HashMap<String, Vec<Fact>>,
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
            accepted.push(f);
        }
        Some(accepted)
    }

    /// §11 reviews v1 — the last quest_rated fact WITH text per attempt of the
    /// quest, newest attempt first. Timestamped by the attempt (facts carry no
    /// clock); the UI shows the month.
    pub fn reviews_for_quest(&self, quest_id: &str, limit: usize) -> Vec<ReviewRow> {
        let mut attempts: Vec<&AttemptMeta> = self
            .attempts
            .values()
            .filter(|m| m.quest_id == quest_id)
            .collect();
        attempts.sort_by_key(|m| std::cmp::Reverse(m.created_at));
        let mut out = Vec::new();
        for meta in attempts {
            let Some(facts) = self.fact_logs.get(&meta.attempt_id) else {
                continue;
            };
            let Some(f) = facts.iter().rev().find(|f| f.kind == FactKind::QuestRated) else {
                continue;
            };
            let text = f.note.as_deref().map(str::trim).unwrap_or("");
            if text.is_empty() {
                continue;
            }
            let rating = f
                .submitted_value
                .as_deref()
                .and_then(|v| v.trim().parse::<i64>().ok())
                .unwrap_or(0);
            out.push(ReviewRow {
                player_id: meta.player_id.clone(),
                created_at: meta.created_at,
                rating,
                text: text.chars().take(500).collect(),
            });
            if out.len() >= limit {
                break;
            }
        }
        out
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

    /// Batch store rating per snapshot for the catalog — the in-memory mirror of
    /// [`crate::pg_store::PgFactStore::rating_stats_for_snapshots`]. Folds through
    /// the same [`crate::facts::fold_attempt_ratings`] as `get_version_stats`, so
    /// this returns exactly `(rating_avg, rating_count)` for each snapshot.
    pub fn rating_stats_for_snapshots(&self, snaps: &[String]) -> HashMap<String, (f64, usize)> {
        let amap = self.attempt_snapshot_map();
        let wanted: std::collections::HashSet<&str> = snaps.iter().map(String::as_str).collect();
        // snapshot -> the fact logs of its attempts
        let mut by_snap: HashMap<&str, Vec<&Vec<Fact>>> = HashMap::new();
        for (att, snap) in &amap {
            if !wanted.contains(snap.as_str()) {
                continue;
            }
            if let Some(log) = self.fact_logs.get(att) {
                by_snap.entry(snap.as_str()).or_default().push(log);
            }
        }
        // Every requested snapshot gets an entry, even with no attempts yet (0.0, 0).
        snaps
            .iter()
            .map(|snap| {
                let logs = by_snap.remove(snap.as_str()).unwrap_or_default();
                (snap.clone(), crate::facts::fold_attempt_ratings(logs))
            })
            .collect()
    }

    /// Feedback reports for a version (admin visibility), via the pure projector.
    pub fn list_feedbacks_for_version(&self, snap: &str) -> Vec<Fact> {
        crate::facts::list_feedbacks_for_snapshot(
            snap,
            &self.fact_logs,
            &self.attempt_snapshot_map(),
        )
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
            email: email.to_string(),
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
        self.email_index.remove(&record.account.email);
        self.sessions.retain(|_, p| p != player_id);
        self.auth_tokens.retain(|_, r| r.player_id != player_id);
        true
    }
}

/// §11: one player review row (text attached to the finale rating).
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewRow {
    pub player_id: String,
    pub created_at: u64,
    pub rating: i64,
    pub text: String,
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

    /// See [`InMemoryFactStore::reviews_for_quest`].
    pub async fn reviews_for_quest(
        &self,
        quest_id: &str,
        limit: usize,
    ) -> Result<Vec<ReviewRow>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.reviews_for_quest(quest_id, limit)),
            Self::Postgres(pg) => pg.reviews_for_quest(quest_id, limit).await,
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

    /// See [`InMemoryFactStore::rating_stats_for_snapshots`].
    pub async fn rating_stats_for_snapshots(
        &self,
        snaps: &[String],
    ) -> Result<std::collections::HashMap<String, (f64, usize)>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.rating_stats_for_snapshots(snaps)),
            Self::Postgres(pg) => pg.rating_stats_for_snapshots(snaps).await,
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
    pub fn save_body(
        &mut self,
        quest_id: &str,
        name: &str,
        cover: Option<String>,
        steps_count: u32,
        body: serde_json::Value,
        updated_at: u64,
    ) -> Result<ConstructorQuestSummary, AppError> {
        let q = self.quests.get_mut(quest_id).ok_or_else(|| {
            AppError::NotFound(format!("constructor quest '{quest_id}' not found"))
        })?;
        q.name = name.to_string();
        q.cover = cover;
        q.steps_count = steps_count;
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

    /// `quest_id` → lifecycle status for every constructor quest. The store catalog
    /// consults this so marketplace visibility is a function of the AUTHORITATIVE
    /// status (a single source of truth), not the mere presence of a frozen
    /// snapshot — a quest the author moved to `test`/`draft` keeps its snapshot
    /// (still resolvable by direct link, grant-gated) but leaves the store.
    pub fn statuses_by_quest(&self) -> HashMap<String, String> {
        self.quests
            .iter()
            .map(|(id, q)| (id.clone(), q.status.clone()))
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
    pub async fn save_body(
        &self,
        quest_id: &str,
        name: &str,
        cover: Option<String>,
        steps_count: u32,
        body: serde_json::Value,
        updated_at: u64,
    ) -> Result<ConstructorQuestSummary, AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.save_body(quest_id, name, cover, steps_count, body, updated_at)
            }
            Self::Postgres(pg) => {
                pg.save_body(quest_id, name, cover, steps_count, body, updated_at)
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

    /// See [`InMemoryConstructorStore::statuses_by_quest`].
    pub async fn statuses_by_quest(&self) -> Result<HashMap<String, String>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.statuses_by_quest()),
            Self::Postgres(pg) => pg.statuses_by_quest().await,
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let updated = s
            .save_body(
                "q1",
                "Renamed",
                Some("cover.png".into()),
                7,
                serde_json::json!({ "id": "q1", "steps": [1, 2] }),
                42,
            )
            .expect("save");
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.steps_count, 7);
        assert_eq!(updated.updated_at, 42);
        let full = s.get("q1").expect("present");
        // The cover lives on the full entity, not the (slimmed) list summary.
        assert_eq!(full.cover.as_deref(), Some("cover.png"));
        assert_eq!(full.body["steps"].as_array().expect("steps").len(), 2);

        assert!(
            s.save_body("ghost", "x", None, 0, serde_json::json!({}), 0)
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
