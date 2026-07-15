//! PostgreSQL store implementations (sqlx).
//!
//! Behavior mirrors the in-memory stores exactly — the in-memory implementation is
//! the executable specification. Idempotency invariants live as constraints here:
//! `facts UNIQUE(attempt_id, natural_key)` absorbs duplicate appends (including
//! concurrent ones), and `bonus_awards PRIMARY KEY(player_id, quest_id)` makes the
//! completion bonus once-per-player+quest atomic. Projections are NEVER done in
//! SQL: facts are loaded and folded by the pure projectors, keeping client parity.
//!
//! Queries are runtime-checked (no `query!` macros) so the crate builds without a
//! live database; the Postgres test suite covers every query path. Revisit with
//! `cargo sqlx prepare` once the schema stabilizes.

use sqlx::{PgPool, Row};

use crate::auth::{UserAccount, UserRecord};
use crate::coupons::{Coupon, CouponRedemption, CouponUsage, Discount};
use crate::errors::AppError;
use crate::facts::{
    Fact, FactKind, MigrationResult, PerVersionStats, ProjectedState, list_feedbacks_for_snapshot,
    natural_key, project_state, project_version_stats, synthesize_legacy_snapshot_and_facts,
};
use crate::grants::{AccessGrant, GrantSource};
use crate::store::{
    AttemptMeta, AuthIdentity, ConstructorQuest, ConstructorQuestSummary, PublishedMeta,
    now_rfc3339, now_secs,
};

fn internal(e: impl Into<anyhow::Error>) -> AppError {
    AppError::Internal(e.into())
}

/// Canonical string form of the device-agnostic natural key (stored column backing
/// the UNIQUE constraint; one NOT NULL column because nullable multi-column UNIQUEs
/// don't dedup in Postgres).
fn natural_key_string(f: &Fact) -> Result<String, AppError> {
    serde_json::to_string(&natural_key(f)).map_err(internal)
}

/// Facts + attempts on PostgreSQL.
#[derive(Clone, Debug)]
pub struct PgFactStore {
    pool: PgPool,
}

impl PgFactStore {
    /// See [`crate::store::InMemoryFactStore::reviews_for_quest`] — DISTINCT ON
    /// keeps the last quest_rated per attempt; only rows with text qualify.
    pub async fn reviews_for_quest(
        &self,
        quest_id: &str,
        limit: usize,
    ) -> Result<Vec<crate::store::ReviewRow>, AppError> {
        let rows = sqlx::query(
            "SELECT last_rated.player_id, last_rated.created_at, last_rated.data
             FROM (
                 SELECT DISTINCT ON (f.attempt_id)
                        a.player_id, a.created_at, f.data
                 FROM facts f
                 JOIN attempts a ON a.attempt_id = f.attempt_id
                 WHERE a.quest_id = $1 AND f.data->>'type' = 'quest_rated'
                 ORDER BY f.attempt_id, f.seq DESC
             ) AS last_rated
             WHERE COALESCE(TRIM(last_rated.data->>'note'), '') <> ''
             ORDER BY last_rated.created_at DESC
             LIMIT $2",
        )
        .bind(quest_id)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        use sqlx::Row;
        rows.iter()
            .map(|r| {
                let data: serde_json::Value = r.try_get("data").map_err(internal)?;
                let created_at: i64 = r.try_get("created_at").map_err(internal)?;
                Ok(crate::store::ReviewRow {
                    player_id: r.try_get("player_id").map_err(internal)?,
                    created_at: created_at as u64,
                    rating: data
                        .get("submitted_value")
                        .and_then(|v| v.as_str())
                        .and_then(|v| v.trim().parse::<i64>().ok())
                        .unwrap_or(0),
                    text: data
                        .get("note")
                        .and_then(|v| v.as_str())
                        .map(|t| t.trim().chars().take(500).collect())
                        .unwrap_or_default(),
                })
            })
            .collect()
    }

