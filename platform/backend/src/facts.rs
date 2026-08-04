//! Facts domain: the append-only event vocabulary plus pure deterministic projectors.
//!
//! Wire format matches the TypeScript shared model exactly: a flat object tagged by
//! `"type"` in snake_case. There are NO correction fact types — per SPEC, negative
//! balance is a legal persistent state and sync corrections are client-side
//! projection diffs, never stored facts.
//!
//! Projector outputs MUST match the client folds for identical input; the shared
//! fixtures in `../goldens/parity/` are executed by both this crate's tests and the
//! frontend vitest suite (spec: parity-goldens).

use serde::{Deserialize, Serialize};

/// Discriminator for a [`Fact`]. Serialized as the `"type"` field in snake_case,
/// e.g. `"gift_claimed"` — identical to the TS union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactKind {
    /// Physical step confirmed by the player (advance-on-confirm steps).
    PhysicalConfirmed,
    /// Answer submitted; `local_is_correct` carries the client's matcher verdict.
    AnswerSubmitted,
    /// Per-step gift claimed (coins frozen in the snapshot).
    GiftClaimed,
    /// Hint purchased after wrong answers (cost frozen; balance may go negative).
    HintPurchased,
    /// Canonical +5 completion bonus, first completion per (player, quest).
    CompletionBonus,
    /// Terminal step reached; the attempt is complete.
    AttemptCompleted,
    /// «Сообщить об ошибке» report, attached to the current step.
    FeedbackReported,
    /// Navigator handoff to the system maps app.
    NavigatorUsed,
    /// Optional finale rating (1–5) in `submitted_value`; routed to the author.
    /// coins_delta is always 0 — a projection no-op for balance/state.
    QuestRated,
}

/// One immutable player event. All kinds share the same shape (the discriminator
/// is data, not structure), mirroring the TS `Fact` interface field for field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fact {
    #[serde(rename = "type")]
    pub kind: FactKind,
    pub step_position: i32,
    #[serde(default)]
    pub submitted_value: Option<String>,
    pub local_is_correct: bool,
    /// Signed coin delta frozen at emit time (gifts/bonus positive, hints negative).
    pub coins_delta: i32,
    #[serde(default)]
    pub note: Option<String>,
    /// Originating device; recorded for audit/analytics, NOT part of the dedup key.
    pub device_id: String,
}

/// Device-agnostic natural key for idempotent dedup: the same semantic event
/// arriving from two devices is one fact, never two (no double rewards on
/// multi-device union). device_id is deliberately excluded.
pub type NaturalKey = (FactKind, i32, Option<String>, i32, Option<String>);

/// Returns the natural key of a fact (see [`NaturalKey`]).
pub fn natural_key(f: &Fact) -> NaturalKey {
    (
        f.kind,
        f.step_position,
        f.submitted_value.clone(),
        f.coins_delta,
        f.note.clone(),
    )
}

/// True if `a` and `b` are the same semantic claim (natural keys equal).
pub fn semantically_same(a: &Fact, b: &Fact) -> bool {
    natural_key(a) == natural_key(b)
}

/// Deterministic balance projection: plain signed sum of `coins_delta`.
/// MAY be negative and stays negative — no clamping anywhere (SPEC invariant).
/// Mirrors the client `projectBalance` exactly.
pub fn project_balance(facts: &[Fact]) -> i32 {
    facts.iter().map(|f| f.coins_delta).sum()
}

/// Projected attempt state (mirrors the client `ProjectedState`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectedState {
    pub completed_steps: Vec<i32>,
    pub balance: i32,
    pub revealed_hints: Vec<i32>,
}

/// Deterministic state projection mirroring the client `projectState` exactly.
///
/// A step is completed by `physical_confirmed`, `attempt_completed`, or a CORRECT
/// `answer_submitted` — wrong answers never complete a step (otherwise the
/// attempt-advance offer would fire off a miss). `hint_purchased` reveals its
/// step permanently. Sets are unique + sorted; fact order does not matter.
pub fn project_state(facts: &[Fact]) -> ProjectedState {
    let mut completed_steps: Vec<i32> = Vec::new();
    let mut revealed_hints: Vec<i32> = Vec::new();
    for f in facts {
        match f.kind {
            FactKind::PhysicalConfirmed | FactKind::AttemptCompleted => {
                completed_steps.push(f.step_position);
            }
            FactKind::AnswerSubmitted if f.local_is_correct => {
                completed_steps.push(f.step_position);
            }
            FactKind::HintPurchased => revealed_hints.push(f.step_position),
            _ => {}
        }
    }
    completed_steps.sort_unstable();
    completed_steps.dedup();
    revealed_hints.sort_unstable();
    revealed_hints.dedup();
    ProjectedState {
        completed_steps,
        balance: project_balance(facts),
        revealed_hints,
    }
}

