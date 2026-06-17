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

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::auth::{PlayerAccount, PlayerRecord};
use crate::errors::AppError;
use crate::facts::{
    Fact, FactKind, MigrationResult, PerVersionStats, ProjectedState, project_state,
    semantically_same,
};
use crate::grants::{AccessGrant, GrantSource, create_grant_idemp};
use crate::pg_store::{PgAuthStore, PgFactStore, PgGrantStore};

/// Unix seconds (0 on clock error; informational only).
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
}

/// Published quest metadata surfaced by the constructor's publish for the
/// marketplace list and for binding new attempts to the latest snapshot.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PublishedMeta {
    pub quest_id: String,
    pub name: String,
    pub primary_comic: Option<String>,
    pub template_summary: String,
    pub snapshot_version: u32,
    /// Frozen snapshot identifier new attempts bind to (e.g. "golden-mystery-fortress-v1").
    pub snapshot_id: String,
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
        let (grant, created) =
            create_grant_idemp(existing.as_ref(), player, quest, source, source_ref);
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

/// In-memory identity store: registrations (players) + opaque sessions.
/// A record exists ONLY for registered players — anonymous ids have no row by
/// design (registration is metadata on an existing id, never a migration).
#[derive(Clone, Debug, Default)]
pub struct InMemoryAuthStore {
    players: HashMap<String, PlayerRecord>,
    email_index: HashMap<String, String>,
    sessions: HashMap<String, String>,
}

impl InMemoryAuthStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `player_id` with credentials. Rejects (409) a taken email or an
    /// already-registered player atomically (no partial state on failure).
    pub fn register_player(
        &mut self,
        player_id: &str,
        email: &str,
        password_hash: &str,
        display_name: Option<String>,
    ) -> Result<PlayerAccount, AppError> {
        if self.players.contains_key(player_id) {
            return Err(AppError::Conflict("player is already registered".into()));
        }
        if self.email_index.contains_key(email) {
            return Err(AppError::Conflict("email is already taken".into()));
        }
        let account = PlayerAccount {
            player_id: player_id.to_string(),
            email: email.to_string(),
            display_name,
            role: crate::auth::DEFAULT_ROLE.to_string(),
            created_at: now_secs(),
        };
        self.players.insert(
            player_id.to_string(),
            PlayerRecord {
                account: account.clone(),
                password_hash: password_hash.to_string(),
            },
        );
        self.email_index
            .insert(email.to_string(), player_id.to_string());
        Ok(account)
    }

    /// Full record (account + hash) by email — the login lookup.
    pub fn find_by_email(&self, email: &str) -> Option<PlayerRecord> {
        let player_id = self.email_index.get(email)?;
        self.players.get(player_id).cloned()
    }

    /// Public account by player id; `None` for anonymous (unregistered) ids.
    pub fn get_player(&self, player_id: &str) -> Option<PlayerAccount> {
        self.players.get(player_id).map(|r| r.account.clone())
    }

    /// Assign `role` to a registered account (admin-users spec). Returns 404 for
    /// an unknown/anonymous id — only registered accounts have a role. The caller
    /// validates `role` against the known set before reaching here.
    pub fn set_role(&mut self, player_id: &str, role: &str) -> Result<PlayerAccount, AppError> {
        let record = self
            .players
            .get_mut(player_id)
            .ok_or_else(|| AppError::NotFound(format!("no account for player '{player_id}'")))?;
        record.account.role = role.to_string();
        Ok(record.account.clone())
    }

    /// All registered accounts, newest registration first (admin user list).
    /// Anonymous devices have no row, so only real accounts are returned. Two stable
    /// passes give the total order (created_at desc, then player_id asc) without a
    /// hand-formatted comparator chain.
    pub fn list_players(&self) -> Vec<PlayerAccount> {
        let mut accounts: Vec<PlayerAccount> =
            self.players.values().map(|r| r.account.clone()).collect();
        accounts.sort_by(|a, b| a.player_id.cmp(&b.player_id));
        accounts.sort_by(|a, b| b.created_at.cmp(&a.created_at));
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

    /// See [`InMemoryAuthStore::register_player`].
    pub async fn register_player(
        &self,
        player_id: &str,
        email: &str,
        password_hash: &str,
        display_name: Option<String>,
    ) -> Result<PlayerAccount, AppError> {
        match self {
            Self::InMemory(m) => {
                Self::lock_inmem(m)?.register_player(player_id, email, password_hash, display_name)
            }
            Self::Postgres(pg) => {
                pg.register_player(player_id, email, password_hash, display_name)
                    .await
            }
        }
    }

    /// See [`InMemoryAuthStore::find_by_email`].
    pub async fn find_by_email(&self, email: &str) -> Result<Option<PlayerRecord>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.find_by_email(email)),
            Self::Postgres(pg) => pg.find_by_email(email).await,
        }
    }

    /// See [`InMemoryAuthStore::get_player`].
    pub async fn get_player(&self, player_id: &str) -> Result<Option<PlayerAccount>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_player(player_id)),
            Self::Postgres(pg) => pg.get_player(player_id).await,
        }
    }

    /// See [`InMemoryAuthStore::set_role`].
    pub async fn set_role(&self, player_id: &str, role: &str) -> Result<PlayerAccount, AppError> {
        match self {
            Self::InMemory(m) => Self::lock_inmem(m)?.set_role(player_id, role),
            Self::Postgres(pg) => pg.set_role(player_id, role).await,
        }
    }

    /// See [`InMemoryAuthStore::list_players`].
    pub async fn list_players(&self) -> Result<Vec<PlayerAccount>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.list_players()),
            Self::Postgres(pg) => pg.list_players().await,
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

    /// See [`InMemoryAuthStore::get_session`].
    pub async fn get_session(&self, token: &str) -> Result<Option<String>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get_session(token)),
            Self::Postgres(pg) => pg.get_session(token).await,
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