    /// See [`crate::store::InMemoryFactStore::delete_player_data`] — the
    /// player's attempts + their facts + bonus marks, one transaction.
    pub async fn delete_player_data(&self, player_id: &str) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query(
            "DELETE FROM facts WHERE attempt_id IN (SELECT attempt_id FROM attempts WHERE player_id = $1)",
        )
        .bind(player_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query("DELETE FROM bonus_awards WHERE player_id = $1")
            .bind(player_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query("DELETE FROM attempts WHERE player_id = $1")
            .bind(player_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        Ok(())
    }

    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// See [`crate::store::InMemoryFactStore::create_attempt`].
    pub async fn create_attempt(
        &self,
        player_id: &str,
        quest_id: &str,
        snapshot_id: &str,
    ) -> Result<AttemptMeta, AppError> {
        let created_at = now_secs();
        let row = sqlx::query(
            "INSERT INTO attempts (attempt_id, player_id, quest_id, snapshot_id, created_at)
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
             RETURNING attempt_id",
        )
        .bind(player_id)
        .bind(quest_id)
        .bind(snapshot_id)
        .bind(created_at as i64)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        Ok(AttemptMeta {
            attempt_id: row.try_get("attempt_id").map_err(internal)?,
            player_id: player_id.to_string(),
            quest_id: quest_id.to_string(),
            snapshot_id: snapshot_id.to_string(),
            created_at,
        })
    }

    /// Idempotent batch append in ONE transaction. Returns `None` for unknown
    /// attempts. Accepted = rows the database actually inserted (ON CONFLICT
    /// DO NOTHING), so concurrent duplicates are absorbed by the constraints.
    pub async fn append_idempotent(
        &self,
        attempt_id: &str,
        incoming: Vec<Fact>,
    ) -> Result<Option<Vec<Fact>>, AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;

        let Some(meta_row) =
            sqlx::query("SELECT player_id, quest_id FROM attempts WHERE attempt_id = $1")
                .bind(attempt_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?
        else {
            return Ok(None);
        };
        let player_id: String = meta_row.try_get("player_id").map_err(internal)?;
        let quest_id: String = meta_row.try_get("quest_id").map_err(internal)?;

        let mut accepted = Vec::new();
        for f in incoming {
            if f.kind == FactKind::CompletionBonus {
                let res = sqlx::query(
                    "INSERT INTO bonus_awards (player_id, quest_id) VALUES ($1, $2)
                     ON CONFLICT DO NOTHING",
                )
                .bind(&player_id)
                .bind(&quest_id)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
                if res.rows_affected() == 0 {
                    continue; // bonus already awarded for this player+quest, ever
                }
            }
            let key = natural_key_string(&f)?;
            let data = serde_json::to_value(&f).map_err(internal)?;
            let inserted = sqlx::query(
                "INSERT INTO facts (attempt_id, natural_key, data) VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING
                 RETURNING seq",
            )
            .bind(attempt_id)
            .bind(&key)
            .bind(&data)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
            if inserted.is_some() {
                accepted.push(f);
            }
        }

        tx.commit().await.map_err(internal)?;
        Ok(Some(accepted))
    }

    async fn load_facts(&self, attempt_id: &str) -> Result<Vec<Fact>, AppError> {
        let rows = sqlx::query("SELECT data FROM facts WHERE attempt_id = $1 ORDER BY seq")
            .bind(attempt_id)
            .fetch_all(&self.pool)
            .await
            .map_err(internal)?;
        rows.into_iter()
            .map(|r| {
                let data: serde_json::Value = r.try_get("data").map_err(internal)?;
                serde_json::from_value(data).map_err(internal)
            })
            .collect()
    }

    /// See [`crate::store::InMemoryFactStore::get_projected`].
    pub async fn get_projected(
        &self,
        attempt_id: &str,
    ) -> Result<Option<(ProjectedState, String, usize)>, AppError> {
        let Some(row) = sqlx::query("SELECT snapshot_id FROM attempts WHERE attempt_id = $1")
            .bind(attempt_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?
        else {
            return Ok(None);
        };
        let snapshot_id: String = row.try_get("snapshot_id").map_err(internal)?;
        let facts = self.load_facts(attempt_id).await?;
        Ok(Some((project_state(&facts), snapshot_id, facts.len())))
    }

    /// Loads the logs of all attempts bound to `snap` and delegates to the pure
    /// stats projector (no SQL aggregation — parity with the in-memory backend).
    async fn load_snapshot_logs(
        &self,
        snap: &str,
    ) -> Result<
        (
            std::collections::HashMap<String, Vec<Fact>>,
            std::collections::HashMap<String, String>,
        ),
        AppError,
    > {
        // Every attempt bound to the snapshot — INCLUDING zero-fact ones, which
        // still count toward attempts_count in the projector. Seeds the maps so a
        // fact-less attempt keeps an empty log (the JOIN below can't surface it).
        let attempt_rows = sqlx::query("SELECT attempt_id FROM attempts WHERE snapshot_id = $1")
            .bind(snap)
            .fetch_all(&self.pool)
            .await
            .map_err(internal)?;
        let mut fact_logs: std::collections::HashMap<String, Vec<Fact>> =
            std::collections::HashMap::with_capacity(attempt_rows.len());
        let mut attempt_snaps = std::collections::HashMap::with_capacity(attempt_rows.len());
        for row in &attempt_rows {
            let att: String = row.try_get("attempt_id").map_err(internal)?;
            fact_logs.insert(att.clone(), Vec::new());
            attempt_snaps.insert(att, snap.to_string());
        }
        // ONE round-trip for the facts of ALL those attempts (was one query per
        // attempt — the N+1). `ORDER BY seq` is a global order, but a per-attempt
        // subsequence of it is still in append order, so grouping stays correct.
        let fact_rows = sqlx::query(
            "SELECT f.attempt_id, f.data FROM facts f
             JOIN attempts a ON a.attempt_id = f.attempt_id
             WHERE a.snapshot_id = $1
             ORDER BY f.seq",
        )
        .bind(snap)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        for row in fact_rows {
            let att: String = row.try_get("attempt_id").map_err(internal)?;
            let data: serde_json::Value = row.try_get("data").map_err(internal)?;
            let fact: Fact = serde_json::from_value(data).map_err(internal)?;
            if let Some(log) = fact_logs.get_mut(&att) {
                log.push(fact);
            }
        }
        Ok((fact_logs, attempt_snaps))
    }

    /// See [`crate::store::InMemoryFactStore::get_version_stats`].
    pub async fn get_version_stats(
        &self,
        snap: &str,
        grants_count: usize,
    ) -> Result<PerVersionStats, AppError> {
        let (fact_logs, attempt_snaps) = self.load_snapshot_logs(snap).await?;
        Ok(project_version_stats(
            snap,
            &fact_logs,
            &attempt_snaps,
            grants_count,
        ))
    }

    /// See [`crate::store::InMemoryFactStore::list_feedbacks_for_version`].
    pub async fn list_feedbacks_for_version(&self, snap: &str) -> Result<Vec<Fact>, AppError> {
        let (fact_logs, attempt_snaps) = self.load_snapshot_logs(snap).await?;
        Ok(list_feedbacks_for_snapshot(
            snap,
            &fact_logs,
            &attempt_snaps,
        ))
    }

    /// See [`crate::store::InMemoryFactStore::rating_stats_for_snapshots`].
    /// The catalog's batch rating loader: ONE round-trip for the rating facts of
    /// EVERY listed snapshot, replacing the per-quest `get_version_stats` N+1 that
    /// dominated `GET /api/quests`. Folds through the shared `fold_attempt_ratings`
    /// so a card's rating is identical to the version-stats page's.
    pub async fn rating_stats_for_snapshots(
        &self,
        snaps: &[String],
    ) -> Result<std::collections::HashMap<String, (f64, usize)>, AppError> {
        if snaps.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let rows = sqlx::query(
            "SELECT a.snapshot_id, f.attempt_id, f.data FROM facts f
             JOIN attempts a ON a.attempt_id = f.attempt_id
             WHERE a.snapshot_id = ANY($1)
             ORDER BY f.seq",
        )
        .bind(snaps)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        // snapshot_id -> attempt_id -> facts (in seq order)
        let mut by_snap: std::collections::HashMap<
            String,
            std::collections::HashMap<String, Vec<Fact>>,
        > = std::collections::HashMap::new();
        for row in rows {
            let snap: String = row.try_get("snapshot_id").map_err(internal)?;
            let att: String = row.try_get("attempt_id").map_err(internal)?;
            let data: serde_json::Value = row.try_get("data").map_err(internal)?;
            let fact: Fact = serde_json::from_value(data).map_err(internal)?;
            by_snap
                .entry(snap)
                .or_default()
                .entry(att)
                .or_default()
                .push(fact);
        }
        Ok(by_snap
            .into_iter()
            .map(|(snap, logs)| (snap, crate::facts::fold_attempt_ratings(logs.values())))
            .collect())
    }

    /// See [`crate::store::InMemoryFactStore::attempt_logs_for_player`].
    pub async fn attempt_logs_for_player(
        &self,
        player_id: &str,
    ) -> Result<Vec<(String, Vec<Fact>)>, AppError> {
        // Attempts first: preserves their row order, captures each quest_id, and
        // keeps zero-fact attempts (the facts JOIN below can't surface those).
        let rows = sqlx::query("SELECT attempt_id, quest_id FROM attempts WHERE player_id = $1")
            .bind(player_id)
            .fetch_all(&self.pool)
            .await
            .map_err(internal)?;
        let mut order: Vec<(String, String)> = Vec::with_capacity(rows.len());
        for row in &rows {
            order.push((
                row.try_get("attempt_id").map_err(internal)?,
                row.try_get("quest_id").map_err(internal)?,
            ));
        }
        // ONE round-trip for ALL of the player's facts (was one query per attempt).
        let mut logs: std::collections::HashMap<String, Vec<Fact>> = order
            .iter()
            .map(|(att, _)| (att.clone(), Vec::new()))
            .collect();
        let fact_rows = sqlx::query(
            "SELECT f.attempt_id, f.data FROM facts f
             JOIN attempts a ON a.attempt_id = f.attempt_id
             WHERE a.player_id = $1
             ORDER BY f.seq",
        )
        .bind(player_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        for row in fact_rows {
            let att: String = row.try_get("attempt_id").map_err(internal)?;
            let data: serde_json::Value = row.try_get("data").map_err(internal)?;
            if let Some(log) = logs.get_mut(&att) {
                log.push(serde_json::from_value(data).map_err(internal)?);
            }
        }
        Ok(order
            .into_iter()
            .map(|(att, quest)| (quest, logs.remove(&att).unwrap_or_default()))
            .collect())
    }

    /// See [`crate::store::InMemoryFactStore::completions_by_quest`]. Counts
    /// `bonus_awards` rows per quest: each row is one (player, quest) completion
    /// bonus, so `COUNT(*)` is the distinct-finisher count — matching the
    /// in-memory backend, which derives the same from the fact log.
    pub async fn completions_by_quest(
        &self,
    ) -> Result<std::collections::HashMap<String, usize>, AppError> {
        let rows =
            sqlx::query("SELECT quest_id, COUNT(*) AS n FROM bonus_awards GROUP BY quest_id")
                .fetch_all(&self.pool)
                .await
                .map_err(internal)?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let quest_id: String = row.try_get("quest_id").map_err(internal)?;
            let n: i64 = row.try_get("n").map_err(internal)?;
            out.insert(quest_id, n.max(0) as usize);
        }
        Ok(out)
    }

    /// See [`crate::store::InMemoryFactStore::completions_for_quest`]. Single-quest
    /// count via the `bonus_awards(quest_id)` index — the editor's per-quest pages
    /// use this instead of `completions_by_quest`'s whole-table GROUP BY.
    pub async fn completions_for_quest(&self, quest_id: &str) -> Result<usize, AppError> {
        let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM bonus_awards WHERE quest_id = $1")
            .bind(quest_id)
            .fetch_one(&self.pool)
            .await
            .map_err(internal)?
            .try_get("n")
            .map_err(internal)?;
        Ok(n.max(0) as usize)
    }

    /// See [`crate::store::InMemoryFactStore::run_legacy_migration`].
    pub async fn run_legacy_migration(
        &self,
        historical_grants: Vec<serde_json::Value>,
        answer_cards: Vec<serde_json::Value>,
        key: &str,
    ) -> Result<MigrationResult, AppError> {
        let marked =
            sqlx::query("INSERT INTO migration_marks (key) VALUES ($1) ON CONFLICT DO NOTHING")
                .bind(key)
                .execute(&self.pool)
                .await
                .map_err(internal)?;
        if marked.rows_affected() == 0 {
            return Ok(MigrationResult {
                synth_snapshot: serde_json::json!({"note": "idemp no-op (already marked)"}),
                synth_facts: vec![],
                audit_report: "idemp re-run: no change".to_string(),
                marked: true,
            });
        }
        Ok(synthesize_legacy_snapshot_and_facts(
            historical_grants,
            answer_cards,
        ))
    }
}

/// Grants + published quests + frozen snapshots on PostgreSQL.
#[derive(Clone, Debug)]
pub struct PgGrantStore {
    pool: PgPool,
}

fn source_to_str(s: &GrantSource) -> &'static str {
    match s {
        GrantSource::Payment => "Payment",
        GrantSource::CouponRedemption => "CouponRedemption",
        GrantSource::FreeQuest => "FreeQuest",
        GrantSource::Admin => "Admin",
    }
}

fn source_from_str(s: &str) -> Result<GrantSource, AppError> {
    match s {
        "Payment" => Ok(GrantSource::Payment),
        "CouponRedemption" => Ok(GrantSource::CouponRedemption),
        "FreeQuest" => Ok(GrantSource::FreeQuest),
        "Admin" => Ok(GrantSource::Admin),
        other => Err(AppError::Internal(anyhow::anyhow!(
            "unknown grant source in db: {other}"
        ))),
    }
}

fn grant_from_row(row: &sqlx::postgres::PgRow) -> Result<AccessGrant, AppError> {
    let source: String = row.try_get("source").map_err(internal)?;
    Ok(AccessGrant {
        player_id: row.try_get("player_id").map_err(internal)?,
        quest_id: row.try_get("quest_id").map_err(internal)?,
        granted_at: row.try_get("granted_at").map_err(internal)?,
        source: source_from_str(&source)?,
        source_ref: row.try_get("source_ref").map_err(internal)?,
    })
}

fn published_from_row(row: &sqlx::postgres::PgRow) -> Result<PublishedMeta, AppError> {
    let version: i32 = row.try_get("snapshot_version").map_err(internal)?;
    Ok(PublishedMeta {
        quest_id: row.try_get("quest_id").map_err(internal)?,
        name: row.try_get("name").map_err(internal)?,
        primary_comic: row.try_get("primary_comic").map_err(internal)?,
        template_summary: row.try_get("template_summary").map_err(internal)?,
        snapshot_version: version as u32,
        snapshot_id: row.try_get("snapshot_id").map_err(internal)?,
        city: row.try_get("city").map_err(internal)?,
        duration: row.try_get("duration").map_err(internal)?,
        price: row.try_get("price").map_err(internal)?,
        description: row.try_get("description").map_err(internal)?,
        pages: row
            .try_get::<Option<i32>, _>("pages")
            .map_err(internal)?
            .map(|v| v as u32),
        tasks: row
            .try_get::<Option<i32>, _>("tasks")
            .map_err(internal)?
            .map(|v| v as u32),
        paid_hints: row.try_get("paid_hints").map_err(internal)?,
        players_bonus: row.try_get("players_bonus").map_err(internal)?,
    })
}

/// Published-quest columns selected wherever a [`PublishedMeta`] is read (kept in
/// one place so list/get/bundle stay in sync with [`published_from_row`]).
const PUBLISHED_COLS: &str = "quest_id, name, primary_comic, template_summary, snapshot_version, snapshot_id, city, duration, price, description, pages, tasks, paid_hints, players_bonus";

impl PgGrantStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// See [`crate::store::InMemoryGrantStore::create_grant_idemp`].
    pub async fn create_grant_idemp(
        &self,
        player: &str,
        quest: &str,
        source: GrantSource,
        source_ref: Option<String>,
    ) -> Result<(AccessGrant, bool), AppError> {
        let granted_at = now_rfc3339(); // real audit instant, mirroring the pure helper
        let inserted = sqlx::query(
            "INSERT INTO access_grants (player_id, quest_id, granted_at, source, source_ref)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING
             RETURNING player_id, quest_id, granted_at, source, source_ref",
        )
        .bind(player)
        .bind(quest)
        .bind(granted_at)
        .bind(source_to_str(&source))
        .bind(&source_ref)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        if let Some(row) = inserted {
            return Ok((grant_from_row(&row)?, true));
        }
        let existing = sqlx::query(
            "SELECT player_id, quest_id, granted_at, source, source_ref
             FROM access_grants WHERE player_id = $1 AND quest_id = $2",
        )
        .bind(player)
        .bind(quest)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        Ok((grant_from_row(&existing)?, false))
    }

    /// See [`crate::store::InMemoryGrantStore::has_grant`].
    pub async fn has_grant(&self, player: &str, quest: &str) -> Result<bool, AppError> {
        let row =
            sqlx::query("SELECT 1 AS x FROM access_grants WHERE player_id = $1 AND quest_id = $2")
                .bind(player)
                .bind(quest)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal)?;
        Ok(row.is_some())
    }

