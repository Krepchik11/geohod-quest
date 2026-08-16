//! Admin statistics: pure, deterministic folds over the event log.
//!
//! The admin dashboard needs three time-bucketed signals — purchases
//! (`access_grants.granted_at`), starts (`attempts.created_at`) and finishes
//! (`attempt_completed` facts by their storage-level `recorded_at`) — plus a
//! per-snapshot step funnel. Storage backends load raw [`StatEvent`] rows and
//! fact logs; everything else (range filtering, daily bucketing, per-quest
//! rows, funnel reach) happens here so the in-memory and Postgres backends
//! report identical numbers, mirroring the `facts.rs` projector pattern.
//!
//! All dates are UTC calendar days (`YYYY-MM-DD`), the platform-wide
//! convention (see `store::today_utc`). Date math uses Howard Hinnant's civil
//! calendar algorithms — exact, no date crate.

use serde::Serialize;

use crate::facts::{Fact, project_state};
use crate::store::{PublishedMeta, QuestLabel, QuestLabels};

// ── calendar helpers ─────────────────────────────────────────────────────────

/// Days from 1970-01-01 for a civil date (Hinnant's `days_from_civil`,
/// the exact inverse of the era math in `store::rfc3339_from_unix`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Digits-only field of a date/time string: `None` on any non-ASCII-digit.
fn digits(s: &str, r: std::ops::Range<usize>) -> Option<i64> {
    if !s.as_bytes()[r.clone()].iter().all(u8::is_ascii_digit) {
        return None;
    }
    s[r].parse().ok()
}

/// Parse a strict `YYYY-MM-DD` UTC day into Unix seconds at 00:00:00.
/// Rejects malformed strings AND non-existent dates (`2026-02-30`): the civil
/// math silently normalizes them, so the round-trip compare is the validator.
pub fn parse_day(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (digits(s, 0..4)?, digits(s, 5..7)?, digits(s, 8..10)?);
    let secs = days_from_civil(y, m, d) * 86_400;
    (day_from_unix(secs) == s).then_some(secs)
}

/// UTC calendar day (`YYYY-MM-DD`) of a Unix-seconds instant.
pub fn day_from_unix(secs: i64) -> String {
    crate::store::rfc3339_from_unix(secs.max(0) as u64)[..10].to_string()
}

/// Parse the platform's canonical RFC3339 shape (`YYYY-MM-DDTHH:MM:SSZ`,
/// produced by `store::now_rfc3339`) into Unix seconds.
pub fn parse_rfc3339_utc(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 20 || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let day = parse_day(&s[..10])?;
    let (h, m, sec) = (digits(s, 11..13)?, digits(s, 14..16)?, digits(s, 17..19)?);
    if h > 23 || m > 59 || sec > 59 {
        return None;
    }
    Some(day + h * 3600 + m * 60 + sec)
}

// ── inputs ───────────────────────────────────────────────────────────────────

/// One dated event of a quest (a purchase, a start, or a finish).
#[derive(Debug, Clone, PartialEq)]
pub struct StatEvent {
    pub quest_id: String,
    /// Unix seconds UTC.
    pub at: i64,
}

/// The three event streams the overview is folded from. Streams may be wider
/// than the requested range (loaders pre-filter only as an optimization); every
/// fold re-filters, so filtering here is the single source of truth.
#[derive(Debug, Default)]
pub struct StatsEvents {
    pub purchases: Vec<StatEvent>,
    pub starts: Vec<StatEvent>,
    pub finishes: Vec<StatEvent>,
}

/// Inclusive UTC day range with pre-resolved second bounds.
#[derive(Debug, Clone, PartialEq)]
pub struct DayRange {
    pub from: String,
    pub to: String,
    start_secs: i64,
    end_secs_excl: i64,
}

impl DayRange {
    /// Build from inclusive `YYYY-MM-DD` days; `None` when a day is malformed
    /// or `from > to`.
    pub fn new(from: &str, to: &str) -> Option<Self> {
        let start_secs = parse_day(from)?;
        let end_secs_excl = parse_day(to)? + 86_400;
        (start_secs < end_secs_excl).then(|| Self {
            from: from.to_string(),
            to: to.to_string(),
            start_secs,
            end_secs_excl,
        })
    }

