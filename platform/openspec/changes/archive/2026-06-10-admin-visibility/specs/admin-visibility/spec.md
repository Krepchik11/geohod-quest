# admin-visibility

## Purpose

Per-version stats (grants, attempts, completion rates, submitted wrong answers, hints used, navigator clicks, FeedbackReports per step) computed as pure deterministic fold from append-only facts (idempotent sole source of truth for usage/hints/wrongs/nav/feedback/attempts/completion) + grants; list of FeedbackReports per quest/version (read-only for authors, thin append-only mid-quest with step context attached via existing Fact::FeedbackReported); admin visibility surface (small stats cards + read-only list); TDD goldens extended for stats computation + feedback listing + grant/attempt/completion correlation; 100% reuse of facts/snapshots/goldens/snap bindings; minimal backend + small frontend; YAGNI in-mem/simple, no advanced UI. Per PLAN Phase 3 Admin visibility after Player + Sync + Commerce/Marketplace; follows SPEC (FeedbackReport thin append-only, visible to admins per version/step for frozen snapshots quality) + TECH (facts unifying primitive for easy per-version analytics; server projectors for per-version analytics); reuses patterns from facts-sync (pure projectors + idemp + analytics pre-work + goldens fidelity) + marketplace-grants (reuse 100%, idemp source, TDD goldens RED first, small enhance, in-mem documented). (Purpose derived from proposal "New Capabilities" section; additive to facts/snapshots/prior player/grants contracts; no behavior change to append/idemp/player.)

## ADDED Requirements

### Requirement: Per-version stats are pure deterministic folds from facts (sole source) + grants; idempotent facts ensure accurate counts
The system SHALL provide pure functions (no side effects, no IO, deterministic, order-independent) that compute per-version (per-snapshot) stats: grants count (by quest from grants store), attempts count (attempts bound to snapshot via manifest), completion rate (fraction of bound attempts containing at least one attempt_completed fact), and per-step aggregates (wrongs_submitted = count of answer_submitted with local_is_correct=false at that step; hints_used, navigator_clicks, feedback_count from matching facts; FeedbackReports list per step). Stats SHALL be computed from the append-only fact logs of attempts bound to the snapshot + grants for the quest; idempotent natural-key appends (from facts-sync) SHALL ensure no double-counting on reconnects or concurrent devices. Stats SHALL be accurate even for historical versions (old attempts remain bound to their snapshot forever).

#### Scenario: Stats from happy-with-gift golden facts + edges + grant/attempt correlation
- **WHEN** a grant is created for quest "mystery-fortress-v1", an attempt is bound to snapshot "golden-mystery-fortress-v1", happy facts are appended (physical 0, answer "МИХАЙЛО ПУПИН" 1 with local_is_correct true, gift_claimed +5 at 2, attempt_completed 3), plus extra edges (wrong answer_submitted at 1 with false, hint_purchased at 1, feedback_reported at 1, navigator_used at 0), then admin stats are requested for the snapshot (and grants for quest)
- **THEN** grants count == 1 for the quest; attempts == 1 for the snapshot; completion rate == 1.0 (or 100%); per-step[1] reports wrongs_submitted==1, hints_used==1, feedback_count==1; per-step[0] reports navigator_clicks==1; overall feedback_count==1, hints_used==1, wrongs_submitted==1, navigator_clicks==1; project values match the pure analytics fold + grant/attempt correlation; no doubles.

#### Scenario: Idempotent reconnect or multi-device does not inflate per-version stats
- **WHEN** the same facts batch (or overlapping from another device) is appended again for the same attempt/snapshot (reconnect or multi-device)
- **THEN** stats (attempts, completions, per-step wrongs/hints/nav/feedback counts) are unchanged from before the duplicate append; idemp dedup (natural key) + pure fold ensures accuracy.

### Requirement: List of FeedbackReports per quest/version is read-only for authors; mid-quest step context attached
The system SHALL support read-only listing of FeedbackReports for a given quest (or its published versions/snapshots): each report SHALL include the step_position, note, device_id, local_is_correct, and bound snapshot context from the emitting fact (FeedbackReported variant). Reports SHALL be collected from all attempts bound to the matching snapshot (historical versions use their frozen snap). Listing SHALL be read-only (no edit/delete paths); authors (internal) can view for quality improvement on frozen content. Feedback SHALL continue to be appendable mid-quest from global menu (any step) via existing facts append (thin append-only like other facts).

#### Scenario: Mid-quest feedback on step 1 for versioned snapshot appears in per-version list
- **WHEN** during play on snapshot "golden-mystery-fortress-v1" (mid-quest at step 1), user opens global menu "Оставить отзыв", enters note, fact is appended as feedback_reported at step_position 1 with the note; later admin requests FeedbackReports list for the quest/version
- **THEN** the list for the snapshot contains exactly one entry for step 1 with the note (and device/context); report is visible read-only; no other facts are returned as "feedback"; append was idempotent (reconnect dupe would not duplicate the list entry).

