//! PostgreSQL store implementations (sqlx).
//!
//! Behavior mirrors the in-memory stores exactly — the in-memory implementation is
//! the executable specification. Idempotency invariants live as constraints here:
//! `facts UNIQUE(attempt_id, natural_key)` absorbs duplicate appends (including
//! concurrent ones), and `bonus_awards PRIMARY KEY(user_id, quest_id)` makes the
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
    project_state, project_version_stats, synthesize_legacy_snapshot_and_facts,
};
use crate::grants::{AccessGrant, GrantSource};
use crate::payments::{PendingPayment, PendingStatus};
use crate::store::{
    AttemptMeta, AuthIdentity, AuthStore, CatalogListing, ConstructorQuest,
    ConstructorQuestSummary, ConstructorStore, CouponStore, FactStore, FlagStore, GrantStore,
    KvStore, ModerationStore, PaymentStore, PublishedMeta, QuestAttributes, QuestLabel,
    now_rfc3339, now_secs,
};

fn internal(e: impl Into<anyhow::Error>) -> AppError {
    AppError::Internal(e.into())
}

/// Stored column backing the UNIQUE constraint (one NOT NULL column because
/// nullable multi-column UNIQUEs don't dedup in Postgres) — the canonical
/// string form from facts.rs.
fn natural_key_string(f: &Fact) -> Result<String, AppError> {
    crate::facts::natural_key_string(f).map_err(internal)
}

/// Facts + attempts on PostgreSQL.
#[derive(Clone, Debug)]
pub struct PgFactStore {
    pool: PgPool,
}

impl PgFactStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
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
}