/// Aggregate counters over a fact log (admin visibility).
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct Analytics {
    pub hints_used: usize,
    pub wrongs_submitted: usize,
    pub navigator_clicks: usize,
    pub feedback_count: usize,
}

/// Deterministic analytics fold. Wrongs count only `answer_submitted` facts where
/// the client claimed `local_is_correct == false`.
pub fn project_analytics(facts: &[Fact]) -> Analytics {
    let mut a = Analytics::default();
    for f in facts {
        match f.kind {
            FactKind::HintPurchased => a.hints_used += 1,
            FactKind::AnswerSubmitted if !f.local_is_correct => a.wrongs_submitted += 1,
            FactKind::NavigatorUsed => a.navigator_clicks += 1,
            FactKind::FeedbackReported => a.feedback_count += 1,
            _ => {}
        }
    }
    a
}

/// Cross-attempt statistics for one player (profile tiles). Balance is the same
/// plain signed fold as everywhere else — it MAY be negative; the display floor
/// for "rating" is client-side only (SPEC).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "PlayerStats"))]
pub struct PlayerStats {
    pub balance: i32,
    #[cfg_attr(test, ts(type = "number"))]
    pub quests_completed: usize,
    pub completed_quest_ids: Vec<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub attempts_count: usize,
    #[cfg_attr(test, ts(type = "number"))]
    pub grants_count: usize,
}

/// Pure player-stats fold over `(quest_id, attempt fact log)` pairs — one pair
/// per attempt. A quest counts completed when ANY of its attempts holds an
/// `attempt_completed` fact. Deterministic and order-independent (the completed
/// list is sorted); storage backends only gather logs, never fold in SQL.
pub fn project_player_stats(
    attempt_logs: &[(String, Vec<Fact>)],
    grants_count: usize,
) -> PlayerStats {
    let mut balance = 0i32;
    let mut completed: Vec<String> = Vec::new();
    for (quest_id, log) in attempt_logs {
        balance += project_balance(log);
        if log.iter().any(|f| f.kind == FactKind::AttemptCompleted) && !completed.contains(quest_id)
        {
            completed.push(quest_id.clone());
        }
    }
    completed.sort();
    PlayerStats {
        balance,
        quests_completed: completed.len(),
        completed_quest_ids: completed,
        attempts_count: attempt_logs.len(),
        grants_count,
    }
}

/// Per-step aggregates within a version's stats.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct StepStats {
    pub wrongs: usize,
    pub hints: usize,
    pub nav: usize,
    pub feedbacks: usize,
}

/// Per-version (per-snapshot) stats for admin visibility.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PerVersionStats {
    pub grants_count: usize,
    pub attempts_count: usize,
    pub completions_count: usize,
    pub completion_rate: f64,
    pub per_step: std::collections::HashMap<i32, StepStats>,
    pub hints_used: usize,
    pub wrongs_submitted: usize,
    pub navigator_clicks: usize,
    pub feedback_count: usize,
    /// Number of attempts that left a finale rating (one rating per attempt:
    /// the last `quest_rated` fact wins, matching the client `latestRating`).
    pub rating_count: usize,
    /// Mean of those ratings (1–5), or 0.0 when no attempt has rated yet. This is
    /// the author-facing signal surfaced through the admin version-stats endpoint.
    pub rating_avg: f64,
}

/// Parse a `quest_rated` fact's 1–5 score from its `submitted_value`.
fn parse_rating(f: &Fact) -> Option<i64> {
    f.submitted_value
        .as_deref()
        .and_then(|s| s.trim().parse().ok())
}

/// Aggregate ONE rating per attempt — the last `quest_rated` fact wins, matching
/// the client `latestRating` so re-rating never double-counts — into `(mean,
/// count)`. This per-attempt, per-version fold now powers ONLY the author's
/// per-version dashboard (`project_version_stats`). The public marketplace card and
/// product page use the per-player, all-versions, hide-aware [`fold_rating_rows`]
/// instead, so the two surfaces intentionally differ: a hidden review is dropped
/// from the public average but still counted in the author's raw per-version stats.
pub fn fold_attempt_ratings<'a, I>(logs: I) -> (f64, usize)
where
    I: IntoIterator<Item = &'a Vec<Fact>>,
{
    let mut rating_sum: i64 = 0;
    let mut rating_count = 0usize;
    for log in logs {
        let mut last_rating: Option<i64> = None;
        for f in log {
            if f.kind == FactKind::QuestRated {
                last_rating = parse_rating(f);
            }
        }
        if let Some(r) = last_rating {
            rating_sum += r;
            rating_count += 1;
        }
    }
    let rating_avg = if rating_count > 0 {
        rating_sum as f64 / rating_count as f64
    } else {
        0.0
    };
    (rating_avg, rating_count)
}