    pub fn contains(&self, at: i64) -> bool {
        (self.start_secs..self.end_secs_excl).contains(&at)
    }

    pub fn len_days(&self) -> i64 {
        (self.end_secs_excl - self.start_secs) / 86_400
    }

    /// The adjacent same-length window immediately before this one (the
    /// «к пред. периоду» comparison base).
    pub fn prev(&self) -> Self {
        let start = self.start_secs - self.len_days() * 86_400;
        Self {
            from: day_from_unix(start),
            to: day_from_unix(self.start_secs - 86_400),
            start_secs: start,
            end_secs_excl: self.start_secs,
        }
    }

    pub fn start_secs(&self) -> i64 {
        self.start_secs
    }

    pub fn end_secs_excl(&self) -> i64 {
        self.end_secs_excl
    }
}

// ── outputs (wire shapes) ────────────────────────────────────────────────────

/// Raw counters for one period. Deltas are the client's presentation concern.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AdminStatsTotalsWire"))]
pub struct StatsTotals {
    #[cfg_attr(test, ts(type = "number"))]
    pub purchased: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub started: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub finished: u64,
}

/// One day of the trend chart (zero-filled — every day of the range is present).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AdminStatsDailyWire"))]
pub struct DailyPoint {
    pub date: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub started: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub finished: u64,
}

/// One row of the per-quest table.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AdminStatsQuestRowWire"))]
pub struct QuestStatsRow {
    pub quest_id: String,
    pub name: String,
    pub city: Option<String>,
    pub template_summary: String,
    /// Step-count chip frozen at publish (`None` for pre-chip versions).
    pub pages: Option<u32>,
    /// `false` for a quest that has range activity but is no longer in the
    /// catalog (delisted) — its history must stay visible so the table always
    /// reconciles with the KPI totals, but there is no detail page to open.
    pub published: bool,
    #[cfg_attr(test, ts(type = "number"))]
    pub purchased: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub started: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub finished: u64,
}

/// `GET /api/admin/stats` body.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AdminStatsOverviewWire"))]
pub struct OverviewResponse {
    pub from: String,
    pub to: String,
    pub totals: StatsTotals,
    /// Same-length previous window, `None` for the unbounded «Всё время» view.
    pub prev: Option<StatsTotals>,
    pub daily: Vec<DailyPoint>,
    /// Every published quest, sorted by starts desc (the design's table order).
    pub quests: Vec<QuestStatsRow>,
}

/// One funnel step of the quest detail view.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AdminStatsFunnelStepWire"))]
pub struct FunnelStep {
    #[cfg_attr(test, ts(type = "number"))]
    pub position: usize,
    pub title: String,
    pub template: String,
    /// Attempts (of the current snapshot, started in range) that reached this step.
    #[cfg_attr(test, ts(type = "number"))]
    pub reached: u64,
}

/// `GET /api/admin/stats/{quest_id}` body.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AdminStatsQuestWire"))]
pub struct QuestStatsResponse {
    pub quest_id: String,
    pub name: String,
    pub city: Option<String>,
    pub template_summary: String,
    /// Step-count chip frozen at publish (`None` for pre-chip versions) —
    /// same field the overview rows carry, so the two screens agree.
    pub pages: Option<u32>,
    pub from: String,
    pub to: String,
    pub totals: StatsTotals,
    pub prev: Option<StatsTotals>,
    /// The funnel is computed over the CURRENT published snapshot only — step
    /// labels are frozen per snapshot, so mixing versions would mislabel bars.
    pub snapshot_id: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub snapshot_version: u32,
    /// Denominator of the funnel (attempts of this snapshot started in range);
    /// may be smaller than `totals.started`, which spans all versions.
    ///
    /// The funnel is a COHORT metric: attempts started in range, folded over
    /// their LIFETIME facts — an attempt started on the range's last day and
    /// finished after it still reaches the terminal bar, while `totals.finished`
    /// (a period counter) excludes that finish. The client shows this
    /// denominator next to the funnel so the two semantics stay legible.
    #[cfg_attr(test, ts(type = "number"))]
    pub funnel_started: u64,
    pub funnel: Vec<FunnelStep>,
}

// ── folds ────────────────────────────────────────────────────────────────────