#[async_trait::async_trait]
impl FactStore for PgFactStore {
    /// See [`crate::store::InMemoryFactStore::quest_rating_rows`]. Per `(quest,
    /// player)` the latest rated attempt's last `quest_rated` fact — the input to
    /// the public hide-aware fold. `None` scans every quest (admin list);
    /// `Some(&[..])` scopes it (product page + catalog). Unparseable ratings are
    /// dropped, mirroring [`crate::facts::effective_rating`].
    async fn quest_rating_rows(
        &self,
        quests: Option<&[String]>,
    ) -> Result<Vec<crate::facts::PlayerRatingRow>, AppError> {
        use sqlx::Row;
        // Inner DISTINCT ON keeps the last quest_rated per attempt (a newer
        // re-rating wins); outer DISTINCT ON keeps, per (quest, player), the newest
        // rated attempt (ties by attempt_id, matching the in-memory tuple order).
        const SELECT: &str = "SELECT DISTINCT ON (a.quest_id, a.user_id)
                    a.quest_id, a.user_id, a.created_at, last_rated.data
             FROM ( SELECT DISTINCT ON (f.attempt_id) f.attempt_id, f.data
                    FROM facts f
                    WHERE f.data->>'type' = 'quest_rated'
                    ORDER BY f.attempt_id, f.seq DESC ) AS last_rated
             JOIN attempts a ON a.attempt_id = last_rated.attempt_id";
        const ORDER: &str = " ORDER BY a.quest_id, a.user_id, a.created_at DESC, a.attempt_id DESC";
        let rows = match quests {
            Some([]) => return Ok(Vec::new()),
            Some(qs) => sqlx::query(&format!("{SELECT} WHERE a.quest_id = ANY($1){ORDER}"))
                .bind(qs)
                .fetch_all(&self.pool)
                .await
                .map_err(internal)?,
            None => sqlx::query(&format!("{SELECT}{ORDER}"))
                .fetch_all(&self.pool)
                .await
                .map_err(internal)?,
        };
        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            let data: serde_json::Value = r.try_get("data").map_err(internal)?;
            let Some(rating) = data
                .get("submitted_value")
                .and_then(|v| v.as_str())
                .and_then(|v| v.trim().parse::<i64>().ok())
            else {
                continue; // unparseable rating → excluded (mirrors effective_rating)
            };
            let text = data
                .get("note")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string);
            let created_at: i64 = r.try_get("created_at").map_err(internal)?;
            out.push(crate::facts::PlayerRatingRow {
                user_id: r.try_get("user_id").map_err(internal)?,
                quest_id: r.try_get("quest_id").map_err(internal)?,
                rating,
                text,
                created_at: created_at as u64,
            });
        }
        Ok(out)
    }

    /// See [`crate::store::InMemoryFactStore::delete_user_data`] — the
    /// player's attempts + their facts + bonus marks, one transaction.
    async fn delete_user_data(&self, user_id: &str) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query(
            "DELETE FROM facts WHERE attempt_id IN (SELECT attempt_id FROM attempts WHERE user_id = $1)",
        )
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query("DELETE FROM bonus_awards WHERE user_id = $1")
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query("DELETE FROM attempts WHERE user_id = $1")
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryFactStore::create_attempt`].
    async fn create_attempt(
        &self,
        user_id: &str,
        quest_id: &str,
        snapshot_id: &str,
    ) -> Result<AttemptMeta, AppError> {
        let created_at = now_secs();
        let row = sqlx::query(
            "INSERT INTO attempts (attempt_id, user_id, quest_id, snapshot_id, created_at)
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
             RETURNING attempt_id",
        )
        .bind(user_id)
        .bind(quest_id)
        .bind(snapshot_id)
        .bind(created_at as i64)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        Ok(AttemptMeta {
            attempt_id: row.try_get("attempt_id").map_err(internal)?,
            user_id: user_id.to_string(),
            quest_id: quest_id.to_string(),
            snapshot_id: snapshot_id.to_string(),
            created_at,
        })
    }

    /// Idempotent batch append in ONE transaction. Returns `None` for unknown
    /// attempts. Accepted = rows the database actually inserted (ON CONFLICT
    /// DO NOTHING), so concurrent duplicates are absorbed by the constraints.
    async fn append_idempotent(
        &self,
        attempt_id: &str,
        incoming: Vec<Fact>,
    ) -> Result<Option<Vec<Fact>>, AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;

        let Some(meta_row) =
            sqlx::query("SELECT user_id, quest_id FROM attempts WHERE attempt_id = $1")
                .bind(attempt_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?
        else {
            return Ok(None);
        };
        let user_id: String = meta_row.try_get("user_id").map_err(internal)?;
        let quest_id: String = meta_row.try_get("quest_id").map_err(internal)?;

        let mut accepted = Vec::new();
        for f in incoming {
            if f.kind == FactKind::CompletionBonus {
                let res = sqlx::query(
                    "INSERT INTO bonus_awards (user_id, quest_id) VALUES ($1, $2)
                     ON CONFLICT DO NOTHING",
                )
                .bind(&user_id)
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
                "INSERT INTO facts (attempt_id, natural_key, data, recorded_at)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT DO NOTHING
                 RETURNING seq",
            )
            .bind(attempt_id)
            .bind(&key)
            .bind(&data)
            .bind(now_secs() as i64)
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

    /// See [`crate::store::InMemoryFactStore::get_projected`].
    async fn get_projected(
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

    /// See [`crate::store::InMemoryFactStore::get_version_stats`].
    async fn get_version_stats(
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
    async fn list_feedbacks_for_version(&self, snap: &str) -> Result<Vec<Fact>, AppError> {
        let (fact_logs, attempt_snaps) = self.load_snapshot_logs(snap).await?;
        Ok(list_feedbacks_for_snapshot(
            snap,
            &fact_logs,
            &attempt_snaps,
        ))
    }

    /// See [`crate::store::InMemoryFactStore::all_feedback_reports`]. One scan of the
    /// feedback facts joined to their attempt context; `recorded_at` is the server
    /// receive time (the watermark basis). Backed by the `idx_facts_type` index.
    async fn all_feedback_reports(&self) -> Result<Vec<crate::facts::FeedbackReportRow>, AppError> {
        use sqlx::Row;
        let rows = sqlx::query(
            "SELECT a.quest_id, a.snapshot_id, a.user_id,
                    (f.data->>'step_position')::int AS step_position,
                    COALESCE(f.data->>'note', '')   AS note,
                    f.recorded_at
             FROM facts f JOIN attempts a ON a.attempt_id = f.attempt_id
             WHERE f.data->>'type' = 'feedback_reported'",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter()
            .map(|r| {
                let recorded_at: Option<i64> = r.try_get("recorded_at").map_err(internal)?;
                Ok(crate::facts::FeedbackReportRow {
                    quest_id: r.try_get("quest_id").map_err(internal)?,
                    snapshot_id: r.try_get("snapshot_id").map_err(internal)?,
                    step_position: r.try_get("step_position").map_err(internal)?,
                    user_id: r.try_get("user_id").map_err(internal)?,
                    note: r.try_get("note").map_err(internal)?,
                    recorded_at: recorded_at.unwrap_or(0).max(0) as u64,
                })
            })
            .collect()
    }

    /// See [`crate::store::InMemoryFactStore::attempt_logs_for_user`].
    async fn attempt_logs_for_user(
        &self,
        user_id: &str,
    ) -> Result<Vec<(String, Vec<Fact>)>, AppError> {
        // Attempts first: preserves their row order, captures each quest_id, and
        // keeps zero-fact attempts (the facts JOIN below can't surface those).
        let rows = sqlx::query("SELECT attempt_id, quest_id FROM attempts WHERE user_id = $1")
            .bind(user_id)
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
             WHERE a.user_id = $1
             ORDER BY f.seq",
        )
        .bind(user_id)
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
    async fn completions_by_quest(
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
    async fn completions_for_quest(&self, quest_id: &str) -> Result<usize, AppError> {
        let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM bonus_awards WHERE quest_id = $1")
            .bind(quest_id)
            .fetch_one(&self.pool)
            .await
            .map_err(internal)?
            .try_get("n")
            .map_err(internal)?;
        Ok(n.max(0) as usize)
    }

    /// See [`crate::store::InMemoryFactStore::stats_start_events`].
    async fn stats_start_events(
        &self,
        from: i64,
        to_excl: i64,
        quest: Option<&str>,
    ) -> Result<Vec<crate::admin_stats::StatEvent>, AppError> {
        let rows = sqlx::query(
            "SELECT quest_id, created_at FROM attempts
             WHERE created_at >= $1 AND created_at < $2
               AND ($3::text IS NULL OR quest_id = $3)",
        )
        .bind(from)
        .bind(to_excl)
        .bind(quest)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter()
            .map(|r| {
                Ok(crate::admin_stats::StatEvent {
                    quest_id: r.try_get("quest_id").map_err(internal)?,
                    at: r.try_get("created_at").map_err(internal)?,
                })
            })
            .collect()
    }

    /// See [`crate::store::InMemoryFactStore::stats_finish_events`]: at most
    /// one event per attempt — the earliest completion fact (facts dedup by
    /// natural key incl. step_position, so an attempt can hold several
    /// `attempt_completed` rows; counting rows would overcount finishes).
    /// `recorded_at` is NOT NULL since migration 0013's total backfill.
    async fn stats_finish_events(
        &self,
        from: i64,
        to_excl: i64,
        quest: Option<&str>,
    ) -> Result<Vec<crate::admin_stats::StatEvent>, AppError> {
        let rows = sqlx::query(
            "SELECT a.quest_id, MIN(f.recorded_at) AS at
             FROM facts f
             JOIN attempts a ON a.attempt_id = f.attempt_id
             WHERE f.data->>'type' = 'attempt_completed'
               AND ($3::text IS NULL OR a.quest_id = $3)
             GROUP BY f.attempt_id, a.quest_id
             HAVING MIN(f.recorded_at) >= $1 AND MIN(f.recorded_at) < $2",
        )
        .bind(from)
        .bind(to_excl)
        .bind(quest)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter()
            .map(|r| {
                Ok(crate::admin_stats::StatEvent {
                    quest_id: r.try_get("quest_id").map_err(internal)?,
                    at: r.try_get("at").map_err(internal)?,
                })
            })
            .collect()
    }

    /// See [`crate::store::InMemoryFactStore::funnel_logs`]. Same two-pass
    /// shape as [`Self::load_snapshot_logs`]: seed every in-range attempt with
    /// an empty log (zero-fact attempts count in the funnel denominator), then
    /// ONE round-trip for all their facts.
    async fn funnel_logs(
        &self,
        snapshot_id: &str,
        from: i64,
        to_excl: i64,
    ) -> Result<Vec<Vec<Fact>>, AppError> {
        let attempt_rows = sqlx::query(
            "SELECT attempt_id FROM attempts
             WHERE snapshot_id = $1 AND created_at >= $2 AND created_at < $3",
        )
        .bind(snapshot_id)
        .bind(from)
        .bind(to_excl)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        let mut logs: std::collections::HashMap<String, Vec<Fact>> =
            std::collections::HashMap::with_capacity(attempt_rows.len());
        for row in &attempt_rows {
            let att: String = row.try_get("attempt_id").map_err(internal)?;
            logs.insert(att, Vec::new());
        }
        let fact_rows = sqlx::query(
            "SELECT f.attempt_id, f.data FROM facts f
             JOIN attempts a ON a.attempt_id = f.attempt_id
             WHERE a.snapshot_id = $1 AND a.created_at >= $2 AND a.created_at < $3
             ORDER BY f.seq",
        )
        .bind(snapshot_id)
        .bind(from)
        .bind(to_excl)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        for row in fact_rows {
            let att: String = row.try_get("attempt_id").map_err(internal)?;
            let data: serde_json::Value = row.try_get("data").map_err(internal)?;
            let fact: Fact = serde_json::from_value(data).map_err(internal)?;
            if let Some(log) = logs.get_mut(&att) {
                log.push(fact);
            }
        }
        Ok(logs.into_values().collect())
    }

    /// See [`crate::store::InMemoryFactStore::run_legacy_migration`].
    async fn run_legacy_migration(
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
        user_id: row.try_get("user_id").map_err(internal)?,
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
}

#[async_trait::async_trait]
impl GrantStore for PgGrantStore {
    /// See [`crate::store::InMemoryGrantStore::create_grant_idemp`].
    async fn create_grant_idemp(
        &self,
        player: &str,
        quest: &str,
        source: GrantSource,
        source_ref: Option<String>,
    ) -> Result<(AccessGrant, bool), AppError> {
        let granted_at = now_rfc3339(); // real audit instant, mirroring the pure helper
        let inserted = sqlx::query(
            "INSERT INTO access_grants (user_id, quest_id, granted_at, source, source_ref)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING
             RETURNING user_id, quest_id, granted_at, source, source_ref",
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
            "SELECT user_id, quest_id, granted_at, source, source_ref
             FROM access_grants WHERE user_id = $1 AND quest_id = $2",
        )
        .bind(player)
        .bind(quest)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        Ok((grant_from_row(&existing)?, false))
    }

    /// See [`crate::store::InMemoryGrantStore::has_grant`].
    async fn has_grant(&self, player: &str, quest: &str) -> Result<bool, AppError> {
        let row =
            sqlx::query("SELECT 1 AS x FROM access_grants WHERE user_id = $1 AND quest_id = $2")
                .bind(player)
                .bind(quest)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal)?;
        Ok(row.is_some())
    }

    /// See [`crate::store::InMemoryGrantStore::list_published`].
    async fn list_published(&self) -> Result<Vec<PublishedMeta>, AppError> {
        let rows = sqlx::query(&format!(
            "SELECT {PUBLISHED_COLS} FROM published_quests ORDER BY quest_id"
        ))
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter().map(published_from_row).collect()
    }

    /// See [`crate::store::InMemoryGrantStore::get_published`].
    async fn get_published(&self, quest_id: &str) -> Result<Option<PublishedMeta>, AppError> {
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
    async fn register_published(
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
    async fn list_all_grants(&self) -> Result<Vec<AccessGrant>, AppError> {
        let rows = sqlx::query(
            "SELECT user_id, quest_id, granted_at, source, source_ref FROM access_grants",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter().map(grant_from_row).collect()
    }

    /// See [`crate::store::InMemoryGrantStore::delete_grants_for_user`].
    async fn delete_grants_for_user(&self, user_id: &str) -> Result<usize, AppError> {
        let res = sqlx::query("DELETE FROM access_grants WHERE user_id = $1")
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(res.rows_affected() as usize)
    }

    /// See [`crate::store::InMemoryGrantStore::buyers_by_quest`].
    async fn buyers_by_quest(&self) -> Result<std::collections::HashMap<String, usize>, AppError> {
        let rows = sqlx::query(
            "SELECT quest_id, COUNT(DISTINCT user_id) AS n FROM access_grants GROUP BY quest_id",
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
    async fn buyers_for_quest(&self, quest_id: &str) -> Result<usize, AppError> {
        let n: i64 = sqlx::query(
            "SELECT COUNT(DISTINCT user_id) AS n FROM access_grants WHERE quest_id = $1",
        )
        .bind(quest_id)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?
        .try_get("n")
        .map_err(internal)?;
        Ok(n.max(0) as usize)
    }

    /// See [`crate::store::InMemoryGrantStore::stats_purchase_events`].
    /// `granted_at` is a canonical RFC3339 UTC string, so lexicographic range
    /// compare IS chronological compare; parsing to seconds happens in Rust via
    /// the same helper the in-memory backend uses.
    async fn stats_purchase_events(
        &self,
        from: i64,
        to_excl: i64,
        quest: Option<&str>,
    ) -> Result<Vec<crate::admin_stats::StatEvent>, AppError> {
        let rows = sqlx::query(
            "SELECT quest_id, granted_at FROM access_grants
             WHERE granted_at >= $1 AND granted_at < $2
               AND ($3::text IS NULL OR quest_id = $3)",
        )
        .bind(crate::store::rfc3339_from_unix(from.max(0) as u64))
        .bind(crate::store::rfc3339_from_unix(to_excl.max(0) as u64))
        .bind(quest)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter()
            .map(|r| {
                let quest_id: String = r.try_get("quest_id").map_err(internal)?;
                let granted_at: String = r.try_get("granted_at").map_err(internal)?;
                // The store only ever writes now_rfc3339; anything unparsable
                // is data corruption and must surface, not silently undercount.
                let at = crate::admin_stats::parse_rfc3339_utc(&granted_at).ok_or_else(|| {
                    AppError::Internal(anyhow::anyhow!(
                        "unparsable access_grants.granted_at: {granted_at:?}"
                    ))
                })?;
                Ok(crate::admin_stats::StatEvent { quest_id, at })
            })
            .collect()
    }

    /// See [`crate::store::InMemoryGrantStore::grants_for_user`].
    async fn grants_for_user(&self, user_id: &str) -> Result<Vec<AccessGrant>, AppError> {
        let rows = sqlx::query(
            "SELECT user_id, quest_id, granted_at, source, source_ref
             FROM access_grants WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter().map(grant_from_row).collect()
    }

    /// Latest published meta + frozen snapshot JSON for the bundle endpoint.
    async fn get_bundle(
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

    /// Frozen snapshot JSON by id — for callers that already hold the meta
    /// (skips the published-row join `get_bundle` would repeat).
    async fn get_snapshot(&self, snapshot_id: &str) -> Result<Option<serde_json::Value>, AppError> {
        let row = sqlx::query("SELECT data FROM snapshots WHERE snapshot_id = $1")
            .bind(snapshot_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        // TWO independent absences collapse into one `None`: no snapshot row at
        // all, and a row whose `data` is NULL (a publish that registered a version
        // without content — `snapshots.data` is nullable). The in-memory store
        // answers `None` for both, so the decode target must be `Option` here;
        // letting it infer the bare value made the second case a 500.
        match row {
            None => Ok(None),
            Some(row) => row
                .try_get::<Option<serde_json::Value>, _>("data")
                .map_err(internal),
        }
    }
}

/// Identity (the `users` + `identities` tables + sessions) on PostgreSQL.
#[derive(Clone, Debug)]
pub struct PgAuthStore {
    pool: PgPool,
}

fn account_from_row(row: &sqlx::postgres::PgRow) -> Result<UserAccount, AppError> {
    let created_at: i64 = row.try_get("created_at").map_err(internal)?;
    let confirmed: Option<i64> = row.try_get("email_confirmed_at").map_err(internal)?;
    Ok(UserAccount {
        user_id: row.try_get("user_id").map_err(internal)?,
        email: row.try_get("email").map_err(internal)?,
        display_name: row.try_get("display_name").map_err(internal)?,
        role: row.try_get("role").map_err(internal)?,
        created_at: created_at as u64,
        email_confirmed_at: confirmed.map(|v| v as u64),
    })
}

/// Credential-view SELECT (account + password secret): the ONE JOIN both
/// `find_by_email` and `user_record` share — they differ only in the WHERE key.
/// A social-only account has no password row → NULL secret (login rejects).
const USER_RECORD_SELECT: &str = "SELECT u.user_id, u.email, u.display_name, u.role, u.created_at, u.email_confirmed_at, \
            i.secret_hash AS password_hash \
     FROM users u \
     LEFT JOIN identities i ON i.method = 'password' AND i.identifier = u.user_id";

fn user_record_from_row(row: &sqlx::postgres::PgRow) -> Result<UserRecord, AppError> {
    Ok(UserRecord {
        password_hash: row.try_get("password_hash").map_err(internal)?,
        account: account_from_row(row)?,
    })
}

/// Identity-list SELECT — never includes `secret_hash` (lists carry no
/// credentials); shared by the single and batched lookups.
const IDENTITY_SELECT: &str =
    "SELECT method, identifier, user_id, handle, created_at FROM identities";

fn identity_from_row(row: &sqlx::postgres::PgRow) -> Result<AuthIdentity, AppError> {
    let created_at: i64 = row.try_get("created_at").map_err(internal)?;
    Ok(AuthIdentity {
        method: row.try_get("method").map_err(internal)?,
        identifier: row.try_get("identifier").map_err(internal)?,
        user_id: row.try_get("user_id").map_err(internal)?,
        handle: row.try_get("handle").map_err(internal)?,
        created_at: created_at.max(0) as u64,
    })
}

/// THE only writer of `password` rows: create-or-replace the secret. The row
/// shape (identifier = user_id, no handle) is stated here once; both
/// `register_user` (inside its transaction) and `set_password` call it.
async fn upsert_password_row<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    user_id: &str,
    password_hash: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO identities (method, identifier, user_id, secret_hash, created_at)
         VALUES ('password', $1, $1, $2, $3)
         ON CONFLICT (method, identifier) DO UPDATE SET secret_hash = EXCLUDED.secret_hash",
    )
    .bind(user_id)
    .bind(password_hash)
    .bind(now_secs() as i64)
    .execute(executor)
    .await
    .map(|_| ())
}

impl PgAuthStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl AuthStore for PgAuthStore {
    /// See [`crate::store::InMemoryAuthStore::register_user`]. One transaction:
    /// the account row plus its `password` identity — a conflicting account
    /// insert (registered user_id or taken email, both DB constraints) affects
    /// zero rows, maps to 409 and rolls back, so no orphan identity can exist.
    async fn register_user(
        &self,
        user_id: &str,
        email: &str,
        password_hash: &str,
        display_name: Option<String>,
    ) -> Result<UserAccount, AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;
        let inserted = sqlx::query(
            "INSERT INTO users (user_id, email, display_name, created_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING
             RETURNING user_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(user_id)
        .bind(email)
        .bind(&display_name)
        .bind(now_secs() as i64)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        let Some(row) = inserted else {
            return Err(AppError::Conflict(
                "player is already registered or email is already taken".into(),
            ));
        };
        upsert_password_row(&mut *tx, user_id, password_hash)
            .await
            .map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        account_from_row(&row)
    }

    /// See [`crate::store::InMemoryAuthStore::find_by_email`] — the credential
    /// view ([`USER_RECORD_SELECT`]) keyed by email.
    async fn find_by_email(&self, email: &str) -> Result<Option<UserRecord>, AppError> {
        let row = sqlx::query(&format!("{USER_RECORD_SELECT} WHERE u.email = $1"))
            .bind(email)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        row.as_ref().map(user_record_from_row).transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::account_for_session`]. Resolves the
    /// session token to its account in ONE round-trip (was `get_session` then
    /// `get_user` — two serial round-trips on the front of every authenticated
    /// request). An anonymous session (no `users` row) yields `None` via the inner
    /// join, exactly like the two-step path.
    async fn account_for_session(&self, token: &str) -> Result<Option<UserAccount>, AppError> {
        let row = sqlx::query(
            "SELECT u.user_id, u.email, u.display_name, u.role, u.created_at, u.email_confirmed_at \
             FROM sessions s JOIN users u ON u.user_id = s.user_id \
             WHERE s.token = $1",
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.as_ref().map(account_from_row).transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::get_user`].
    async fn get_user(&self, user_id: &str) -> Result<Option<UserAccount>, AppError> {
        let row = sqlx::query(
            "SELECT user_id, email, display_name, role, created_at, email_confirmed_at \
             FROM users WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.as_ref().map(account_from_row).transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::get_users_by_ids`]. Batch author
    /// lookup for the product page's review list — ONE round-trip for all the
    /// displayed reviews' authors, replacing a per-review `get_user` N+1.
    async fn get_users_by_ids(
        &self,
        user_ids: &[String],
    ) -> Result<std::collections::HashMap<String, UserAccount>, AppError> {
        if user_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let rows = sqlx::query(
            "SELECT user_id, email, display_name, role, created_at, email_confirmed_at \
             FROM users WHERE user_id = ANY($1)",
        )
        .bind(user_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter()
            .map(|r| {
                let account = account_from_row(r)?;
                Ok((account.user_id.clone(), account))
            })
            .collect()
    }

    /// See [`crate::store::InMemoryAuthStore::set_role`]. An UPDATE touching zero
    /// rows means the id is unregistered → 404 (only accounts have roles).
    async fn set_role(&self, user_id: &str, role: &str) -> Result<UserAccount, AppError> {
        let row = sqlx::query(
            "UPDATE users SET role = $2 WHERE user_id = $1 \
             RETURNING user_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(user_id)
        .bind(role)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match row {
            Some(r) => account_from_row(&r),
            None => Err(crate::store::no_account(user_id)),
        }
    }

    /// See [`crate::store::InMemoryAuthStore::list_users`]. Newest-first via the
    /// created_at index; ties broken by user_id for a stable order.
    async fn list_users(&self) -> Result<Vec<UserAccount>, AppError> {
        let rows = sqlx::query(
            "SELECT user_id, email, display_name, role, created_at, email_confirmed_at \
             FROM users ORDER BY created_at DESC, user_id ASC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter().map(account_from_row).collect()
    }

    /// See [`crate::store::InMemoryAuthStore::create_session`].
    async fn create_session(&self, token: &str, user_id: &str) -> Result<(), AppError> {
        sqlx::query("INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)")
            .bind(token)
            .bind(user_id)
            .bind(now_secs() as i64)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryAuthStore::set_display_name`].
    async fn set_display_name(
        &self,
        user_id: &str,
        display_name: Option<String>,
    ) -> Result<UserAccount, AppError> {
        let row = sqlx::query(
            "UPDATE users SET display_name = $2 WHERE user_id = $1
             RETURNING user_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(user_id)
        .bind(&display_name)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match row {
            Some(r) => account_from_row(&r),
            None => Err(crate::store::no_account(user_id)),
        }
    }

    /// See [`crate::store::InMemoryAuthStore::set_password`]: upsert the
    /// `password` identity row. An unknown user_id trips the FK → 404 (parity
    /// with the in-memory account check).
    async fn set_password(&self, user_id: &str, password_hash: &str) -> Result<(), AppError> {
        upsert_password_row(&self.pool, user_id, password_hash)
            .await
            .map_err(|e| match e {
                sqlx::Error::Database(db) if db.is_foreign_key_violation() => {
                    crate::store::no_account(user_id)
                }
                other => internal(other),
            })
    }

    /// See [`crate::store::InMemoryAuthStore::user_record`] — the credential
    /// view ([`USER_RECORD_SELECT`]) keyed by user id.
    async fn user_record(&self, user_id: &str) -> Result<Option<UserRecord>, AppError> {
        let row = sqlx::query(&format!("{USER_RECORD_SELECT} WHERE u.user_id = $1"))
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        row.as_ref().map(user_record_from_row).transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::confirm_email`].
    async fn confirm_email(&self, user_id: &str, at: u64) -> Result<UserAccount, AppError> {
        let row = sqlx::query(
            "UPDATE users SET email_confirmed_at = COALESCE(email_confirmed_at, $2)
             WHERE user_id = $1
             RETURNING user_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(user_id)
        .bind(at as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        match row {
            Some(r) => account_from_row(&r),
            None => Err(crate::store::no_account(user_id)),
        }
    }

    /// See [`crate::store::InMemoryAuthStore::create_auth_token`] — latest
    /// mail wins: issuing deletes prior unused tokens of the same kind in the
    /// same transaction.
    async fn create_auth_token(
        &self,
        token_hash: &str,
        rec: crate::store::AuthTokenRecord,
    ) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query("DELETE FROM auth_tokens WHERE user_id = $1 AND kind = $2 AND used_at IS NULL")
            .bind(&rec.user_id)
            .bind(&rec.kind)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query(
            "INSERT INTO auth_tokens (token_hash, user_id, kind, code_hash, expires_at, used_at, attempts)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(token_hash)
        .bind(&rec.user_id)
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
    async fn consume_auth_token(
        &self,
        token_hash: &str,
        kind: &str,
        now: u64,
    ) -> Result<Option<String>, AppError> {
        let row = sqlx::query(
            "UPDATE auth_tokens SET used_at = $3
             WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at >= $3
             RETURNING user_id",
        )
        .bind(token_hash)
        .bind(kind)
        .bind(now as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(|r| r.try_get::<String, _>("user_id").map_err(internal))
            .transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::consume_auth_token_by_code`].
    /// The attempt is spent atomically (the guarded UPDATE), then a code_hash
    /// match consumes via a second used_at-guarded UPDATE — concurrent correct
    /// codes race safely, exactly one wins.
    async fn consume_auth_token_by_code(
        &self,
        user_id: &str,
        kind: &str,
        code_hash: &str,
        now: u64,
    ) -> Result<Option<String>, AppError> {
        let row = sqlx::query(
            "UPDATE auth_tokens SET attempts = attempts + 1
             WHERE user_id = $1 AND kind = $2 AND used_at IS NULL
               AND expires_at >= $3 AND attempts < $4
             RETURNING token_hash, code_hash",
        )
        .bind(user_id)
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
             RETURNING user_id",
        )
        .bind(&token_hash)
        .bind(now as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        won.map(|r| r.try_get::<String, _>("user_id").map_err(internal))
            .transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::delete_user`] — user row,
    /// sessions and tokens in one transaction.
    async fn delete_user(&self, user_id: &str) -> Result<bool, AppError> {
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query("DELETE FROM sessions WHERE user_id = $1")
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query("DELETE FROM auth_tokens WHERE user_id = $1")
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        let res = sqlx::query("DELETE FROM users WHERE user_id = $1")
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        Ok(res.rows_affected() > 0)
    }

    /// See [`crate::store::InMemoryAuthStore::get_session`].
    async fn get_session(&self, token: &str) -> Result<Option<String>, AppError> {
        let row = sqlx::query("SELECT user_id FROM sessions WHERE token = $1")
            .bind(token)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        row.map(|r| r.try_get("user_id").map_err(internal))
            .transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::find_identity`].
    async fn find_identity(
        &self,
        method: &str,
        identifier: &str,
    ) -> Result<Option<String>, AppError> {
        let row =
            sqlx::query("SELECT user_id FROM identities WHERE method = $1 AND identifier = $2")
                .bind(method)
                .bind(identifier)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal)?;
        row.map(|r| r.try_get("user_id").map_err(internal))
            .transpose()
    }

    /// See [`crate::store::InMemoryAuthStore::create_identity`]. A plain
    /// INSERT so the violated CONSTRAINT NAME says which invariant fired —
    /// the `(method, identifier)` PK vs `identities_one_per_method` — and the
    /// store reports it typed instead of forcing the caller to reconstruct
    /// the cause from current state.
    async fn create_identity(&self, identity: AuthIdentity) -> Result<(), AppError> {
        crate::auth::validate_provider(&identity.method)?;
        sqlx::query(
            "INSERT INTO identities (method, identifier, user_id, handle, created_at)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&identity.method)
        .bind(&identity.identifier)
        .bind(&identity.user_id)
        .bind(&identity.handle)
        .bind(identity.created_at as i64)
        .execute(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.is_unique_violation() => {
                if db.constraint() == Some("identities_one_per_method") {
                    AppError::Conflict(crate::store::CONFLICT_METHOD_TAKEN.into())
                } else {
                    AppError::Conflict(crate::store::CONFLICT_IDENTITY_TAKEN.into())
                }
            }
            other => internal(other),
        })?;
        Ok(())
    }

    /// See [`crate::store::InMemoryAuthStore::set_identity_handle`]. Overwrites only
    /// when a value is present; an absent claim leaves the stored handle untouched.
    async fn set_identity_handle(
        &self,
        method: &str,
        identifier: &str,
        handle: Option<String>,
    ) -> Result<(), AppError> {
        let Some(handle) = handle else {
            return Ok(());
        };
        sqlx::query("UPDATE identities SET handle = $3 WHERE method = $1 AND identifier = $2")
            .bind(method)
            .bind(identifier)
            .bind(&handle)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryAuthStore::identities_for_user`]
    /// ([`IDENTITY_SELECT`] — no credentials in list shapes).
    async fn identities_for_user(&self, user_id: &str) -> Result<Vec<AuthIdentity>, AppError> {
        let rows = sqlx::query(&format!(
            "{IDENTITY_SELECT} WHERE user_id = $1 ORDER BY method ASC"
        ))
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter().map(identity_from_row).collect()
    }

    /// See [`crate::store::InMemoryAuthStore::identities_for_users`]. One
    /// `= ANY($1)` scan for the whole batch (admin identity resolution, no N+1).
    async fn identities_for_users(
        &self,
        user_ids: &[String],
    ) -> Result<std::collections::HashMap<String, Vec<AuthIdentity>>, AppError> {
        let rows = sqlx::query(&format!(
            "{IDENTITY_SELECT} WHERE user_id = ANY($1) ORDER BY method ASC"
        ))
        .bind(user_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        let mut out: std::collections::HashMap<String, Vec<AuthIdentity>> =
            std::collections::HashMap::new();
        for r in &rows {
            let identity = identity_from_row(r)?;
            out.entry(identity.user_id.clone())
                .or_default()
                .push(identity);
        }
        Ok(out)
    }

    /// See [`crate::store::InMemoryAuthStore::delete_identity`] (social-only,
    /// enforced here — the password row is never unlinked).
    async fn delete_identity(&self, method: &str, user_id: &str) -> Result<bool, AppError> {
        crate::auth::validate_provider(method)?;
        let res = sqlx::query("DELETE FROM identities WHERE method = $1 AND user_id = $2")
            .bind(method)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(res.rows_affected() > 0)
    }

    /// See [`crate::store::InMemoryAuthStore::create_social_account`]. No
    /// password row is created; a taken user_id or email is absorbed as 409.
    async fn create_social_account(
        &self,
        user_id: &str,
        email: Option<String>,
        display_name: Option<String>,
        email_confirmed_at: Option<u64>,
    ) -> Result<UserAccount, AppError> {
        let inserted = sqlx::query(
            "INSERT INTO users (user_id, email, display_name, created_at, email_confirmed_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING
             RETURNING user_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(user_id)
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
    async fn attach_email(
        &self,
        user_id: &str,
        email: &str,
        confirmed_at: u64,
    ) -> Result<UserAccount, AppError> {
        let updated = sqlx::query(
            "UPDATE users SET email = $2, email_confirmed_at = COALESCE(email_confirmed_at, $3) \
             WHERE user_id = $1 AND email IS NULL \
             RETURNING user_id, email, display_name, role, created_at, email_confirmed_at",
        )
        .bind(user_id)
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
                .get_user(user_id)
                .await?
                .ok_or_else(|| crate::store::no_account(user_id)),
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
        attrs: QuestAttributes {
            complexity: row.try_get("complexity").map_err(internal)?,
            age_target: row.try_get("age_target").map_err(internal)?,
            tags: row.try_get("tags").map_err(internal)?,
        },
        created_at: created_at.max(0) as u64,
        updated_at: updated_at.max(0) as u64,
    })
}

/// Columns selected for a summary row (kept in one place so list/save/status
/// agree). Deliberately EXCLUDES the heavy `cover` (base64 image) and `body`:
/// the dashboard list never renders them, so reading the TOASTed cover for every
/// row was the cause of the multi-second list load. GET-one adds `cover`/`body`
/// back explicitly because the builder needs the full entity.
const CTOR_SUMMARY_COLS: &str = "quest_id, author_id, author_name, name, status, steps_count, \
     complexity, age_target, tags, created_at, updated_at";

impl PgConstructorStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
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

    /// Label rows, optionally narrowed to one quest. Shared by the full scan and
    /// the targeted read — same projection, only the `WHERE` differs (the
    /// [`Self::fetch_summaries`] pattern).
    ///
    /// `city` is extracted from the body IN THE DATABASE, so one short value per
    /// row crosses the wire instead of the whole authoring body (megabytes for a
    /// media-heavy quest).
    ///
    /// SQL navigates to `meta.city` and stops; it deliberately does NOT decide
    /// what counts as a city. The raw jsonb comes back and the same Rust rules
    /// that serve the in-memory store apply — `as_str()` (only a JSON *string* is
    /// a city) then [`QuestLabel::from_authored`] (trim, blank becomes absent).
    /// Mirroring those rules in SQL would be a second definition free to drift.
    async fn fetch_labels(
        &self,
        quest_id: Option<&str>,
    ) -> Result<Vec<(String, QuestLabel)>, AppError> {
        let where_clause = if quest_id.is_some() {
            "WHERE quest_id = $1 "
        } else {
            ""
        };
        let sql = format!(
            "SELECT quest_id, name, body -> 'meta' -> 'city' AS city \
             FROM constructor_quests {where_clause}"
        );
        let mut query = sqlx::query(&sql);
        if let Some(quest_id) = quest_id {
            query = query.bind(quest_id);
        }
        let rows = query.fetch_all(&self.pool).await.map_err(internal)?;
        rows.iter()
            .map(|row| {
                let quest_id: String = row.try_get("quest_id").map_err(internal)?;
                let name: String = row.try_get("name").map_err(internal)?;
                let city: Option<serde_json::Value> = row.try_get("city").map_err(internal)?;
                let city = city.as_ref().and_then(serde_json::Value::as_str);
                Ok((quest_id, QuestLabel::from_authored(name, city)))
            })
            .collect()
    }
}

#[async_trait::async_trait]
impl ConstructorStore for PgConstructorStore {
    /// See [`crate::store::InMemoryConstructorStore::create`]. A conflicting id
    /// affects zero rows (ON CONFLICT DO NOTHING) and maps to 409.
    async fn create(&self, quest: ConstructorQuest) -> Result<ConstructorQuestSummary, AppError> {
        let inserted = sqlx::query(
            "INSERT INTO constructor_quests
                (quest_id, author_id, author_name, name, status, cover, steps_count,
                 complexity, age_target, tags, body, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        .bind(&quest.attrs.complexity)
        .bind(&quest.attrs.age_target)
        .bind(&quest.attrs.tags)
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

    /// See [`crate::store::InMemoryConstructorStore::list_summaries_for_author`].
    /// Scoped by `author_id` (the `idx_ctor_quests_author` index serves this) so the
    /// dashboard can never return another author's quests.
    async fn list_summaries_for_author(
        &self,
        author_id: &str,
    ) -> Result<Vec<ConstructorQuestSummary>, AppError> {
        self.fetch_summaries(Some(author_id)).await
    }

    /// See [`crate::store::InMemoryConstructorStore::summary_for_quest`]. Selects
    /// the SAME columns as the list — no `body`, no `cover` — so authorizing or
    /// identifying one quest never drags a TOASTed authoring body over the wire.
    async fn summary_for_quest(
        &self,
        quest_id: &str,
    ) -> Result<Option<ConstructorQuestSummary>, AppError> {
        let sql = format!("SELECT {CTOR_SUMMARY_COLS} FROM constructor_quests WHERE quest_id = $1");
        let row = sqlx::query(&sql)
            .bind(quest_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        row.as_ref().map(ctor_summary_from_row).transpose()
    }

    /// See [`crate::store::InMemoryConstructorStore::get`].
    async fn get(&self, quest_id: &str) -> Result<Option<ConstructorQuest>, AppError> {
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
                    attrs: s.attrs,
                    created_at: s.created_at,
                    updated_at: s.updated_at,
                    body,
                }))
            }
        }
    }

    /// See [`crate::store::InMemoryConstructorStore::save_body`]. Zero rows updated
    /// means the id is unknown → 404.
    #[allow(clippy::too_many_arguments)] // autosave payload; pre-existing shape
    async fn save_body(
        &self,
        quest_id: &str,
        name: &str,
        cover: Option<String>,
        steps_count: u32,
        attrs: QuestAttributes,
        body: serde_json::Value,
        updated_at: u64,
    ) -> Result<ConstructorQuestSummary, AppError> {
        let sql = format!(
            "UPDATE constructor_quests \
             SET name = $2, cover = $3, steps_count = $4, complexity = $5, age_target = $6, \
                 tags = $7, body = $8, updated_at = $9 \
             WHERE quest_id = $1 RETURNING {CTOR_SUMMARY_COLS}"
        );
        let row = sqlx::query(&sql)
            .bind(quest_id)
            .bind(name)
            .bind(&cover)
            .bind(steps_count as i32)
            .bind(&attrs.complexity)
            .bind(&attrs.age_target)
            .bind(&attrs.tags)
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
    async fn set_status(
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
    async fn list_all_summaries(&self) -> Result<Vec<ConstructorQuestSummary>, AppError> {
        self.fetch_summaries(None).await
    }

    /// See [`crate::store::InMemoryConstructorStore::listings_by_quest`]. A single
    /// lightweight scan (status + attributes) backing the store-catalog filter
    /// and the store-page attribute filters.
    async fn listings_by_quest(
        &self,
    ) -> Result<std::collections::HashMap<String, CatalogListing>, AppError> {
        let rows = sqlx::query(
            "SELECT quest_id, status, complexity, age_target, tags FROM constructor_quests",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let quest_id: String = row.try_get("quest_id").map_err(internal)?;
            out.insert(
                quest_id,
                CatalogListing {
                    status: row.try_get("status").map_err(internal)?,
                    attrs: QuestAttributes {
                        complexity: row.try_get("complexity").map_err(internal)?,
                        age_target: row.try_get("age_target").map_err(internal)?,
                        tags: row.try_get("tags").map_err(internal)?,
                    },
                },
            );
        }
        Ok(out)
    }

    /// See [`crate::store::InMemoryConstructorStore::labels_by_quest`].
    async fn labels_by_quest(
        &self,
    ) -> Result<std::collections::HashMap<String, QuestLabel>, AppError> {
        Ok(self.fetch_labels(None).await?.into_iter().collect())
    }

    /// See [`crate::store::InMemoryConstructorStore::label_for_quest`]. Served by
    /// the primary key — never a scan to name one quest.
    async fn label_for_quest(&self, quest_id: &str) -> Result<Option<QuestLabel>, AppError> {
        Ok(self
            .fetch_labels(Some(quest_id))
            .await?
            .pop()
            .map(|(_, label)| label))
    }

    /// See [`crate::store::InMemoryConstructorStore::delete`].
    async fn delete(&self, quest_id: &str) -> Result<bool, AppError> {
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
        user_id: row.try_get("user_id").map_err(internal)?,
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
}

#[async_trait::async_trait]
impl CouponStore for PgCouponStore {
    /// See [`crate::store::InMemoryCouponStore::create`].
    async fn create(&self, coupon: Coupon) -> Result<Coupon, AppError> {
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
    async fn update(&self, coupon: Coupon) -> Result<Coupon, AppError> {
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
    async fn get(&self, coupon_id: &str) -> Result<Option<Coupon>, AppError> {
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
    async fn delete(&self, coupon_id: &str) -> Result<(), AppError> {
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
    async fn list_with_usage(&self) -> Result<Vec<(Coupon, CouponUsage)>, AppError> {
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
    async fn get_with_usage(
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
    async fn preview(
        &self,
        code: &str,
        user_id: &str,
    ) -> Result<Option<(Coupon, u32, u32)>, AppError> {
        let row = sqlx::query(&format!(
            "SELECT {COUPON_COLS},
                    (SELECT COUNT(*) FROM coupon_redemptions r
                      WHERE r.coupon_id = c.coupon_id) AS used_total,
                    (SELECT COUNT(*) FROM coupon_redemptions r
                      WHERE r.coupon_id = c.coupon_id AND r.user_id = $2) AS used_by_player
             FROM coupons c WHERE c.code = $1"
        ))
        .bind(code)
        .bind(user_id)
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
    async fn redeem(
        &self,
        code: &str,
        user_id: &str,
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
            "SELECT coupon_id, user_id, quest_id, amount_discounted, redeemed_at
             FROM coupon_redemptions
             WHERE coupon_id = $1 AND user_id = $2 AND quest_id = $3",
        )
        .bind(&coupon.coupon_id)
        .bind(user_id)
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
                    COUNT(*) FILTER (WHERE user_id = $2) AS used_by_player
             FROM coupon_redemptions WHERE coupon_id = $1",
        )
        .bind(&coupon.coupon_id)
        .bind(user_id)
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
            user_id: user_id.to_string(),
            quest_id: quest_id.to_string(),
            amount_discounted: crate::coupons::discount_amount(&coupon.discount, price),
            redeemed_at: now,
        };
        sqlx::query(
            "INSERT INTO coupon_redemptions
                 (coupon_id, user_id, quest_id, amount_discounted, redeemed_at)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&redemption.coupon_id)
        .bind(&redemption.user_id)
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

/// Pending redirect payments (YooKassa) on PostgreSQL.
#[derive(Clone, Debug)]
pub struct PgPaymentStore {
    pool: PgPool,
}

const PAYMENT_COLS: &str = "id, provider_payment_id, user_id, quest_id, coupon_code, \
                            amount, price, confirmation_url, status, created_at";

fn payment_from_row(row: &sqlx::postgres::PgRow) -> Result<PendingPayment, AppError> {
    let status: String = row.try_get("status").map_err(internal)?;
    Ok(PendingPayment {
        id: row.try_get("id").map_err(internal)?,
        provider_payment_id: row.try_get("provider_payment_id").map_err(internal)?,
        user_id: row.try_get("user_id").map_err(internal)?,
        quest_id: row.try_get("quest_id").map_err(internal)?,
        coupon_code: row.try_get("coupon_code").map_err(internal)?,
        amount: row.try_get("amount").map_err(internal)?,
        price: row.try_get("price").map_err(internal)?,
        confirmation_url: row.try_get("confirmation_url").map_err(internal)?,
        status: PendingStatus::parse(&status).ok_or_else(|| {
            AppError::Internal(anyhow::anyhow!("unknown payment status in db: {status}"))
        })?,
        created_at: row.try_get("created_at").map_err(internal)?,
    })
}

impl PgPaymentStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl PaymentStore for PgPaymentStore {
    /// See [`crate::store::InMemoryPaymentStore::insert`].
    async fn insert(&self, p: PendingPayment) -> Result<(), AppError> {
        sqlx::query(&format!(
            "INSERT INTO pending_payments ({PAYMENT_COLS})
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"
        ))
        .bind(&p.id)
        .bind(&p.provider_payment_id)
        .bind(&p.user_id)
        .bind(&p.quest_id)
        .bind(&p.coupon_code)
        .bind(p.amount)
        .bind(p.price)
        .bind(&p.confirmation_url)
        .bind(p.status.as_str())
        .bind(&p.created_at)
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryPaymentStore::get`].
    async fn get(&self, id: &str) -> Result<Option<PendingPayment>, AppError> {
        sqlx::query(&format!(
            "SELECT {PAYMENT_COLS} FROM pending_payments WHERE id = $1"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?
        .as_ref()
        .map(payment_from_row)
        .transpose()
    }

    /// See [`crate::store::InMemoryPaymentStore::find_by_provider_id`].
    async fn find_by_provider_id(
        &self,
        provider_payment_id: &str,
    ) -> Result<Option<PendingPayment>, AppError> {
        sqlx::query(&format!(
            "SELECT {PAYMENT_COLS} FROM pending_payments WHERE provider_payment_id = $1"
        ))
        .bind(provider_payment_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?
        .as_ref()
        .map(payment_from_row)
        .transpose()
    }

    /// See [`crate::store::InMemoryPaymentStore::find_pending_for`].
    async fn find_pending_for(
        &self,
        user_id: &str,
        quest_id: &str,
    ) -> Result<Option<PendingPayment>, AppError> {
        sqlx::query(&format!(
            "SELECT {PAYMENT_COLS} FROM pending_payments
             WHERE user_id = $1 AND quest_id = $2 AND status = 'pending'
             LIMIT 1"
        ))
        .bind(user_id)
        .bind(quest_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?
        .as_ref()
        .map(payment_from_row)
        .transpose()
    }

    /// See [`crate::store::InMemoryPaymentStore::settle_succeeded`]. The CAS is
    /// the WHERE clause: one row updated == this call won the transition.
    async fn settle_succeeded(&self, id: &str) -> Result<bool, AppError> {
        let res = sqlx::query(
            "UPDATE pending_payments SET status = 'succeeded'
             WHERE id = $1 AND status = 'pending'",
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(res.rows_affected() == 1)
    }

    /// See [`crate::store::InMemoryPaymentStore::mark_canceled`].
    async fn mark_canceled(&self, id: &str) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE pending_payments SET status = 'canceled'
             WHERE id = $1 AND status = 'pending'",
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(())
    }
}

/// Feature-toggle overrides on PostgreSQL (`feature_overrides`, migration 0012).
#[derive(Clone, Debug)]
pub struct PgFlagStore {
    pool: PgPool,
}

impl PgFlagStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl KvStore<bool> for PgFlagStore {
    /// See [`crate::store::InMemoryFlagStore::get`].
    async fn get(&self, key: &str) -> Result<Option<bool>, AppError> {
        let row = sqlx::query("SELECT enabled FROM feature_overrides WHERE key = $1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        row.map(|r| r.try_get("enabled").map_err(internal))
            .transpose()
    }

    /// See [`crate::store::InMemoryFlagStore::set`].
    async fn set(&self, key: &str, enabled: bool) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO feature_overrides (key, enabled, updated_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE
             SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at",
        )
        .bind(key)
        .bind(enabled)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryFlagStore::clear`].
    async fn clear(&self, key: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM feature_overrides WHERE key = $1")
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl FlagStore for PgFlagStore {
    /// See [`crate::store::InMemoryFlagStore::all`] — one SELECT, whole table.
    async fn all(&self) -> Result<std::collections::HashMap<String, bool>, AppError> {
        let rows = sqlx::query("SELECT key, enabled FROM feature_overrides")
            .fetch_all(&self.pool)
            .await
            .map_err(internal)?;
        rows.iter()
            .map(|r| {
                Ok((
                    r.try_get("key").map_err(internal)?,
                    r.try_get("enabled").map_err(internal)?,
                ))
            })
            .collect()
    }
}

/// Runtime setting values on PostgreSQL (`app_settings`, migration 0017).
#[derive(Clone, Debug)]
pub struct PgSettingsStore {
    pool: PgPool,
}

impl PgSettingsStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl KvStore<String> for PgSettingsStore {
    /// See [`crate::store::InMemorySettingsStore::get`].
    async fn get(&self, key: &str) -> Result<Option<String>, AppError> {
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)
    }

    /// See [`crate::store::InMemorySettingsStore::set`].
    async fn set(&self, key: &str, value: String) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO app_settings (key, value, updated_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
        )
        .bind(key)
        .bind(value)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemorySettingsStore::clear`].
    async fn clear(&self, key: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM app_settings WHERE key = $1")
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(())
    }
}

/// PostgreSQL moderation overlay — the durable mirror of
/// [`crate::store::InMemoryModerationStore`] (content-moderation). Two tables that are
/// entirely separate from the immutable `facts` log.
#[derive(Clone, Debug)]
pub struct PgModerationStore {
    pool: PgPool,
}

impl PgModerationStore {
    /// Wrap an existing pool (migrations are run by the caller at startup).
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl ModerationStore for PgModerationStore {
    /// See [`crate::store::InMemoryModerationStore::hide_review`] — idempotent.
    async fn hide_review(
        &self,
        player: &str,
        quest: &str,
        at: u64,
        by: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO hidden_reviews (user_id, quest_id, hidden_at, hidden_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, quest_id) DO NOTHING",
        )
        .bind(player)
        .bind(quest)
        .bind(at as i64)
        .bind(by)
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryModerationStore::unhide_review`] — idempotent.
    async fn unhide_review(&self, player: &str, quest: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM hidden_reviews WHERE user_id = $1 AND quest_id = $2")
            .bind(player)
            .bind(quest)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryModerationStore::hidden_review_keys`].
    async fn hidden_review_keys(
        &self,
    ) -> Result<std::collections::HashSet<(String, String)>, AppError> {
        let rows = sqlx::query("SELECT user_id, quest_id FROM hidden_reviews")
            .fetch_all(&self.pool)
            .await
            .map_err(internal)?;
        rows.iter()
            .map(|r| {
                Ok((
                    r.try_get("user_id").map_err(internal)?,
                    r.try_get("quest_id").map_err(internal)?,
                ))
            })
            .collect()
    }

    /// See [`crate::store::InMemoryModerationStore::resolve_feedback`] — upsert.
    async fn resolve_feedback(
        &self,
        quest: &str,
        snap: &str,
        step: i32,
        acknowledged: u64,
        by: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO resolved_feedback
                 (quest_id, snapshot_id, step_position, acknowledged, resolved_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (quest_id, snapshot_id, step_position) DO UPDATE
             SET acknowledged = EXCLUDED.acknowledged, resolved_by = EXCLUDED.resolved_by",
        )
        .bind(quest)
        .bind(snap)
        .bind(step)
        .bind(acknowledged as i64)
        .bind(by)
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryModerationStore::reopen_feedback`] — idempotent.
    async fn reopen_feedback(&self, quest: &str, snap: &str, step: i32) -> Result<(), AppError> {
        sqlx::query(
            "DELETE FROM resolved_feedback
             WHERE quest_id = $1 AND snapshot_id = $2 AND step_position = $3",
        )
        .bind(quest)
        .bind(snap)
        .bind(step)
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(())
    }

    /// See [`crate::store::InMemoryModerationStore::feedback_resolutions`].
    async fn feedback_resolutions(
        &self,
    ) -> Result<std::collections::HashMap<(String, String, i32), u64>, AppError> {
        let rows = sqlx::query(
            "SELECT quest_id, snapshot_id, step_position, acknowledged FROM resolved_feedback",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter()
            .map(|r| {
                let quest: String = r.try_get("quest_id").map_err(internal)?;
                let snap: String = r.try_get("snapshot_id").map_err(internal)?;
                let step: i32 = r.try_get("step_position").map_err(internal)?;
                let acknowledged: i64 = r.try_get("acknowledged").map_err(internal)?;
                Ok(((quest, snap, step), acknowledged.max(0) as u64))
            })
            .collect()
    }
}