/// One player's effective rating for one quest — the input to the public,
/// hide-aware rating fold (content-moderation). There is exactly one row per
/// `(user_id, quest_id)`: the player's LATEST rated attempt, taken across every
/// version. Grain: per player (a replaying player counts once), all versions (a
/// rating survives a new publish), hide-aware (dropped by the fold below).
#[derive(Clone, Debug, PartialEq)]
pub struct PlayerRatingRow {
    pub user_id: String,
    pub quest_id: String,
    pub rating: i64,
    /// Trimmed review text; `None` for a star-only rating.
    pub text: Option<String>,
    /// The rating attempt's creation instant (drives newest-first review order).
    pub created_at: u64,
}

/// A quest's effective rating from one attempt log: the LAST `quest_rated` fact
/// (re-rating within an attempt lets the newer value win, matching the client
/// `latestRating`), as `(stars, text)`. `None` when the log carries no parseable
/// rating; a star-only rating returns `text = None`.
pub fn effective_rating(log: &[Fact]) -> Option<(i64, Option<String>)> {
    let f = log.iter().rev().find(|f| f.kind == FactKind::QuestRated)?;
    let rating = parse_rating(f)?;
    let text = f
        .note
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    Some((rating, text))
}

/// True when this row's `(user_id, quest_id)` is in the hidden overlay set.
fn row_hidden(row: &PlayerRatingRow, hidden: &std::collections::HashSet<(String, String)>) -> bool {
    hidden.contains(&(row.user_id.clone(), row.quest_id.clone()))
}

/// Public rating fold: mean + count over the effective per-player ratings whose
/// `(player, quest)` is NOT hidden. Star-only ratings count toward both. Returns
/// `(0.0, 0)` when none remain. The single backend definition behind the product
/// page, the catalog card, and the admin reviews list; the frontend hide-preview is
/// a same-grain TS mirror of it (`lib/admin-moderation.questAverage`), kept in step
/// by tests rather than by sharing this code.
pub fn fold_rating_rows(
    rows: &[PlayerRatingRow],
    hidden: &std::collections::HashSet<(String, String)>,
) -> (f64, usize) {
    let mut sum: i64 = 0;
    let mut count = 0usize;
    for row in rows {
        if row_hidden(row, hidden) {
            continue;
        }
        sum += row.rating;
        count += 1;
    }
    if count == 0 {
        (0.0, 0)
    } else {
        (sum as f64 / count as f64, count)
    }
}

/// One public review (rating text); the author label is resolved by the caller.
#[derive(Clone, Debug, PartialEq)]
pub struct PlayerReview {
    pub user_id: String,
    pub created_at: u64,
    pub rating: i64,
    pub text: String,
}

/// The non-hidden ratings that carry text, newest first, capped at `limit`; each
/// text is clamped to 500 chars. Star-only and hidden rows are excluded.
pub fn quest_reviews(
    rows: &[PlayerRatingRow],
    hidden: &std::collections::HashSet<(String, String)>,
    limit: usize,
) -> Vec<PlayerReview> {
    let mut with_text: Vec<&PlayerRatingRow> = rows
        .iter()
        .filter(|r| !row_hidden(r, hidden))
        .filter(|r| r.text.as_deref().is_some_and(|t| !t.trim().is_empty()))
        .collect();
    with_text.sort_by_key(|r| std::cmp::Reverse(r.created_at));
    with_text
        .into_iter()
        .take(limit)
        .map(|r| PlayerReview {
            user_id: r.user_id.clone(),
            created_at: r.created_at,
            rating: r.rating,
            text: r
                .text
                .clone()
                .unwrap_or_default()
                .chars()
                .take(500)
                .collect(),
        })
        .collect()
}

/// Count of non-hidden ratings that carry text — the «{M} с отзывом» total.
pub fn quest_reviews_total(
    rows: &[PlayerRatingRow],
    hidden: &std::collections::HashSet<(String, String)>,
) -> usize {
    rows.iter()
        .filter(|r| !row_hidden(r, hidden))
        .filter(|r| r.text.as_deref().is_some_and(|t| !t.trim().is_empty()))
        .count()
}