fn count_in(events: &[StatEvent], range: &DayRange, quest: Option<&str>) -> u64 {
    events
        .iter()
        .filter(|e| range.contains(e.at) && quest.is_none_or(|q| e.quest_id == q))
        .count() as u64
}

/// Raw counters of one period, optionally restricted to one quest.
pub fn totals_in(ev: &StatsEvents, range: &DayRange, quest: Option<&str>) -> StatsTotals {
    StatsTotals {
        purchased: count_in(&ev.purchases, range, quest),
        started: count_in(&ev.starts, range, quest),
        finished: count_in(&ev.finishes, range, quest),
    }
}

/// Zero-filled per-day series over the range (starts + finishes — the two
/// trend-chart lines).
pub fn daily_series(ev: &StatsEvents, range: &DayRange) -> Vec<DailyPoint> {
    let mut by_day: std::collections::HashMap<i64, (u64, u64)> = std::collections::HashMap::new();
    for e in ev.starts.iter().filter(|e| range.contains(e.at)) {
        by_day.entry(e.at.div_euclid(86_400)).or_default().0 += 1;
    }
    for e in ev.finishes.iter().filter(|e| range.contains(e.at)) {
        by_day.entry(e.at.div_euclid(86_400)).or_default().1 += 1;
    }
    (0..range.len_days())
        .map(|i| {
            let day_secs = range.start_secs + i * 86_400;
            let (started, finished) = by_day
                .get(&day_secs.div_euclid(86_400))
                .copied()
                .unwrap_or((0, 0));
            DailyPoint {
                date: day_from_unix(day_secs),
                started,
                finished,
            }
        })
        .collect()
}

/// Per-quest table rows: every published quest (zero-activity ones included)
/// PLUS every quest with range activity that has no catalog entry — the rows
/// must always sum to the KPI totals, and losing a listing must not erase a
/// quest's history. Sorted by starts desc, then purchases desc, then name. One
/// pass per stream (not one scan per quest).
///
/// Every row is named through `labels`, listed or not, so this table agrees with
/// the moderation views and with the drill-down opened from it.
pub fn quest_rows(
    metas: &[PublishedMeta],
    labels: &QuestLabels,
    ev: &StatsEvents,
    range: &DayRange,
) -> Vec<QuestStatsRow> {
    let mut by_quest: std::collections::HashMap<&str, StatsTotals> =
        std::collections::HashMap::new();
    for e in ev.purchases.iter().filter(|e| range.contains(e.at)) {
        by_quest.entry(&e.quest_id).or_default().purchased += 1;
    }
    for e in ev.starts.iter().filter(|e| range.contains(e.at)) {
        by_quest.entry(&e.quest_id).or_default().started += 1;
    }
    for e in ev.finishes.iter().filter(|e| range.contains(e.at)) {
        by_quest.entry(&e.quest_id).or_default().finished += 1;
    }
    let mut rows: Vec<QuestStatsRow> = metas
        .iter()
        .map(|m| {
            let t = by_quest.remove(m.quest_id.as_str()).unwrap_or_default();
            let label = labels.get(&m.quest_id);
            QuestStatsRow {
                quest_id: m.quest_id.clone(),
                name: label.name,
                city: label.city,
                template_summary: m.template_summary.clone(),
                pages: m.pages,
                published: true,
                purchased: t.purchased,
                started: t.started,
                finished: t.finished,
            }
        })
        .collect();
    // Whatever is left has activity but no catalog entry. The chips are
    // snapshot-derived and genuinely absent, but the quest still has a name: the
    // authoring registry keeps it whether or not the quest ever reached the store.
    rows.extend(by_quest.into_iter().map(|(quest_id, t)| {
        let label = labels.get(quest_id);
        QuestStatsRow {
            name: label.name,
            city: label.city,
            quest_id: quest_id.to_string(),
            template_summary: String::new(),
            pages: None,
            published: false,
            purchased: t.purchased,
            started: t.started,
            finished: t.finished,
        }
    }));
    rows.sort_by(|a, b| {
        b.started
            .cmp(&a.started)
            .then(b.purchased.cmp(&a.purchased))
            .then(a.name.cmp(&b.name))
    });
    rows
}

