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
pub struct PlayerStats {
    pub balance: i32,
    pub quests_completed: usize,
    pub completed_quest_ids: Vec<String>,
    pub attempts_count: usize,
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
    // Ratings aggregate ONE value per attempt (the last quest_rated fact wins,
    // matching the client `latestRating`), so re-rating never double-counts.
    let mut rating_sum: i64 = 0;
    let mut rating_count = 0usize;

    for att in &bound {
        let Some(log) = fact_logs.get(*att) else {
            continue;
        };
        if log.iter().any(|f| f.kind == FactKind::AttemptCompleted) {
            completions_count += 1;
        }
        let mut last_rating: Option<i64> = None;
        for f in log {
            all_facts.push(f.clone());
            let entry = per_step.entry(f.step_position).or_default();
            match f.kind {
                FactKind::AnswerSubmitted if !f.local_is_correct => entry.wrongs += 1,
                FactKind::HintPurchased => entry.hints += 1,
                FactKind::NavigatorUsed => entry.nav += 1,
                FactKind::FeedbackReported => entry.feedbacks += 1,
                FactKind::QuestRated => last_rating = parse_rating(f),
                _ => {}
            }
        }
        if let Some(r) = last_rating {
            rating_sum += r;
            rating_count += 1;
        }
    }

    let analytics = project_analytics(&all_facts);
    let completion_rate = if attempts_count > 0 {
        completions_count as f64 / attempts_count as f64
    } else {
        0.0
    };
    let rating_avg = if rating_count > 0 {
        rating_sum as f64 / rating_count as f64
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