/// One `feedback_reported` fact with its resolved attempt context — the input to
/// the global feedback-inbox grouping (content-moderation). `recorded_at` is the
/// SERVER receive time (never the wire fact), the basis of the resolution watermark.
#[derive(Clone, Debug, PartialEq)]
pub struct FeedbackReportRow {
    pub quest_id: String,
    /// Frozen version identity the reporting attempt was bound to.
    pub snapshot_id: String,
    pub step_position: i32,
    pub user_id: String,
    pub note: String,
    pub recorded_at: u64,
}

/// A group of reports for one `(quest, snapshot, step)`, with its resolution status.
#[derive(Clone, Debug, PartialEq)]
pub struct FeedbackGroupCore {
    pub quest_id: String,
    pub snapshot_id: String,
    pub step_position: i32,
    pub resolved: bool,
    /// Reports in the group, newest first.
    pub reports: Vec<FeedbackReportRow>,
}

/// Group reports by `(quest, snapshot, step)` and mark each group resolved via a
/// COUNT WATERMARK: `resolutions` maps a group key to the report count the admin
/// acknowledged. A group is resolved iff its CURRENT report count is `<=` that
/// acknowledged count. Because reports are append-only (count only grows), a newly
/// appended report pushes the count past the watermark and reopens the group with
/// no write to the overlay and no dependence on clock granularity — resolution is
/// invalidated by later evidence, never coupled to the append path. Groups are
/// ordered open-first then most-reported-first (stable by key); reports within a
/// group newest-first.
pub fn group_feedback(
    reports: Vec<FeedbackReportRow>,
    resolutions: &std::collections::HashMap<(String, String, i32), u64>,
) -> Vec<FeedbackGroupCore> {
    let mut by_key: std::collections::HashMap<(String, String, i32), Vec<FeedbackReportRow>> =
        std::collections::HashMap::new();
    for r in reports {
        by_key
            .entry((r.quest_id.clone(), r.snapshot_id.clone(), r.step_position))
            .or_default()
            .push(r);
    }
    let mut groups: Vec<FeedbackGroupCore> = by_key
        .into_iter()
        .map(|(key, mut reps)| {
            // Newest first; deterministic tiebreak by player then note.
            reps.sort_by(|a, b| {
                b.recorded_at
                    .cmp(&a.recorded_at)
                    .then_with(|| a.user_id.cmp(&b.user_id))
                    .then_with(|| a.note.cmp(&b.note))
            });
            let resolved = resolutions
                .get(&key)
                .is_some_and(|&acknowledged| reps.len() as u64 <= acknowledged);
            FeedbackGroupCore {
                quest_id: key.0,
                snapshot_id: key.1,
                step_position: key.2,
                resolved,
                reports: reps,
            }
        })
        .collect();
    groups.sort_by(|a, b| {
        a.resolved
            .cmp(&b.resolved)
            .then_with(|| b.reports.len().cmp(&a.reports.len()))
            .then_with(|| {
                (a.quest_id.as_str(), a.snapshot_id.as_str(), a.step_position).cmp(&(
                    b.quest_id.as_str(),
                    b.snapshot_id.as_str(),
                    b.step_position,
                ))
            })
    });
    groups
}

/// Pure per-version stats fold over the logs of attempts bound to `snap`.
///
/// `attempt_snaps` maps attempt_id -> bound snapshot_id. Small-N scan; the
/// persistence layer will index this.
pub fn project_version_stats(
    snap: &str,
    fact_logs: &std::collections::HashMap<String, Vec<Fact>>,
    attempt_snaps: &std::collections::HashMap<String, String>,
    grants_count: usize,
) -> PerVersionStats {
    let bound: Vec<&String> = attempt_snaps
        .iter()
        .filter_map(|(att, s)| (s == snap).then_some(att))
        .collect();

    let attempts_count = bound.len();
    let mut completions_count = 0usize;
    let mut per_step: std::collections::HashMap<i32, StepStats> = std::collections::HashMap::new();
    let mut all_facts: Vec<Fact> = Vec::new();

    for att in &bound {
        let Some(log) = fact_logs.get(*att) else {
            continue;
        };
        if log.iter().any(|f| f.kind == FactKind::AttemptCompleted) {
            completions_count += 1;
        }
        for f in log {
            all_facts.push(f.clone());
            let entry = per_step.entry(f.step_position).or_default();
            match f.kind {
                FactKind::AnswerSubmitted if !f.local_is_correct => entry.wrongs += 1,
                FactKind::HintPurchased => entry.hints += 1,
                FactKind::NavigatorUsed => entry.nav += 1,
                FactKind::FeedbackReported => entry.feedbacks += 1,
                _ => {}
            }
        }
    }

    // Ratings share one definition with the catalog (fold_attempt_ratings): last
    // rating per attempt wins, so re-rating never double-counts.
    let (rating_avg, rating_count) =
        fold_attempt_ratings(bound.iter().filter_map(|att| fact_logs.get(*att)));

    let analytics = project_analytics(&all_facts);
    let completion_rate = if attempts_count > 0 {
        completions_count as f64 / attempts_count as f64
    } else {
        0.0
    };

    PerVersionStats {
        grants_count,
        attempts_count,
        completions_count,
        completion_rate,
        per_step,
        hints_used: analytics.hints_used,
        wrongs_submitted: analytics.wrongs_submitted,
        navigator_clicks: analytics.navigator_clicks,
        feedback_count: analytics.feedback_count,
        rating_count,
        rating_avg,
    }
}