/// The whole overview body — the single composition point both handlers-side
/// backends share.
pub fn project_overview(
    metas: &[PublishedMeta],
    labels: &QuestLabels,
    ev: &StatsEvents,
    range: &DayRange,
    with_prev: bool,
) -> OverviewResponse {
    OverviewResponse {
        from: range.from.clone(),
        to: range.to.clone(),
        totals: totals_in(ev, range, None),
        prev: with_prev.then(|| totals_in(ev, &range.prev(), None)),
        daily: daily_series(ev, range),
        quests: quest_rows(metas, labels, ev, range),
    }
}

/// Step labels of a frozen snapshot: `(title, template)` per step. Steps are
/// `rich_content.title` falling back to the template key — the same rule the
/// player render path uses (`lib/design-step.ts`).
pub fn snapshot_steps(snapshot: &serde_json::Value) -> Vec<(String, String)> {
    let Some(steps) = snapshot.get("steps").and_then(|s| s.as_array()) else {
        return Vec::new();
    };
    steps
        .iter()
        .map(|st| {
            let template = st
                .get("template")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            let title = st
                .get("rich_content")
                .and_then(|rc| rc.get("title"))
                .and_then(|t| t.as_str())
                .filter(|t| !t.trim().is_empty())
                .unwrap_or(&template)
                .to_string();
            (title, template)
        })
        .collect()
}

/// How many of `logs` reached each of `steps_len` positions. Position 0 is
/// reached by starting; position `i` is reached once step `i-1` is completed
/// (`physical_confirmed` / correct `answer_submitted` / `attempt_completed` —
/// exactly the `project_state` completion rule).
pub fn funnel_counts(steps_len: usize, logs: &[Vec<Fact>]) -> Vec<u64> {
    let mut reached = vec![0u64; steps_len];
    if steps_len == 0 {
        return reached;
    }
    for log in logs {
        let max_completed = project_state(log).completed_steps.into_iter().max();
        // Started ⇒ reached step 0; completing step k ⇒ reached step k+1.
        let top = match max_completed {
            Some(k) if k >= 0 => ((k as usize) + 1).min(steps_len - 1),
            _ => 0,
        };
        for slot in &mut reached[..=top] {
            *slot += 1;
        }
    }
    reached
}

/// The whole quest-detail body (KPIs + funnel over the current snapshot). The
/// label comes from the same seam as the overview row this page opens from, so
/// the two can never name the quest differently.
#[allow(clippy::too_many_arguments)]
pub fn project_quest_detail(
    meta: &PublishedMeta,
    label: QuestLabel,
    snapshot: Option<&serde_json::Value>,
    ev: &StatsEvents,
    range: &DayRange,
    with_prev: bool,
    funnel_logs: &[Vec<Fact>],
) -> QuestStatsResponse {
    let steps = snapshot.map(snapshot_steps).unwrap_or_default();
    let reached = funnel_counts(steps.len(), funnel_logs);
    QuestStatsResponse {
        quest_id: meta.quest_id.clone(),
        name: label.name,
        city: label.city,
        template_summary: meta.template_summary.clone(),
        pages: meta.pages,
        from: range.from.clone(),
        to: range.to.clone(),
        totals: totals_in(ev, range, Some(&meta.quest_id)),
        prev: with_prev.then(|| totals_in(ev, &range.prev(), Some(&meta.quest_id))),
        snapshot_id: meta.snapshot_id.clone(),
        snapshot_version: meta.snapshot_version,
        funnel_started: funnel_logs.len() as u64,
        funnel: steps
            .into_iter()
            .enumerate()
            .map(|(i, (title, template))| FunnelStep {
                position: i,
                title,
                template,
                reached: reached[i],
            })
            .collect(),
    }
}