#### Scenario: Feedback for historical version remains bound and listable separately from new version
- **WHEN** attempt A bound to v1 emits feedback at step 2; later quest publishes v2; new attempt B on v2 emits feedback at step 1
- **THEN** list for v1 snapshot shows only A's feedback (step 2); list for v2 shows only B's (step 1); historical frozen snapshot's reports are preserved independently.

### Requirement: Goldens TDD contract extended for stats/feedback flows + grant/attempt/completion correlation
Goldens (mystery-fortress-v1 snapshot + happy-with-gift playthrough with expected_facts) + replay harness SHALL drive TDD for the new capability: extend replay (or backend tests) with cases exercising stats computation (counts from happy + extra wrong/hint/feedback/nav edges), feedback listing (mid-quest reports appear in list for the snap), and grant/attempt/completion correlation (grant created, post-grant attempt on snap produces stats with attempts + completion). RED first (failing asserts on missing stats/list/corr), then impl to green. Existing happy "МИХАЙЛО ПУПИН" + gift +5 + edges + reconnect fidelity SHALL be preserved exactly (no change to prior projectors or facts).

#### Scenario: Replay extended covers stats computation + feedback listing + grant/attempt/completion corr
- **WHEN** replay harness builds happy facts + edges (including feedback_reported + wrong + hint + nav), creates grant, simulates post-grant attempt on the snap, then asserts on computed per-version stats (counts match expectations) + feedback list for snap contains the mid-step report + correlation (attempts==1, completions==1 after terminal)
- **THEN** all asserts pass (RED until pure stats projector + list fn + admin surface + backend routes); happy path + prior grant/reconnect cases untouched; goldens fidelity holds.

#### Scenario: Backend replay tests green on stats accuracy from golden facts
- **WHEN** backend tests deserialize happy expected_facts + edges, append via store to bound snap (after grant), call stats projector + list for the snap
- **THEN** stats match expected (per-step + overall + grant/attempt counts); list returns the feedback facts; idemp re-append does not change counts; all prior facts-sync golden tests remain green.

### Requirement: Admin visibility surface is small and reuses snapshots/goldens for versioned content
The frontend admin surface SHALL consist of small focused components (stats cards for grants/attempts/completion rates + per-step aggregates; read-only FeedbackReportsList per selected quest/version showing step + note + context). Components SHALL reuse 100% existing getSnapshot/goldens + shared for versioned content display (e.g. comic + template summary like marketplace); no dupe snapshot parsing or logic. Surface SHALL be additive (enhance landing or ctor or narrow co-located files); read-only for authors; explicit conditionals, derived state in render, narrow deps per react agents.

#### Scenario: Admin cards + list display accurate stats + read-only reports from golden play + feedback
- **WHEN** user (author) views admin surface (after play + mid-quest feedback on golden), selects version/snap; cards show grants/attempts/completion + per-step (wrongs/hints/etc); list shows the feedback reports (step, note) read-only
- **THEN** displayed values exactly match the pure projector results from the facts; no edit UI; versioned content (name/comic/summary) from snapshot/golden reuse; small comps only (no god); all prior player/marketplace flows untouched.

### Requirement: Backend stats + feedback list are minimal read-only projectors over existing stores; idempotent and pure
The backend SHALL expose minimal read-only endpoints (or handlers) returning per-version stats (pure fold) and FeedbackReports list for a snapshot/quest. Computation SHALL reuse/extend existing fact_logs, attempt_snapshots/manifests, grants, published meta + project_analytics (or additive pure fn); no mutable state outside append-only logs; reads SHALL be consistent with appends (under lock, pure recompute). Endpoints SHALL be additive (no change to facts append, grants, player); errors structured; in-mem with documented extension point for persist.

#### Scenario: GET stats/feedbacks for bound snap after facts + grant returns accurate pure results
- **WHEN** grant + facts (happy + feedback edge) appended for attempt bound to snap; then read-only stats + list requested
- **THEN** response contains accurate counts (from pure fold, matching projector on the log) + list of feedback facts (step+note); re-request after idemp reconnect yields identical results (no inflation); no side effects on stores.

### Requirement: Per-version stats and feedback lists survive version publish, active attempts, and multi-device
Stats and lists for a snapshot SHALL be independent of later publishes (old attempts stay bound; their facts/feedbacks remain in that version's aggregates). Active attempts (in-flight facts) SHALL contribute to live stats on next read (pure recompute). Multi-device facts SHALL merge cleanly (idemp union) with accurate additive counts in stats.

#### Scenario: Publish new version while attempt active; stats for old vs new are separate and correct
- **WHEN** attempt on v1 has facts + feedback; quest publishes v2; new attempt on v2 appends facts; admin requests stats/list for v1 and for v2
- **THEN** v1 stats/list reflect only v1-bound facts/feedback (including mid-quest); v2 separate; active facts on v1 still counted on read; no cross-contamination; grants (quest-level) visible in both version contexts as appropriate.

(These requirements + scenarios are directly testable via backend unit/integration tests that deserialize goldens, exercise the pure fns + stores + handlers against the Axum router, assert on response bodies + internal state, and via frontend replay + manual. They map 1:1 to the decisions/edges in design and proposal while remaining implementation-free. All preserve invariants from facts as sole source, snapshots frozen, client auth, idemp, and prior cycle fidelity.)