    /// See [`crate::store::InMemoryGrantStore::list_published`].
    pub async fn list_published(&self) -> Result<Vec<PublishedMeta>, AppError> {
        let rows = sqlx::query(&format!(
            "SELECT {PUBLISHED_COLS} FROM published_quests ORDER BY quest_id"
        ))
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter().map(published_from_row).collect()
    }

    /// See [`crate::store::InMemoryGrantStore::get_published`].
    pub async fn get_published(&self, quest_id: &str) -> Result<Option<PublishedMeta>, AppError> {
        let row = sqlx::query(&format!(
            "SELECT {PUBLISHED_COLS} FROM published_quests WHERE quest_id = $1"
        ))
        .bind(quest_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.as_ref().map(published_from_row).transpose()
    }

    /// Registers/updates published metadata and stores the frozen snapshot JSON.
    /// Snapshot rows are immutable: same id + identical content is an idempotent
    /// no-op; same id + different content is rejected; NULL data may be filled once.
    pub async fn register_published(
        &self,
        quest_id: &str,
        meta: PublishedMeta,
        snapshot: Option<serde_json::Value>,
    ) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;

        let existing = sqlx::query("SELECT data FROM snapshots WHERE snapshot_id = $1")
            .bind(&meta.snapshot_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
        match existing {
            None => {
                sqlx::query(
                    "INSERT INTO snapshots (snapshot_id, quest_id, version, data, published_at)
                     VALUES ($1, $2, $3, $4, $5)",
                )
                .bind(&meta.snapshot_id)
                .bind(quest_id)
                .bind(meta.snapshot_version as i32)
                .bind(&snapshot)
                .bind(now_secs() as i64)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            }
            Some(row) => {
                let stored: Option<serde_json::Value> = row.try_get("data").map_err(internal)?;
                match (stored, &snapshot) {
                    (Some(old), Some(new)) if &old != new => {
                        return Err(AppError::BadRequest(format!(
                            "snapshot '{}' is frozen; publish a new version instead",
                            meta.snapshot_id
                        )));
                    }
                    (None, Some(_)) => {
                        sqlx::query("UPDATE snapshots SET data = $2 WHERE snapshot_id = $1")
                            .bind(&meta.snapshot_id)
                            .bind(&snapshot)
                            .execute(&mut *tx)
                            .await
                            .map_err(internal)?;
                    }
                    _ => {} // identical content or no new content: idempotent no-op
                }
            }
        }

        sqlx::query(
            "INSERT INTO published_quests
                 (quest_id, name, primary_comic, template_summary, snapshot_version,
                  snapshot_id, city, duration, price, description, pages, tasks, paid_hints,
                  players_bonus)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (quest_id) DO UPDATE SET
                 name = EXCLUDED.name,
                 primary_comic = EXCLUDED.primary_comic,
                 template_summary = EXCLUDED.template_summary,
                 snapshot_version = EXCLUDED.snapshot_version,
                 snapshot_id = EXCLUDED.snapshot_id,
                 city = EXCLUDED.city,
                 duration = EXCLUDED.duration,
                 price = EXCLUDED.price,
                 description = EXCLUDED.description,
                 pages = EXCLUDED.pages,
                 tasks = EXCLUDED.tasks,
                 paid_hints = EXCLUDED.paid_hints,
                 players_bonus = EXCLUDED.players_bonus",
        )
        .bind(quest_id)
        .bind(&meta.name)
        .bind(&meta.primary_comic)
        .bind(&meta.template_summary)
        .bind(meta.snapshot_version as i32)
        .bind(&meta.snapshot_id)
        .bind(&meta.city)
        .bind(&meta.duration)
        .bind(meta.price)
        .bind(&meta.description)
        .bind(meta.pages.map(|v| v as i32))
        .bind(meta.tasks.map(|v| v as i32))
        .bind(meta.paid_hints)
        .bind(meta.players_bonus)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;

        tx.commit().await.map_err(internal)
    }

    /// See [`crate::store::InMemoryGrantStore::list_all_grants`].
    pub async fn list_all_grants(&self) -> Result<Vec<AccessGrant>, AppError> {
        let rows = sqlx::query(
            "SELECT player_id, quest_id, granted_at, source, source_ref FROM access_grants",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter().map(grant_from_row).collect()
    }

    /// See [`crate::store::InMemoryGrantStore::delete_grants_for_player`].
    pub async fn delete_grants_for_player(&self, player_id: &str) -> Result<usize, AppError> {
        let res = sqlx::query("DELETE FROM access_grants WHERE player_id = $1")
            .bind(player_id)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(res.rows_affected() as usize)
    }

    /// See [`crate::store::InMemoryGrantStore::buyers_by_quest`].
    pub async fn buyers_by_quest(
        &self,
    ) -> Result<std::collections::HashMap<String, usize>, AppError> {
        let rows = sqlx::query(
            "SELECT quest_id, COUNT(DISTINCT player_id) AS n FROM access_grants GROUP BY quest_id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        use sqlx::Row;
        Ok(rows
            .iter()
            .map(|r| {
                (
                    r.get::<String, _>("quest_id"),
                    r.get::<i64, _>("n") as usize,
                )
            })
            .collect())
    }

    /// See [`crate::store::InMemoryGrantStore::buyers_for_quest`]. Single-quest
    /// buyer count via the `access_grants(quest_id)` index — replaces the editor
    /// endpoints' whole-table `buyers_by_quest` GROUP BY.
    pub async fn buyers_for_quest(&self, quest_id: &str) -> Result<usize, AppError> {
        let n: i64 = sqlx::query(
            "SELECT COUNT(DISTINCT player_id) AS n FROM access_grants WHERE quest_id = $1",
        )
        .bind(quest_id)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?
        .try_get("n")
        .map_err(internal)?;
        Ok(n.max(0) as usize)
    }

    /// See [`crate::store::InMemoryGrantStore::grants_for_player`].
    pub async fn grants_for_player(&self, player_id: &str) -> Result<Vec<AccessGrant>, AppError> {
        let rows = sqlx::query(
            "SELECT player_id, quest_id, granted_at, source, source_ref
             FROM access_grants WHERE player_id = $1",
        )
        .bind(player_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter().map(grant_from_row).collect()
    }

    /// Latest published meta + frozen snapshot JSON for the bundle endpoint.
    pub async fn get_bundle(
        &self,
        quest_id: &str,
    ) -> Result<Option<(PublishedMeta, Option<serde_json::Value>)>, AppError> {
        // Qualify every published column with the join alias so the column list
        // stays in lockstep with PUBLISHED_COLS/published_from_row.
        let cols = PUBLISHED_COLS
            .split(", ")
            .map(|c| format!("p.{c}"))
            .collect::<Vec<_>>()
            .join(", ");
        let row = sqlx::query(&format!(
            "SELECT {cols}, s.data
             FROM published_quests p
             JOIN snapshots s ON s.snapshot_id = p.snapshot_id
             WHERE p.quest_id = $1"
        ))
        .bind(quest_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match row {
            None => Ok(None),
            Some(row) => {
                let meta = published_from_row(&row)?;
                let data: Option<serde_json::Value> = row.try_get("data").map_err(internal)?;
                Ok(Some((meta, data)))
            }
        }
    }
}

/// Identity (the `users` table + sessions) on PostgreSQL.
#[derive(Clone, Debug)]
pub struct PgAuthStore {
    pool: PgPool,
}

fn account_from_row(row: &sqlx::postgres::PgRow) -> Result<UserAccount, AppError> {
    let created_at: i64 = row.try_get("created_at").map_err(internal)?;
    let confirmed: Option<i64> = row.try_get("email_confirmed_at").map_err(internal)?;
    Ok(UserAccount {
        player_id: row.try_get("player_id").map_err(internal)?,
        email: row.try_get("email").map_err(internal)?,
        display_name: row.try_get("display_name").map_err(internal)?,
        role: row.try_get("role").map_err(internal)?,
        created_at: created_at as u64,
        email_confirmed_at: confirmed.map(|v| v as u64),
    })
}

impl PgAuthStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// See [`crate::store::InMemoryAuthStore::register_user`]. Both uniqueness
    /// invariants (one registration per player_id, one account per email) are
    /// enforced by database constraints; a conflicting insert affects zero rows
    /// and maps to 409 — concurrent duplicate registrations are absorbed.
    pub async fn register_user(
        &self,
        player_id: &str,
        email: &str,
        password_hash: &str,
        display_name: Option<String>,
    ) -> Result<UserAccount, AppError> {
        let created_at = now_secs();
        let inserted = sqlx::query(
            "INSERT INTO users (player_id, email, password_hash, display_name, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING
             RETURNING player_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(player_id)
        .bind(email)
        .bind(password_hash)
        .bind(&display_name)
        .bind(created_at as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match inserted {
            Some(row) => account_from_row(&row),
            None => Err(AppError::Conflict(
                "player is already registered or email is already taken".into(),
            )),
        }
    }

    /// See [`crate::store::InMemoryAuthStore::find_by_email`].
    pub async fn find_by_email(&self, email: &str) -> Result<Option<UserRecord>, AppError> {
        let row = sqlx::query(
            "SELECT player_id, email, password_hash, display_name, role, created_at, email_confirmed_at
             FROM users WHERE email = $1",
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(|r| {
            // A social-only account (Google) has an email but NULL password_hash;
            // an empty hash never verifies, so the password path yields 401 cleanly.
            let password_hash: Option<String> = r.try_get("password_hash").map_err(internal)?;
            Ok(UserRecord {
                account: account_from_row(&r)?,
                password_hash: password_hash.unwrap_or_default(),
            })
        })
        .transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::account_for_session`]. Resolves the
    /// session token to its account in ONE round-trip (was `get_session` then
    /// `get_user` — two serial round-trips on the front of every authenticated
    /// request). An anonymous session (no `users` row) yields `None` via the inner
    /// join, exactly like the two-step path.
    pub async fn account_for_session(&self, token: &str) -> Result<Option<UserAccount>, AppError> {
        let row = sqlx::query(
            "SELECT u.player_id, u.email, u.display_name, u.role, u.created_at, u.email_confirmed_at \
             FROM sessions s JOIN users u ON u.player_id = s.player_id \
             WHERE s.token = $1",
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.as_ref().map(account_from_row).transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::get_user`].
    pub async fn get_user(&self, player_id: &str) -> Result<Option<UserAccount>, AppError> {
        let row = sqlx::query(
            "SELECT player_id, email, display_name, role, created_at, email_confirmed_at \
             FROM users WHERE player_id = $1",
        )
        .bind(player_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.as_ref().map(account_from_row).transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::get_users_by_ids`]. Batch author
    /// lookup for the product page's review list — ONE round-trip for all the
    /// displayed reviews' authors, replacing a per-review `get_user` N+1.
    pub async fn get_users_by_ids(
        &self,
        player_ids: &[String],
    ) -> Result<std::collections::HashMap<String, UserAccount>, AppError> {
        if player_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let rows = sqlx::query(
            "SELECT player_id, email, display_name, role, created_at, email_confirmed_at \
             FROM users WHERE player_id = ANY($1)",
        )
        .bind(player_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter()
            .map(|r| {
                let account = account_from_row(r)?;
                Ok((account.player_id.clone(), account))
            })
            .collect()
    }

    /// See [`crate::store::InMemoryAuthStore::set_role`]. An UPDATE touching zero
    /// rows means the id is unregistered → 404 (only accounts have roles).
    pub async fn set_role(&self, player_id: &str, role: &str) -> Result<UserAccount, AppError> {
        let row = sqlx::query(
            "UPDATE users SET role = $2 WHERE player_id = $1 \
             RETURNING player_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(player_id)
        .bind(role)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match row {
            Some(r) => account_from_row(&r),
            None => Err(AppError::NotFound(format!(
                "no account for player '{player_id}'"
            ))),
        }
    }

    /// See [`crate::store::InMemoryAuthStore::list_users`]. Newest-first via the
    /// created_at index; ties broken by player_id for a stable order.
    pub async fn list_users(&self) -> Result<Vec<UserAccount>, AppError> {
        let rows = sqlx::query(
            "SELECT player_id, email, display_name, role, created_at, email_confirmed_at \
             FROM users ORDER BY created_at DESC, player_id ASC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter().map(account_from_row).collect()
    }

    /// See [`crate::store::InMemoryAuthStore::create_session`].
    pub async fn create_session(&self, token: &str, player_id: &str) -> Result<(), AppError> {
        sqlx::query("INSERT INTO sessions (token, player_id, created_at) VALUES ($1, $2, $3)")
            .bind(token)
            .bind(player_id)
            .bind(now_secs() as i64)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryAuthStore::set_display_name`].
    pub async fn set_display_name(
        &self,
        player_id: &str,
        display_name: Option<String>,
    ) -> Result<UserAccount, AppError> {
        let row = sqlx::query(
            "UPDATE users SET display_name = $2 WHERE player_id = $1
             RETURNING player_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(player_id)
        .bind(&display_name)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match row {
            Some(r) => account_from_row(&r),
            None => Err(AppError::NotFound(format!(
                "no account for player '{player_id}'"
            ))),
        }
    }

    /// See [`crate::store::InMemoryAuthStore::set_password`].
    pub async fn set_password(&self, player_id: &str, password_hash: &str) -> Result<(), AppError> {
        let res = sqlx::query("UPDATE users SET password_hash = $2 WHERE player_id = $1")
            .bind(player_id)
            .bind(password_hash)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        if res.rows_affected() == 0 {
            return Err(AppError::NotFound(format!(
                "no account for player '{player_id}'"
            )));
        }
        Ok(())
    }

    /// See [`crate::store::InMemoryAuthStore::confirm_email`].
    pub async fn confirm_email(&self, player_id: &str, at: u64) -> Result<UserAccount, AppError> {
        let row = sqlx::query(
            "UPDATE users SET email_confirmed_at = COALESCE(email_confirmed_at, $2)
             WHERE player_id = $1
             RETURNING player_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(player_id)
        .bind(at as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match row {
            Some(r) => account_from_row(&r),
            None => Err(AppError::NotFound(format!(
                "no account for player '{player_id}'"
            ))),
        }
    }

    /// See [`crate::store::InMemoryAuthStore::create_auth_token`] — latest
    /// mail wins: issuing deletes prior unused tokens of the same kind in the
    /// same transaction.
    pub async fn create_auth_token(
        &self,
        token_hash: &str,
        rec: crate::store::AuthTokenRecord,
    ) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query(
            "DELETE FROM auth_tokens WHERE player_id = $1 AND kind = $2 AND used_at IS NULL",
        )
        .bind(&rec.player_id)
        .bind(&rec.kind)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query(
            "INSERT INTO auth_tokens (token_hash, player_id, kind, code_hash, expires_at, used_at, attempts)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(token_hash)
        .bind(&rec.player_id)
        .bind(&rec.kind)
        .bind(&rec.code_hash)
        .bind(rec.expires_at as i64)
        .bind(rec.used_at.map(|v| v as i64))
        .bind(rec.attempts as i64)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryAuthStore::consume_auth_token`]. The UPDATE
    /// guards validity in one statement, so concurrent consumers race safely —
    /// exactly one wins.
    pub async fn consume_auth_token(
        &self,
        token_hash: &str,
        kind: &str,
        now: u64,
    ) -> Result<Option<String>, AppError> {
        let row = sqlx::query(
            "UPDATE auth_tokens SET used_at = $3
             WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at >= $3
             RETURNING player_id",
        )
        .bind(token_hash)
        .bind(kind)
        .bind(now as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(|r| r.try_get::<String, _>("player_id").map_err(internal))
            .transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::consume_auth_token_by_code`].
    /// The attempt is spent atomically (the guarded UPDATE), then a code_hash
    /// match consumes via a second used_at-guarded UPDATE — concurrent correct
    /// codes race safely, exactly one wins.
    pub async fn consume_auth_token_by_code(
        &self,
        player_id: &str,
        kind: &str,
        code_hash: &str,
        now: u64,
    ) -> Result<Option<String>, AppError> {
        let row = sqlx::query(
            "UPDATE auth_tokens SET attempts = attempts + 1
             WHERE player_id = $1 AND kind = $2 AND used_at IS NULL
               AND expires_at >= $3 AND attempts < $4
             RETURNING token_hash, code_hash",
        )
        .bind(player_id)
        .bind(kind)
        .bind(now as i64)
        .bind(crate::store::MAX_CODE_ATTEMPTS as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let Some(row) = row else { return Ok(None) };
        let stored: String = row.try_get("code_hash").map_err(internal)?;
        if stored.is_empty() || stored != code_hash {
            return Ok(None);
        }
        let token_hash: String = row.try_get("token_hash").map_err(internal)?;
        let won = sqlx::query(
            "UPDATE auth_tokens SET used_at = $2
             WHERE token_hash = $1 AND used_at IS NULL
             RETURNING player_id",
        )
        .bind(&token_hash)
        .bind(now as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        won.map(|r| r.try_get::<String, _>("player_id").map_err(internal))
            .transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::delete_user`] — user row,
    /// sessions and tokens in one transaction.
    pub async fn delete_user(&self, player_id: &str) -> Result<bool, AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query("DELETE FROM sessions WHERE player_id = $1")
            .bind(player_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query("DELETE FROM auth_tokens WHERE player_id = $1")
            .bind(player_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        let res = sqlx::query("DELETE FROM users WHERE player_id = $1")
            .bind(player_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        Ok(res.rows_affected() > 0)
    }

    /// See [`crate::store::InMemoryAuthStore::get_session`].
    pub async fn get_session(&self, token: &str) -> Result<Option<String>, AppError> {
        let row = sqlx::query("SELECT player_id FROM sessions WHERE token = $1")
            .bind(token)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        row.map(|r| r.try_get("player_id").map_err(internal))
            .transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::find_identity`].
    pub async fn find_identity(
        &self,
        provider: &str,
        subject: &str,
    ) -> Result<Option<String>, AppError> {
        let row = sqlx::query(
            "SELECT player_id FROM auth_identities WHERE provider = $1 AND subject = $2",
        )
        .bind(provider)
        .bind(subject)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(|r| r.try_get("player_id").map_err(internal))
            .transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::create_identity`]. The `(provider,
    /// subject)` PK absorbs a concurrent duplicate link (0 rows → 409).
    pub async fn create_identity(&self, identity: AuthIdentity) -> Result<(), AppError> {
        let inserted = sqlx::query(
            "INSERT INTO auth_identities (provider, subject, player_id, email, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING",
        )
        .bind(&identity.provider)
        .bind(&identity.subject)
        .bind(&identity.player_id)
        .bind(&identity.email)
        .bind(identity.created_at as i64)
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        if inserted.rows_affected() == 0 {
            return Err(AppError::Conflict("identity already linked".into()));
        }
        Ok(())
    }

    /// See [`crate::store::InMemoryAuthStore::identities_for_player`].
    pub async fn identities_for_player(
        &self,
        player_id: &str,
    ) -> Result<Vec<AuthIdentity>, AppError> {
        let rows = sqlx::query(
            "SELECT provider, subject, player_id, email, created_at \
             FROM auth_identities WHERE player_id = $1 ORDER BY provider ASC",
        )
        .bind(player_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter()
            .map(|r| {
                let created_at: i64 = r.try_get("created_at").map_err(internal)?;
                Ok(AuthIdentity {
                    provider: r.try_get("provider").map_err(internal)?,
                    subject: r.try_get("subject").map_err(internal)?,
                    player_id: r.try_get("player_id").map_err(internal)?,
                    email: r.try_get("email").map_err(internal)?,
                    created_at: created_at.max(0) as u64,
                })
            })
            .collect()
    }

    /// See [`crate::store::InMemoryAuthStore::delete_identity`].
    pub async fn delete_identity(&self, provider: &str, player_id: &str) -> Result<bool, AppError> {
        let res = sqlx::query("DELETE FROM auth_identities WHERE provider = $1 AND player_id = $2")
            .bind(provider)
            .bind(player_id)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(res.rows_affected() > 0)
    }

    /// See [`crate::store::InMemoryAuthStore::create_social_account`]. `password_hash`
    /// is NULL (no password); a taken player_id or email is absorbed as 409.
    pub async fn create_social_account(
        &self,
        player_id: &str,
        email: Option<String>,
        display_name: Option<String>,
        email_confirmed_at: Option<u64>,
    ) -> Result<UserAccount, AppError> {
        let inserted = sqlx::query(
            "INSERT INTO users (player_id, email, password_hash, display_name, created_at, email_confirmed_at)
             VALUES ($1, $2, NULL, $3, $4, $5)
             ON CONFLICT DO NOTHING
             RETURNING player_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(player_id)
        .bind(&email)
        .bind(&display_name)
        .bind(now_secs() as i64)
        .bind(email_confirmed_at.map(|v| v as i64))
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match inserted {
            Some(row) => account_from_row(&row),
            None => Err(AppError::Conflict(
                "player is already registered or email is already taken".into(),
            )),
        }
    }

    /// See [`crate::store::InMemoryAuthStore::attach_email`]. Sets the email only
    /// when the account has none; a UNIQUE violation (email taken elsewhere) → 409.
    pub async fn attach_email(
        &self,
        player_id: &str,
        email: &str,
        confirmed_at: u64,
    ) -> Result<UserAccount, AppError> {
        let updated = sqlx::query(
            "UPDATE users SET email = $2, email_confirmed_at = COALESCE(email_confirmed_at, $3) \
             WHERE player_id = $1 AND email IS NULL \
             RETURNING player_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(player_id)
        .bind(email)
        .bind(confirmed_at as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.is_unique_violation() => {
                AppError::Conflict("email is already taken".into())
            }
            other => internal(other),
        })?;
        match updated {
            Some(row) => account_from_row(&row),
            // The account already has an email (WHERE matched nothing) — return it.
            None => self
                .get_user(player_id)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("no account for player '{player_id}'"))),
        }
    }
}

/// Constructor quests (authoring drafts + lifecycle) on PostgreSQL.
#[derive(Clone, Debug)]
pub struct PgConstructorStore {
    pool: PgPool,
}

/// List columns only (no body) — the dashboard row.
fn ctor_summary_from_row(row: &sqlx::postgres::PgRow) -> Result<ConstructorQuestSummary, AppError> {
    let steps_count: i32 = row.try_get("steps_count").map_err(internal)?;
    let created_at: i64 = row.try_get("created_at").map_err(internal)?;
    let updated_at: i64 = row.try_get("updated_at").map_err(internal)?;
    Ok(ConstructorQuestSummary {
        quest_id: row.try_get("quest_id").map_err(internal)?,
        author_id: row.try_get("author_id").map_err(internal)?,
        author_name: row.try_get("author_name").map_err(internal)?,
        name: row.try_get("name").map_err(internal)?,
        status: row.try_get("status").map_err(internal)?,
        steps_count: steps_count.max(0) as u32,
        created_at: created_at.max(0) as u64,
        updated_at: updated_at.max(0) as u64,
    })
}

/// Columns selected for a summary row (kept in one place so list/save/status
/// agree). Deliberately EXCLUDES the heavy `cover` (base64 image) and `body`:
/// the dashboard list never renders them, so reading the TOASTed cover for every
/// row was the cause of the multi-second list load. GET-one adds `cover`/`body`
/// back explicitly because the builder needs the full entity.
const CTOR_SUMMARY_COLS: &str =
    "quest_id, author_id, author_name, name, status, steps_count, created_at, updated_at";

impl PgConstructorStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// See [`crate::store::InMemoryConstructorStore::create`]. A conflicting id
    /// affects zero rows (ON CONFLICT DO NOTHING) and maps to 409.
    pub async fn create(
        &self,
        quest: ConstructorQuest,
    ) -> Result<ConstructorQuestSummary, AppError> {
        let inserted = sqlx::query(
            "INSERT INTO constructor_quests
                (quest_id, author_id, author_name, name, status, cover, steps_count, body, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT DO NOTHING
             RETURNING quest_id",
        )
        .bind(&quest.quest_id)
        .bind(&quest.author_id)
        .bind(&quest.author_name)
        .bind(&quest.name)
        .bind(&quest.status)
        .bind(&quest.cover)
        .bind(quest.steps_count as i32)
        .bind(&quest.body)
        .bind(quest.created_at as i64)
        .bind(quest.updated_at as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        if inserted.is_none() {
            return Err(AppError::Conflict(format!(
                "constructor quest '{}' already exists",
                quest.quest_id
            )));
        }
        Ok(quest.summary())
    }

    /// Summary rows, newest-first (ties by id), optionally scoped to one author.
    /// Shared by the per-author dashboard list and the admin (all-authors) list —
    /// same projection + ordering, only the `WHERE` differs.
    async fn fetch_summaries(
        &self,
        author_id: Option<&str>,
    ) -> Result<Vec<ConstructorQuestSummary>, AppError> {
        let where_clause = if author_id.is_some() {
            "WHERE author_id = $1 "
        } else {
            ""
        };
        let sql = format!(
            "SELECT {CTOR_SUMMARY_COLS} FROM constructor_quests \
             {where_clause}ORDER BY created_at DESC, quest_id ASC"
        );
        let mut query = sqlx::query(&sql);
        if let Some(author_id) = author_id {
            query = query.bind(author_id);
        }
        let rows = query.fetch_all(&self.pool).await.map_err(internal)?;
        rows.iter().map(ctor_summary_from_row).collect()
    }

    /// See [`crate::store::InMemoryConstructorStore::list_summaries_for_author`].
    /// Scoped by `author_id` (the `idx_ctor_quests_author` index serves this) so the
    /// dashboard can never return another author's quests.
    pub async fn list_summaries_for_author(
        &self,
        author_id: &str,
    ) -> Result<Vec<ConstructorQuestSummary>, AppError> {
        self.fetch_summaries(Some(author_id)).await
    }

    /// See [`crate::store::InMemoryConstructorStore::get`].
    pub async fn get(&self, quest_id: &str) -> Result<Option<ConstructorQuest>, AppError> {
        let sql = format!(
            "SELECT {CTOR_SUMMARY_COLS}, cover, body FROM constructor_quests WHERE quest_id = $1"
        );
        let row = sqlx::query(&sql)
            .bind(quest_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        match row {
            None => Ok(None),
            Some(row) => {
                let s = ctor_summary_from_row(&row)?;
                let body: serde_json::Value = row.try_get("body").map_err(internal)?;
                Ok(Some(ConstructorQuest {
                    quest_id: s.quest_id,
                    author_id: s.author_id,
                    author_name: s.author_name,
                    name: s.name,
                    status: s.status,
                    // `cover` is excluded from CTOR_SUMMARY_COLS (list slimming); GET-one
                    // selects it explicitly above and reads it straight off the row.
                    cover: row.try_get("cover").map_err(internal)?,
                    steps_count: s.steps_count,
                    created_at: s.created_at,
                    updated_at: s.updated_at,
                    body,
                }))
            }
        }
    }

    /// See [`crate::store::InMemoryConstructorStore::save_body`]. Zero rows updated
    /// means the id is unknown → 404.
    pub async fn save_body(
        &self,
        quest_id: &str,
        name: &str,
        cover: Option<String>,
        steps_count: u32,
        body: serde_json::Value,
        updated_at: u64,
    ) -> Result<ConstructorQuestSummary, AppError> {
        let sql = format!(
            "UPDATE constructor_quests \
             SET name = $2, cover = $3, steps_count = $4, body = $5, updated_at = $6 \
             WHERE quest_id = $1 RETURNING {CTOR_SUMMARY_COLS}"
        );
        let row = sqlx::query(&sql)
            .bind(quest_id)
            .bind(name)
            .bind(&cover)
            .bind(steps_count as i32)
            .bind(&body)
            .bind(updated_at as i64)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        match row {
            Some(r) => ctor_summary_from_row(&r),
            None => Err(AppError::NotFound(format!(
                "constructor quest '{quest_id}' not found"
            ))),
        }
    }

    /// See [`crate::store::InMemoryConstructorStore::set_status`].
    pub async fn set_status(
        &self,
        quest_id: &str,
        status: &str,
        updated_at: u64,
    ) -> Result<Option<ConstructorQuestSummary>, AppError> {
        let sql = format!(
            "UPDATE constructor_quests SET status = $2, updated_at = $3 \
             WHERE quest_id = $1 RETURNING {CTOR_SUMMARY_COLS}"
        );
        let row = sqlx::query(&sql)
            .bind(quest_id)
            .bind(status)
            .bind(updated_at as i64)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        row.as_ref().map(ctor_summary_from_row).transpose()
    }

    /// See [`crate::store::InMemoryConstructorStore::list_all_summaries`]. The admin
    /// view: NOT scoped by author (every author's quests), newest-first like the
    /// per-author list.
    pub async fn list_all_summaries(&self) -> Result<Vec<ConstructorQuestSummary>, AppError> {
        self.fetch_summaries(None).await
    }

    /// See [`crate::store::InMemoryConstructorStore::statuses_by_quest`]. A single
    /// lightweight scan (quest_id + status only) backing the store-catalog filter.
    pub async fn statuses_by_quest(
        &self,
    ) -> Result<std::collections::HashMap<String, String>, AppError> {
        let rows = sqlx::query("SELECT quest_id, status FROM constructor_quests")
            .fetch_all(&self.pool)
            .await
            .map_err(internal)?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let quest_id: String = row.try_get("quest_id").map_err(internal)?;
            let status: String = row.try_get("status").map_err(internal)?;
            out.insert(quest_id, status);
        }
        Ok(out)
    }

    /// See [`crate::store::InMemoryConstructorStore::delete`].
    pub async fn delete(&self, quest_id: &str) -> Result<bool, AppError> {
        let res = sqlx::query("DELETE FROM constructor_quests WHERE quest_id = $1")
            .bind(quest_id)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(res.rows_affected() > 0)
    }
}

/// Coupons + redemptions on PostgreSQL.
#[derive(Clone, Debug)]
pub struct PgCouponStore {
    pool: PgPool,
}

fn discount_to_cols(d: &Discount) -> (&'static str, i64) {
    match d {
        Discount::Percent(p) => ("percent", i64::from(*p)),
        Discount::Fixed(v) => ("fixed", *v),
    }
}

fn discount_from_cols(kind: &str, value: i64) -> Result<Discount, AppError> {
    match kind {
        "percent" => u8::try_from(value)
            .ok()
            .filter(|p| (1..=100).contains(p))
            .map(Discount::Percent)
            .ok_or_else(|| {
                AppError::Internal(anyhow::anyhow!("invalid percent discount in db: {value}"))
            }),
        "fixed" => Ok(Discount::Fixed(value)),
        other => Err(AppError::Internal(anyhow::anyhow!(
            "unknown discount type in db: {other}"
        ))),
    }
}

fn coupon_from_row(row: &sqlx::postgres::PgRow) -> Result<Coupon, AppError> {
    let quest_ids: Option<serde_json::Value> = row.try_get("quest_ids").map_err(internal)?;
    let quest_ids = quest_ids
        .map(|v| serde_json::from_value::<Vec<String>>(v).map_err(internal))
        .transpose()?;
    let max_redemptions: Option<i64> = row.try_get("max_redemptions").map_err(internal)?;
    let per_user_limit: Option<i64> = row.try_get("per_user_limit").map_err(internal)?;
    Ok(Coupon {
        coupon_id: row.try_get("coupon_id").map_err(internal)?,
        code: row.try_get("code").map_err(internal)?,
        discount: discount_from_cols(
            row.try_get::<String, _>("discount_type")
                .map_err(internal)?
                .as_str(),
            row.try_get("discount_value").map_err(internal)?,
        )?,
        valid_until: row.try_get("valid_until").map_err(internal)?,
        max_redemptions: max_redemptions.map(|v| v as u32),
        per_user_limit: per_user_limit.map(|v| v as u32),
        quest_ids,
        paused: row.try_get("paused").map_err(internal)?,
        created_at: row.try_get("created_at").map_err(internal)?,
    })
}

fn redemption_from_row(row: &sqlx::postgres::PgRow) -> Result<CouponRedemption, AppError> {
    Ok(CouponRedemption {
        coupon_id: row.try_get("coupon_id").map_err(internal)?,
        player_id: row.try_get("player_id").map_err(internal)?,
        quest_id: row.try_get("quest_id").map_err(internal)?,
        amount_discounted: row.try_get("amount_discounted").map_err(internal)?,
        redeemed_at: row.try_get("redeemed_at").map_err(internal)?,
    })
}

const COUPON_COLS: &str = "coupon_id, code, discount_type, discount_value, valid_until, \
                           max_redemptions, per_user_limit, quest_ids, paused, created_at";

impl PgCouponStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    fn bind_coupon<'q>(
        query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
        coupon: &'q Coupon,
    ) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
        let (kind, value) = discount_to_cols(&coupon.discount);
        query
            .bind(&coupon.coupon_id)
            .bind(&coupon.code)
            .bind(kind)
            .bind(value)
            .bind(&coupon.valid_until)
            .bind(coupon.max_redemptions.map(i64::from))
            .bind(coupon.per_user_limit.map(i64::from))
            .bind(coupon.quest_ids.as_ref().map(|q| serde_json::json!(q)))
            .bind(coupon.paused)
            .bind(&coupon.created_at)
    }

    /// See [`crate::store::InMemoryCouponStore::create`].
    pub async fn create(&self, coupon: Coupon) -> Result<Coupon, AppError> {
        let inserted = Self::bind_coupon(
            sqlx::query(&format!(
                "INSERT INTO coupons ({COUPON_COLS})
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT DO NOTHING
                 RETURNING {COUPON_COLS}"
            )),
            &coupon,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match inserted {
            Some(row) => coupon_from_row(&row),
            None => Err(AppError::Conflict(format!(
                "купон с кодом '{}' уже существует",
                coupon.code
            ))),
        }
    }

    /// See [`crate::store::InMemoryCouponStore::update`].
    pub async fn update(&self, coupon: Coupon) -> Result<Coupon, AppError> {
        let code_taken =
            sqlx::query("SELECT 1 AS one FROM coupons WHERE code = $1 AND coupon_id <> $2")
                .bind(&coupon.code)
                .bind(&coupon.coupon_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal)?;
        if code_taken.is_some() {
            return Err(AppError::Conflict(format!(
                "купон с кодом '{}' уже существует",
                coupon.code
            )));
        }
        let (kind, value) = discount_to_cols(&coupon.discount);
        let updated = sqlx::query(&format!(
            "UPDATE coupons SET code = $2, discount_type = $3, discount_value = $4,
                    valid_until = $5, max_redemptions = $6, per_user_limit = $7,
                    quest_ids = $8, paused = $9
             WHERE coupon_id = $1
             RETURNING {COUPON_COLS}"
        ))
        .bind(&coupon.coupon_id)
        .bind(&coupon.code)
        .bind(kind)
        .bind(value)
        .bind(&coupon.valid_until)
        .bind(coupon.max_redemptions.map(i64::from))
        .bind(coupon.per_user_limit.map(i64::from))
        .bind(coupon.quest_ids.as_ref().map(|q| serde_json::json!(q)))
        .bind(coupon.paused)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match updated {
            Some(row) => coupon_from_row(&row),
            None => Err(AppError::NotFound(format!(
                "unknown coupon '{}'",
                coupon.coupon_id
            ))),
        }
    }

    /// See [`crate::store::InMemoryCouponStore::get`].
    pub async fn get(&self, coupon_id: &str) -> Result<Option<Coupon>, AppError> {
        let row = sqlx::query(&format!(
            "SELECT {COUPON_COLS} FROM coupons WHERE coupon_id = $1"
        ))
        .bind(coupon_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(|r| coupon_from_row(&r)).transpose()
    }

    /// See [`crate::store::InMemoryCouponStore::delete`]. The redemption log
    /// cascades at the schema level (`ON DELETE CASCADE`).
    pub async fn delete(&self, coupon_id: &str) -> Result<(), AppError> {
        let res = sqlx::query("DELETE FROM coupons WHERE coupon_id = $1")
            .bind(coupon_id)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        if res.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("unknown coupon '{coupon_id}'")));
        }
        Ok(())
    }

    /// See [`crate::store::InMemoryCouponStore::list_with_usage`].
    pub async fn list_with_usage(&self) -> Result<Vec<(Coupon, CouponUsage)>, AppError> {
        let rows = sqlx::query(&format!(
            "SELECT {COUPON_COLS},
                    COALESCE(u.used, 0)  AS used,
                    u.last_redeemed_at   AS last_redeemed_at,
                    COALESCE(u.total, 0) AS total_discounted
             FROM coupons c
             LEFT JOIN (
                 SELECT coupon_id, COUNT(*) AS used, MAX(redeemed_at) AS last_redeemed_at,
                        SUM(amount_discounted)::BIGINT AS total
                 FROM coupon_redemptions GROUP BY coupon_id
             ) u USING (coupon_id)
             ORDER BY c.created_at DESC, c.coupon_id ASC"
        ))
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter()
            .map(|row| Ok((coupon_from_row(row)?, usage_from_row(row)?)))
            .collect()
    }

    /// See [`crate::store::InMemoryCouponStore::get_with_usage`].
    pub async fn get_with_usage(
        &self,
        coupon_id: &str,
    ) -> Result<Option<(Coupon, CouponUsage)>, AppError> {
        let row = sqlx::query(&format!(
            "SELECT {COUPON_COLS},
                    COALESCE(u.used, 0)  AS used,
                    u.last_redeemed_at   AS last_redeemed_at,
                    COALESCE(u.total, 0) AS total_discounted
             FROM coupons c
             LEFT JOIN (
                 SELECT coupon_id, COUNT(*) AS used, MAX(redeemed_at) AS last_redeemed_at,
                        SUM(amount_discounted)::BIGINT AS total
                 FROM coupon_redemptions GROUP BY coupon_id
             ) u USING (coupon_id)
             WHERE c.coupon_id = $1"
        ))
        .bind(coupon_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(|r| Ok((coupon_from_row(&r)?, usage_from_row(&r)?)))
            .transpose()
    }

    /// See [`crate::store::InMemoryCouponStore::preview`].
    pub async fn preview(
        &self,
        code: &str,
        player_id: &str,
    ) -> Result<Option<(Coupon, u32, u32)>, AppError> {
        let row = sqlx::query(&format!(
            "SELECT {COUPON_COLS},
                    (SELECT COUNT(*) FROM coupon_redemptions r
                      WHERE r.coupon_id = c.coupon_id) AS used_total,
                    (SELECT COUNT(*) FROM coupon_redemptions r
                      WHERE r.coupon_id = c.coupon_id AND r.player_id = $2) AS used_by_player
             FROM coupons c WHERE c.code = $1"
        ))
        .bind(code)
        .bind(player_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(|r| {
            let used_total: i64 = r.try_get("used_total").map_err(internal)?;
            let used_by_player: i64 = r.try_get("used_by_player").map_err(internal)?;
            Ok((
                coupon_from_row(&r)?,
                used_total as u32,
                used_by_player as u32,
            ))
        })
        .transpose()
    }

    /// See [`crate::store::InMemoryCouponStore::redeem`]. The coupon row is
    /// locked `FOR UPDATE` for the check-then-insert, so concurrent redemptions
    /// of the same code serialize and the caps cannot be oversubscribed; the
    /// composite PK absorbs a same-(player, quest) retry idempotently.
    pub async fn redeem(
        &self,
        code: &str,
        player_id: &str,
        quest_id: &str,
        price: i64,
    ) -> Result<CouponRedemption, AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;
        let row = sqlx::query(&format!(
            "SELECT {COUPON_COLS} FROM coupons WHERE code = $1 FOR UPDATE"
        ))
        .bind(code)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        let coupon = match row {
            Some(r) => coupon_from_row(&r)?,
            None => return Err(AppError::NotFound("промокод не найден".into())),
        };
        let existing = sqlx::query(
            "SELECT coupon_id, player_id, quest_id, amount_discounted, redeemed_at
             FROM coupon_redemptions
             WHERE coupon_id = $1 AND player_id = $2 AND quest_id = $3",
        )
        .bind(&coupon.coupon_id)
        .bind(player_id)
        .bind(quest_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        if let Some(r) = existing {
            tx.commit().await.map_err(internal)?;
            return redemption_from_row(&r);
        }
        let counts = sqlx::query(
            "SELECT COUNT(*) AS used_total,
                    COUNT(*) FILTER (WHERE player_id = $2) AS used_by_player
             FROM coupon_redemptions WHERE coupon_id = $1",
        )
        .bind(&coupon.coupon_id)
        .bind(player_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
        let used_total: i64 = counts.try_get("used_total").map_err(internal)?;
        let used_by_player: i64 = counts.try_get("used_by_player").map_err(internal)?;
        let now = now_rfc3339();
        crate::coupons::check_redeemable(
            &coupon,
            quest_id,
            used_total as u32,
            used_by_player as u32,
            &now[..10],
        )
        .map_err(|reject| AppError::Conflict(reject.message().into()))?;
        let redemption = CouponRedemption {
            coupon_id: coupon.coupon_id.clone(),
            player_id: player_id.to_string(),
            quest_id: quest_id.to_string(),
            amount_discounted: crate::coupons::discount_amount(&coupon.discount, price),
            redeemed_at: now,
        };
        sqlx::query(
            "INSERT INTO coupon_redemptions
                 (coupon_id, player_id, quest_id, amount_discounted, redeemed_at)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&redemption.coupon_id)
        .bind(&redemption.player_id)
        .bind(&redemption.quest_id)
        .bind(redemption.amount_discounted)
        .bind(&redemption.redeemed_at)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        Ok(redemption)
    }
}

fn usage_from_row(row: &sqlx::postgres::PgRow) -> Result<CouponUsage, AppError> {
    let used: i64 = row.try_get("used").map_err(internal)?;
    let total: i64 = row.try_get("total_discounted").map_err(internal)?;
    Ok(CouponUsage {
        used: used as u32,
        last_redeemed_at: row.try_get("last_redeemed_at").map_err(internal)?,
        total_discounted: total,
    })
}