/// Earliest event day across all streams (the «Всё время» left bound),
/// optionally restricted to one quest. `None` when there are no events.
pub fn earliest_event_day(ev: &StatsEvents, quest: Option<&str>) -> Option<String> {
    [&ev.purchases, &ev.starts, &ev.finishes]
        .into_iter()
        .flatten()
        .filter(|e| quest.is_none_or(|q| e.quest_id == q))
        .map(|e| e.at)
        .min()
        .map(day_from_unix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::FactKind;

    fn ev(quest: &str, at: i64) -> StatEvent {
        StatEvent {
            quest_id: quest.into(),
            at,
        }
    }

    fn fact(kind: FactKind, step: i32, correct: bool) -> Fact {
        Fact {
            kind,
            step_position: step,
            submitted_value: None,
            local_is_correct: correct,
            coins_delta: 0,
            note: None,
            device_id: "d1".into(),
        }
    }

    /// Labels as the authoring registry would supply them (`(quest_id, name, city)`).
    fn labels(rows: &[(&str, &str, Option<&str>)]) -> QuestLabels {
        QuestLabels::resolve(
            rows.iter()
                .map(|(quest_id, name, city)| {
                    (
                        (*quest_id).to_string(),
                        crate::store::QuestLabel::from_authored((*name).to_string(), *city),
                    )
                })
                .collect(),
            &[],
        )
    }

    fn meta(quest_id: &str, name: &str) -> PublishedMeta {
        PublishedMeta {
            quest_id: quest_id.into(),
            name: name.into(),
            primary_comic: None,
            template_summary: "3 steps".into(),
            snapshot_version: 1,
            snapshot_id: format!("{quest_id}-v1"),
            city: Some("Казань".into()),
            duration: None,
            price: None,
            description: None,
            pages: Some(3),
            tasks: None,
            paid_hints: None,
            players_bonus: 0,
        }
    }

    // ── calendar ──

    #[test]
    fn parse_day_roundtrips_and_rejects_garbage() {
        assert_eq!(parse_day("1970-01-01"), Some(0));
        assert_eq!(parse_day("1970-01-02"), Some(86_400));
        // Leap day round-trips.
        let leap = parse_day("2024-02-29").expect("leap day");
        assert_eq!(day_from_unix(leap), "2024-02-29");
        // Non-existent and malformed dates reject.
        assert_eq!(parse_day("2026-02-30"), None);
        assert_eq!(parse_day("2026-13-01"), None);
        assert_eq!(parse_day("2026-1-01"), None);
        assert_eq!(parse_day("garbage"), None);
        assert_eq!(parse_day("2026-07-1x"), None);
    }

    #[test]
    fn parse_rfc3339_utc_matches_store_format() {
        // The exact shape store::now_rfc3339 produces.
        assert_eq!(parse_rfc3339_utc("1970-01-01T00:00:05Z"), Some(5));
        assert_eq!(
            parse_rfc3339_utc("2026-07-16T12:34:56Z"),
            Some(parse_day("2026-07-16").unwrap() + 12 * 3600 + 34 * 60 + 56)
        );
        assert_eq!(parse_rfc3339_utc("2026-07-16 12:34:56Z"), None);
        assert_eq!(parse_rfc3339_utc("2026-07-16T25:00:00Z"), None);
        assert_eq!(parse_rfc3339_utc("2026-07-16"), None);
    }

    // ── ranges ──

    #[test]
    fn day_range_bounds_and_prev() {
        let r = DayRange::new("2026-07-10", "2026-07-16").expect("range");
        assert_eq!(r.len_days(), 7);
        assert!(r.contains(parse_day("2026-07-10").unwrap()));
        assert!(r.contains(parse_day("2026-07-16").unwrap() + 86_399));
        assert!(!r.contains(parse_day("2026-07-17").unwrap()));
        let prev = r.prev();
        assert_eq!(prev.from, "2026-07-03");
        assert_eq!(prev.to, "2026-07-09");
        assert_eq!(prev.len_days(), 7);
        // Inverted and malformed ranges reject.
        assert!(DayRange::new("2026-07-16", "2026-07-10").is_none());
        assert!(DayRange::new("2026-02-30", "2026-07-10").is_none());
    }

    // ── folds ──

    fn sample_events() -> StatsEvents {
        let d = |s: &str| parse_day(s).unwrap();
        StatsEvents {
            purchases: vec![
                ev("q1", d("2026-07-10") + 10),
                ev("q1", d("2026-07-11") + 10),
                ev("q2", d("2026-07-01")), // outside the test range
            ],
            starts: vec![
                ev("q1", d("2026-07-10") + 20),
                ev("q2", d("2026-07-11") + 20),
                ev("q1", d("2026-07-11") + 30),
            ],
            finishes: vec![ev("q1", d("2026-07-11") + 40)],
        }
    }

    #[test]
    fn totals_filter_by_range_and_quest() {
        let ev = sample_events();
        let r = DayRange::new("2026-07-10", "2026-07-12").unwrap();
        assert_eq!(
            totals_in(&ev, &r, None),
            StatsTotals {
                purchased: 2,
                started: 3,
                finished: 1
            }
        );
        assert_eq!(
            totals_in(&ev, &r, Some("q2")),
            StatsTotals {
                purchased: 0,
                started: 1,
                finished: 0
            }
        );
    }

    #[test]
    fn daily_series_zero_fills_every_day() {
        let ev = sample_events();
        let r = DayRange::new("2026-07-10", "2026-07-12").unwrap();
        let daily = daily_series(&ev, &r);
        assert_eq!(daily.len(), 3);
        assert_eq!(daily[0].date, "2026-07-10");
        assert_eq!((daily[0].started, daily[0].finished), (1, 0));
        assert_eq!((daily[1].started, daily[1].finished), (2, 1));
        assert_eq!((daily[2].started, daily[2].finished), (0, 0));
    }

    #[test]
    fn quest_rows_include_zero_activity_and_sort_by_starts() {
        let ev = sample_events();
        let r = DayRange::new("2026-07-10", "2026-07-12").unwrap();
        let metas = vec![
            meta("q0", "Спящий"),
            meta("q1", "Тайны"),
            meta("q2", "Дозор"),
        ];
        let rows = quest_rows(&metas, &QuestLabels::default(), &ev, &r);
        assert_eq!(
            rows.iter().map(|r| r.quest_id.as_str()).collect::<Vec<_>>(),
            vec!["q1", "q2", "q0"]
        );
        assert_eq!(rows[0].started, 2);
        assert_eq!(rows[2].purchased, 0);
        assert!(rows.iter().all(|r| r.published));
    }

    #[test]
    fn quest_rows_take_every_name_from_the_label_seam() {
        // Listed or not, a row is named by the authoring registry — so the table
        // agrees with the moderation views and with its own drill-down.
        let ev = sample_events();
        let r = DayRange::new("2026-07-10", "2026-07-12").unwrap();
        let labels = labels(&[
            ("q1", "Тайны. Ремастер", Some("Москва")),
            ("q2", "Дозор", Some("Нови Сад")),
        ]);
        let rows = quest_rows(&[meta("q1", "Тайны")], &labels, &ev, &r);
        let row = |id: &str| {
            rows.iter()
                .find(|row| row.quest_id == id)
                .unwrap_or_else(|| panic!("{id} row"))
        };
        assert_eq!(row("q1").name, "Тайны. Ремастер", "renamed after publish");
        assert_eq!(row("q1").city.as_deref(), Some("Москва"));
        assert_eq!(row("q2").name, "Дозор", "never published, still named");
        assert_eq!(row("q2").city.as_deref(), Some("Нови Сад"));
    }

    #[test]
    fn quest_rows_keep_unlisted_quests_so_totals_reconcile() {
        // q2 has activity but no published meta: it must still get a row, else
        // the table stops summing to the KPI totals. With no registry entry
        // either, the id is the honest label.
        let ev = sample_events();
        let r = DayRange::new("2026-07-10", "2026-07-12").unwrap();
        let rows = quest_rows(&[meta("q1", "Тайны")], &QuestLabels::default(), &ev, &r);
        assert_eq!(rows.len(), 2);
        let ghost = rows
            .iter()
            .find(|row| row.quest_id == "q2")
            .expect("q2 row");
        assert!(!ghost.published);
        assert_eq!(ghost.name, "q2");
        assert_eq!(ghost.started, 1);
        let totals = totals_in(&ev, &r, None);
        let summed: u64 = rows.iter().map(|row| row.started).sum();
        assert_eq!(summed, totals.started);
    }

    #[test]
    fn overview_prev_is_optional() {
        let ev = sample_events();
        let r = DayRange::new("2026-07-10", "2026-07-12").unwrap();
        let with = project_overview(&[], &QuestLabels::default(), &ev, &r, true);
        assert!(with.prev.is_some());
        let without = project_overview(&[], &QuestLabels::default(), &ev, &r, false);
        assert!(without.prev.is_none());
    }

    #[test]
    fn overview_prev_counts_previous_window() {
        let d = |s: &str| parse_day(s).unwrap();
        let ev = StatsEvents {
            purchases: vec![ev("q1", d("2026-07-07"))],
            starts: vec![ev("q1", d("2026-07-08")), ev("q1", d("2026-07-11"))],
            finishes: vec![],
        };
        let r = DayRange::new("2026-07-10", "2026-07-12").unwrap();
        let o = project_overview(&[], &QuestLabels::default(), &ev, &r, true);
        assert_eq!(o.totals.started, 1);
        let prev = o.prev.expect("prev");
        assert_eq!(prev.started, 1);
        assert_eq!(prev.purchased, 1);
    }

    // ── funnel ──

    fn snapshot_json() -> serde_json::Value {
        serde_json::json!({
            "steps": [
                { "template": "start", "rich_content": { "title": "Старт: у башни" } },
                { "template": "video", "rich_content": { "title": "" } },
                { "template": "task_answer", "rich_content": { "title": "Задание: герб" } },
                { "template": "congrats" }
            ]
        })
    }

    #[test]
    fn snapshot_steps_titles_fall_back_to_template() {
        let steps = snapshot_steps(&snapshot_json());
        assert_eq!(
            steps,
            vec![
                ("Старт: у башни".to_string(), "start".to_string()),
                ("video".to_string(), "video".to_string()),
                ("Задание: герб".to_string(), "task_answer".to_string()),
                ("congrats".to_string(), "congrats".to_string()),
            ]
        );
        assert!(snapshot_steps(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn funnel_counts_reach_by_completed_prefix() {
        let logs = vec![
            // Started, no facts: reached step 0 only.
            vec![],
            // Completed step 0: reached steps 0 and 1.
            vec![fact(FactKind::PhysicalConfirmed, 0, false)],
            // Wrong answer completes nothing: reached step 0 only.
            vec![fact(FactKind::AnswerSubmitted, 1, false)],
            // Full run: attempt_completed at the terminal step reaches the end.
            vec![
                fact(FactKind::PhysicalConfirmed, 0, false),
                fact(FactKind::AnswerSubmitted, 2, true),
                fact(FactKind::AttemptCompleted, 3, false),
            ],
        ];
        assert_eq!(funnel_counts(4, &logs), vec![4, 2, 1, 1]);
        assert_eq!(funnel_counts(0, &logs), Vec::<u64>::new());
    }

    #[test]
    fn funnel_reach_clamps_to_steps_len() {
        // A fact at a position beyond the snapshot's steps must not panic or
        // overflow the vector (defensive: version drift).
        let logs = vec![vec![fact(FactKind::PhysicalConfirmed, 9, false)]];
        assert_eq!(funnel_counts(2, &logs), vec![1, 1]);
    }

    #[test]
    fn quest_detail_composes_funnel_and_totals() {
        let ev = sample_events();
        let r = DayRange::new("2026-07-10", "2026-07-12").unwrap();
        let m = meta("q1", "Тайны");
        let snap = snapshot_json();
        let logs = vec![vec![], vec![fact(FactKind::PhysicalConfirmed, 0, false)]];
        let renamed = labels(&[("q1", "Тайны. Ремастер", Some("Москва"))]);
        let d = project_quest_detail(&m, renamed.get("q1"), Some(&snap), &ev, &r, true, &logs);
        assert_eq!(d.name, "Тайны. Ремастер", "the seam names the detail too");
        assert_eq!(d.city.as_deref(), Some("Москва"));
        assert_eq!(d.totals.started, 2);
        assert_eq!(d.funnel_started, 2);
        assert_eq!(d.funnel.len(), 4);
        assert_eq!(d.funnel[0].reached, 2);
        assert_eq!(d.funnel[1].reached, 1);
        assert_eq!(d.funnel[0].title, "Старт: у башни");
        assert!(d.prev.is_some());
        // No snapshot data (legacy publish): empty funnel, honest zero.
        let d2 = project_quest_detail(&m, renamed.get("q1"), None, &ev, &r, false, &[]);
        assert!(d2.funnel.is_empty());
        assert_eq!(d2.funnel_started, 0);
    }

    #[test]
    fn earliest_event_day_scans_all_streams() {
        let ev = sample_events();
        assert_eq!(earliest_event_day(&ev, None).as_deref(), Some("2026-07-01"));
        assert_eq!(
            earliest_event_day(&ev, Some("q1")).as_deref(),
            Some("2026-07-10")
        );
        assert_eq!(earliest_event_day(&StatsEvents::default(), None), None);
    }
}