/// Pure list of `feedback_reported` facts across attempts bound to `snap`.
pub fn list_feedbacks_for_snapshot(
    snap: &str,
    fact_logs: &std::collections::HashMap<String, Vec<Fact>>,
    attempt_snaps: &std::collections::HashMap<String, String>,
) -> Vec<Fact> {
    attempt_snaps
        .iter()
        .filter(|(_, s)| *s == snap)
        .filter_map(|(att, _)| fact_logs.get(att))
        .flatten()
        .filter(|f| f.kind == FactKind::FeedbackReported)
        .cloned()
        .collect()
}

/// Result of the one-time idempotent legacy migration job (PLAN Phase 4).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MigrationResult {
    pub synth_snapshot: serde_json::Value,
    pub synth_facts: Vec<Fact>,
    /// Human-readable balance diff report for manual review (no auto-adjust).
    pub audit_report: String,
    pub marked: bool,
}

/// Pure synthesis of legacy history (grants + answer_card rows) into facts and a
/// synthetic snapshot. The audit report compares the projected balance against
/// the legacy scalar; mismatches are flagged for manual review only.
pub fn synthesize_legacy_snapshot_and_facts(
    historical_grants: Vec<serde_json::Value>,
    answer_cards: Vec<serde_json::Value>,
) -> MigrationResult {
    let device = "legacy-mig-device".to_string();
    let synth_facts: Vec<Fact> = answer_cards
        .iter()
        .map(|card| {
            let step = card.get("step").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let typ = card.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let value = card
                .get("value")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let coins = card.get("coins").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let correct = card
                .get("correct")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let (kind, coins_delta, note) = match typ {
                "gift" => (FactKind::GiftClaimed, coins, Some("legacy gift synth")),
                "answer" => (FactKind::AnswerSubmitted, 0, None),
                "physical" | "complete" => {
                    (FactKind::AttemptCompleted, 0, Some("legacy complete synth"))
                }
                _ => (FactKind::PhysicalConfirmed, 0, None),
            };
            Fact {
                kind,
                step_position: step,
                submitted_value: value,
                local_is_correct: correct,
                coins_delta,
                note: note.map(str::to_string),
                device_id: device.clone(),
            }
        })
        .collect();

    let synth_snapshot = serde_json::json!({
        "golden_id": "legacy-synth",
        "name": "Legacy synthetic snapshot",
        "snapshot_version": 1,
        "notes": "Synthesized from historical grants + answer_card history (phase 4 migration)",
        "steps": []
    });

    let synth_bal = project_balance(&synth_facts);
    let old_scalar_bal = answer_cards
        .iter()
        .filter_map(|c| c.get("coins").and_then(|v| v.as_i64()))
        .sum::<i64>() as i32;
    let audit_report = format!(
        "bal synth={} vs old_scalar={}; bal match: {} (manual review, no auto-adjust); {} grants + {} cards",
        synth_bal,
        old_scalar_bal,
        if synth_bal == old_scalar_bal {
            "yes"
        } else {
            "review"
        },
        historical_grants.len(),
        answer_cards.len()
    );

    MigrationResult {
        synth_snapshot,
        synth_facts,
        audit_report,
        marked: true,
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

    /// A `quest_rated` fact with `stars` and an optional review `text`.
    fn rated(stars: &str, text: Option<&str>) -> Fact {
        Fact {
            submitted_value: Some(stars.into()),
            note: text.map(str::to_string),
            ..fact(FactKind::QuestRated, 0, 0)
        }
    }

    fn rrow(
        player: &str,
        quest: &str,
        rating: i64,
        text: Option<&str>,
        at: u64,
    ) -> PlayerRatingRow {
        PlayerRatingRow {
            user_id: player.into(),
            quest_id: quest.into(),
            rating,
            text: text.map(str::to_string),
            created_at: at,
        }
    }

    fn hidden_of(pairs: &[(&str, &str)]) -> std::collections::HashSet<(String, String)> {
        pairs
            .iter()
            .map(|(p, q)| ((*p).to_string(), (*q).to_string()))
            .collect()
    }

    #[test]
    fn effective_rating_takes_last_and_reads_text() {
        assert_eq!(effective_rating(&[]), None, "no rating in log");
        // Re-rated within an attempt: the newer value wins.
        let log = vec![rated("3", Some("meh")), rated("5", Some("great"))];
        assert_eq!(effective_rating(&log), Some((5, Some("great".to_string()))));
        // Star-only: blank/None note trims to None.
        assert_eq!(effective_rating(&[rated("4", Some("  "))]), Some((4, None)));
        assert_eq!(effective_rating(&[rated("2", None)]), Some((2, None)));
        // Unparseable stars → excluded.
        assert_eq!(effective_rating(&[rated("", None)]), None);
    }

    #[test]
    fn fold_rating_rows_is_mean_over_non_hidden() {
        let rows = vec![
            rrow("p1", "q1", 5, Some("a"), 3),
            rrow("p2", "q1", 1, None, 2), // star-only still counts toward the average
        ];
        assert_eq!(fold_rating_rows(&rows, &hidden_of(&[])), (3.0, 2));
        assert_eq!(fold_rating_rows(&[], &hidden_of(&[])), (0.0, 0));
        // Hiding (p2, q1) leaves only the 5.
        assert_eq!(
            fold_rating_rows(&rows, &hidden_of(&[("p2", "q1")])),
            (5.0, 1)
        );
        // Hiding the same player on ANOTHER quest does not touch q1.
        assert_eq!(
            fold_rating_rows(&rows, &hidden_of(&[("p2", "q2")])),
            (3.0, 2)
        );
    }

    #[test]
    fn quest_reviews_excludes_star_only_and_hidden_newest_first() {
        let rows = vec![
            rrow("p1", "q1", 5, Some("newest"), 30),
            rrow("p2", "q1", 4, None, 20), // star-only → not a text review
            rrow("p3", "q1", 2, Some("oldest"), 10),
        ];
        let reviews = quest_reviews(&rows, &hidden_of(&[]), 10);
        assert_eq!(reviews.len(), 2);
        assert_eq!(reviews[0].text, "newest", "newest first");
        assert_eq!(reviews[1].text, "oldest");
        assert_eq!(quest_reviews_total(&rows, &hidden_of(&[])), 2);
        assert_eq!(
            quest_reviews(&rows, &hidden_of(&[]), 1).len(),
            1,
            "limit honored"
        );
        // Hiding a text review drops it from both the list and the total.
        let hidden = hidden_of(&[("p1", "q1")]);
        let reviews = quest_reviews(&rows, &hidden, 10);
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].text, "oldest");
        assert_eq!(quest_reviews_total(&rows, &hidden), 1);
    }

    fn freport(
        quest: &str,
        snap: &str,
        step: i32,
        player: &str,
        note: &str,
        at: u64,
    ) -> FeedbackReportRow {
        FeedbackReportRow {
            quest_id: quest.into(),
            snapshot_id: snap.into(),
            step_position: step,
            user_id: player.into(),
            note: note.into(),
            recorded_at: at,
        }
    }

    fn resolutions(
        items: &[((&str, &str, i32), u64)],
    ) -> std::collections::HashMap<(String, String, i32), u64> {
        items
            .iter()
            .map(|((q, s, step), at)| (((*q).to_string(), (*s).to_string(), *step), *at))
            .collect()
    }

    #[test]
    fn group_feedback_buckets_by_quest_snapshot_step_newest_first() {
        let reports = vec![
            freport("q1", "s1", 4, "p1", "a", 10),
            freport("q1", "s1", 4, "p2", "b", 20),
            freport("q1", "s1", 5, "p3", "c", 15), // different step → own group
            freport("q1", "s2", 4, "p4", "d", 15), // different snapshot → own group
        ];
        let groups = group_feedback(reports, &resolutions(&[]));
        assert_eq!(groups.len(), 3);
        // The 2-report group sorts first (open, most-reported).
        let top = &groups[0];
        assert_eq!(
            (
                top.quest_id.as_str(),
                top.snapshot_id.as_str(),
                top.step_position
            ),
            ("q1", "s1", 4)
        );
        assert_eq!(top.reports.len(), 2);
        assert_eq!(top.reports[0].user_id, "p2", "newest first");
        assert!(groups.iter().all(|g| !g.resolved));
    }

    #[test]
    fn group_resolved_only_while_no_report_exceeds_the_acknowledged_count() {
        let reports = vec![
            freport("q1", "s1", 4, "p1", "a", 10),
            freport("q1", "s1", 4, "p2", "b", 20),
        ];
        // Both reports acknowledged (count 2) → resolved.
        let g = group_feedback(reports.clone(), &resolutions(&[(("q1", "s1", 4), 2)]));
        assert!(g[0].resolved, "resolved when every report is acknowledged");
        // Only 1 acknowledged but 2 exist → a later report reopened it.
        let g = group_feedback(reports.clone(), &resolutions(&[(("q1", "s1", 4), 1)]));
        assert!(!g[0].resolved, "an unacknowledged report reopens the group");
        // No resolution row (never resolved, or manually reopened) → open.
        let g = group_feedback(reports, &resolutions(&[]));
        assert!(!g[0].resolved);
    }

    /// Shared parity fixtures (platform/goldens/parity/) — the SAME files the
    /// frontend vitest suite folds. Any one-sided drift fails one of the suites.
    #[test]
    fn parity_fixtures_project_identically() {
        #[derive(Deserialize)]
        struct Expected {
            balance: i32,
            completed_steps: Vec<i32>,
            revealed_hints: Vec<i32>,
        }
        #[derive(Deserialize)]
        struct Fixture {
            name: String,
            facts: Vec<Fact>,
            expected: Expected,
        }

        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../goldens/parity");
        let mut count = 0;
        for entry in std::fs::read_dir(dir).expect("shared parity fixtures dir must exist") {
            let path = entry.expect("dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = std::fs::read_to_string(&path).expect("readable fixture");
            let fx: Fixture = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("fixture {} must deserialize: {e}", path.display()));

            assert_eq!(
                project_balance(&fx.facts),
                fx.expected.balance,
                "{}: balance",
                fx.name
            );
            let state = project_state(&fx.facts);
            assert_eq!(
                state.completed_steps, fx.expected.completed_steps,
                "{}: completed",
                fx.name
            );
            assert_eq!(
                state.revealed_hints, fx.expected.revealed_hints,
                "{}: revealed",
                fx.name
            );
            count += 1;
        }
        assert!(
            count >= 4,
            "expected the full shared fixture set, got {count}"
        );
    }

    #[test]
    fn wire_format_roundtrips_snake_case_type_tag() {
        let f = fact(FactKind::CompletionBonus, 3, 5);
        let json = serde_json::to_value(&f).expect("serialize");
        assert_eq!(json["type"], "completion_bonus");
        let back: Fact = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, f);
    }

    #[test]
    fn balance_goes_negative_and_stays_negative() {
        let facts = vec![
            fact(FactKind::GiftClaimed, 1, 3),
            fact(FactKind::HintPurchased, 2, -5),
            fact(FactKind::HintPurchased, 3, -5),
        ];
        assert_eq!(project_balance(&facts), -7);
        assert_eq!(project_state(&facts).balance, -7);
    }

    #[test]
    fn wrong_answer_does_not_complete_step() {
        let wrong = Fact {
            local_is_correct: false,
            submitted_value: Some("не то".into()),
            ..fact(FactKind::AnswerSubmitted, 2, 0)
        };
        let state = project_state(&[wrong]);
        assert!(state.completed_steps.is_empty());
        assert_eq!(
            project_analytics(&[fact(FactKind::AnswerSubmitted, 2, 0)]).wrongs_submitted,
            0
        );
    }

    #[test]
    fn natural_key_is_device_agnostic() {
        let a = fact(FactKind::GiftClaimed, 2, 5);
        let b = Fact {
            device_id: "device-b".into(),
            ..a.clone()
        };
        assert!(
            semantically_same(&a, &b),
            "same semantic event from another device must dedup"
        );
        let different_note = Fact {
            note: Some("other".into()),
            ..a.clone()
        };
        assert!(!semantically_same(&a, &different_note));
    }

    #[test]
    fn version_stats_aggregate_per_step_and_overall() {
        let mut logs = std::collections::HashMap::new();
        let mut snaps = std::collections::HashMap::new();
        logs.insert(
            "att-1".to_string(),
            vec![
                fact(FactKind::PhysicalConfirmed, 0, 0),
                Fact {
                    local_is_correct: false,
                    submitted_value: Some("wrong".into()),
                    ..fact(FactKind::AnswerSubmitted, 1, 0)
                },
                fact(FactKind::HintPurchased, 1, -5),
                Fact {
                    note: Some("mid".into()),
                    ..fact(FactKind::FeedbackReported, 1, 0)
                },
                fact(FactKind::NavigatorUsed, 0, 0),
                fact(FactKind::AttemptCompleted, 3, 0),
            ],
        );
        snaps.insert("att-1".to_string(), "snap-v1".to_string());

        let stats = project_version_stats("snap-v1", &logs, &snaps, 1);
        assert_eq!(stats.attempts_count, 1);
        assert_eq!(stats.completions_count, 1);
        assert_eq!(stats.completion_rate, 1.0);
        let step1 = stats.per_step.get(&1).expect("step 1 stats");
        assert_eq!((step1.wrongs, step1.hints, step1.feedbacks), (1, 1, 1));
        assert_eq!(stats.navigator_clicks, 1);

        let feedbacks = list_feedbacks_for_snapshot("snap-v1", &logs, &snaps);
        assert_eq!(feedbacks.len(), 1);
        assert_eq!(feedbacks[0].note.as_deref(), Some("mid"));
    }

    #[test]
    fn version_stats_aggregate_ratings_one_per_attempt_last_wins() {
        let mut logs = std::collections::HashMap::new();
        let mut snaps = std::collections::HashMap::new();
        // Attempt 1 re-rated 3 then 5 — last (5) wins, counted once.
        logs.insert(
            "att-1".to_string(),
            vec![
                fact(FactKind::AttemptCompleted, 3, 0),
                Fact {
                    submitted_value: Some("3".into()),
                    ..fact(FactKind::QuestRated, 3, 0)
                },
                Fact {
                    submitted_value: Some("5".into()),
                    ..fact(FactKind::QuestRated, 3, 0)
                },
            ],
        );
        // Attempt 2 rated 4.
        logs.insert(
            "att-2".to_string(),
            vec![
                fact(FactKind::AttemptCompleted, 3, 0),
                Fact {
                    submitted_value: Some("4".into()),
                    ..fact(FactKind::QuestRated, 3, 0)
                },
            ],
        );
        // Attempt 3 completed but never rated — excluded from the average.
        logs.insert(
            "att-3".to_string(),
            vec![fact(FactKind::AttemptCompleted, 3, 0)],
        );
        for a in ["att-1", "att-2", "att-3"] {
            snaps.insert(a.to_string(), "snap-v1".to_string());
        }

        let stats = project_version_stats("snap-v1", &logs, &snaps, 3);
        assert_eq!(stats.rating_count, 2, "two attempts left a rating");
        assert_eq!(
            stats.rating_avg, 4.5,
            "(5 + 4) / 2 — last rating per attempt"
        );
        // A rating must never leak into balance/state projections.
        assert!(project_state(&logs["att-1"]).completed_steps.contains(&3));
        assert_eq!(project_balance(&logs["att-1"]), 0);

        // The catalog's batch fold MUST agree with the version-stats page — they
        // share `fold_attempt_ratings`, so a card and the dashboard can never
        // report a different rating for the same snapshot.
        let (batch_avg, batch_count) = fold_attempt_ratings(logs.values());
        assert_eq!(
            (batch_avg, batch_count),
            (stats.rating_avg, stats.rating_count)
        );
    }

    #[test]
    fn quest_rated_wire_tag_is_snake_case() {
        let f = Fact {
            submitted_value: Some("5".into()),
            ..fact(FactKind::QuestRated, 7, 0)
        };
        let json = serde_json::to_value(&f).expect("serialize");
        assert_eq!(json["type"], "quest_rated");
        let back: Fact = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, f);
    }

    #[test]
    fn legacy_synthesis_projects_and_audits() {
        let cards = vec![
            serde_json::json!({"step": 0, "type": "physical", "correct": true}),
            serde_json::json!({"step": 2, "type": "gift", "coins": 5}),
            serde_json::json!({"step": 3, "type": "complete", "correct": true}),
        ];
        let res = synthesize_legacy_snapshot_and_facts(vec![], cards);
        assert!(res.marked);
        assert_eq!(project_balance(&res.synth_facts), 5);
        assert!(res.audit_report.contains("bal match: yes"));
    }
}
