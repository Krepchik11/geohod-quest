# phase4-polish

## Purpose

Ctor import/export (YAML preferred) as power path for bulk ops and migration (YAML/JSON paste or file → strict parse/validate using shared model + goldens loaders + validateForPublish → load into ctor list; "Export current as YAML" roundtrippable); per-version analytics surfaced in ctor and admin views (pure deterministic fold from append-only facts + grants + snap bindings, reuse existing surfaces); migration job (one-time, idempotent): historical grants + answer_card data → synthetic legacy snapshots + facts (reuse exact Fact/QuestSnapshot shapes), audit diffs vs old scalars (pure projector, manual review output, no auto), mark imported items (pre-check + marker for idemp); measure (post-MVP where possible): real bundle sizes with actual comics + audio + nav data, ctor velocity and defect rate with new visual/UX fields and gates, sync correction rate, player feedback on any-page "Оставить отзыв"/navigator button/popup hint UX/animated bonuses, abuse patterns on rating spend (if enabled), update invariants and 08_DECISIONS_LOG with any new learnings + re-run adversarial review if client data or real quest exports reveal new edges; TDD goldens extended for migration/measurement flows (RED first then green); 100% reuse facts/snapshots/goldens (no dupe logic); small comps (enhance existing ctor stub + admin/ctor surfaces); minimal backend (in-mem/simple idempotent like grants/facts); YAGNI (in-mem for migration data, basic measurement, no advanced UI); rust/react agents; survives races via idemp/pure/snap freeze/goldens TDD. Per PLAN Phase 4 after Player + Sync + Commerce + Admin visibility; follows SPEC/TECH (ctor import/export, per-ver analytics from facts, migration synth+audit+mark notes, post-MVP meas, update 08/invariants); reuses patterns from facts-sync (pure projectors + idemp + goldens fidelity), marketplace-grants (reuse 100%, idemp source, TDD RED, small enhance, in-mem doc), admin-visibility (per-ver pure from facts, surface reuse, TDD goldens + corr, self-crit). (Purpose derived from proposal "New Capabilities" section; additive to facts/snapshots/prior player/grants/ctor contracts; no behavior change to append/idemp/player/grants/publish/snap freeze.)

## ADDED Requirements

### Requirement: Ctor import/export (YAML preferred) is power path for bulk ops and migration with strict parse/validate/load and roundtrippable export
The system SHALL provide in the Quest Constructor an import/export surface (enhance existing stub): YAML/JSON paste textarea or file input (accept .yaml/.yml/.json) → strict parse (JSON or YAML subset) + validate (reuse shared loadQuestSnapshot + isAnswerCorrect + validateForPublish against goldens structure + gates) → load into the sortable EditorQuest step list for editing; "Export current as YAML" SHALL produce roundtrippable output (structured content saved with .yaml extension, JSON-compatible subset for fidelity). This SHALL serve as power path for bulk authoring ops and migration of legacy content into snapshots/facts. Import/export SHALL preserve all GameStep fields (4 templates, rich content, 4-role media, supporting gift/hint/navigator/bonus/physical etc) and roundtrip with goldens samples exactly for TDD.

#### Scenario: Author imports valid YAML/JSON matching golden structure and loads into list
- **WHEN** author pastes or selects a file with valid quest definition (JSON or YAML subset matching golden-mystery-fortress-v1 structure: steps with template, rich_content, media, completion, supporting) and triggers import
- **THEN** it is strictly parsed, validated (no errors from validateForPublish + shared matchers), and loaded into the ctor step list (name + steps editable, positions updated); prior draft replaced safely; gates re-eval on loaded content.

#### Scenario: Author exports current draft as YAML and roundtrips back to import
- **WHEN** author edits a quest (add step, set answers/gift/nav), clicks "Export current as YAML", then imports the downloaded .yaml content
- **THEN** exported content is valid structured (YAML-pref ext + content), re-import parses/validates cleanly and restores identical EditorQuest state (steps, templates, acceptable lists, supporting amounts frozen note); goldens fidelity holds; no data loss.

#### Scenario: Invalid import (malformed or failing gates) is rejected with clear error
- **WHEN** author attempts import of malformed JSON/YAML or content failing pre-publish gates (e.g. answer task missing acceptable or primary task comic)
- **THEN** import fails with message (parse error or gate violations from validateForPublish); ctor list unchanged; no partial load.

### Requirement: Per-version analytics are surfaced in ctor and admin views as pure folds from facts (sole source) + grants
The system SHALL surface per-version analytics (grants count by quest, attempts/completion rate + per-step wrongs_submitted/hints_used/navigator_clicks/feedback_count from facts of attempts bound to snapshot via manifest) in both admin views (existing surface reuse) and ctor (narrow additive for published versions from goldens/PublishedMeta). Analytics SHALL be pure deterministic folds (reuse/extend project_version_stats + list_feedbacks_for_snapshot over fact_logs + attempt_snaps + grants); read-only for authors; accurate for historical versions (old attempts bound forever) and live (pure recompute). Mid-quest feedback and usage SHALL appear in per-version lists/stats.

#### Scenario: Per-version stats + FeedbackReports list visible in admin and ctor after play + mid-quest feedback on golden
- **WHEN** grant created + play (happy + edges: wrong/hint/feedback_reported/nav at steps) + mid-quest "Оставить отзыв" on snapshot "golden-mystery-fortress-v1"; then author views admin surface and ctor per-version analytics for the snap
- **THEN** both surfaces show grants==1, attempts==1, completion==1, per_step[1].wrongs==1 + hints==1 + feedbacks==1, per_step[0].nav==1, feedback list contains the mid-step report (step+note read-only); values exactly match pure projector; ctor surface reuses same goldens/snap for versioned content (no dupe).

#### Scenario: Per-version analytics for historical vs new version are separate and correct after publish
- **WHEN** attempt + feedback on v1; quest publishes v2 (new snap); new attempt + feedback on v2; admin/ctor request stats/list for v1 and v2
- **THEN** v1 stats/list reflect only v1-bound facts/feedback (incl mid-quest); v2 separate; no cross-contamination; grants (quest-level) visible appropriately; pure recompute accurate even if publish during active attempt.

### Requirement: Migration job is one-time and idempotent: historical grants + answer_card data produce synthetic legacy snapshots + facts; audit diffs vs old scalars; items marked imported
The system SHALL support a one-time idempotent migration job: input historical grants + answer_card data (mocks or real exports) → output synthetic legacy snapshots (QuestSnapshot at export-time content using goldens/snap structure) + facts (reuse Fact variants with submitted values, best-effort coins/timestamps, natural keys); job SHALL check marker first (e.g. "legacy_imported" note or source on grant/fact) and be no-op on re-run (idemp); produce audit diffs report (pure projector e.g. project_balance(synth_facts) vs recorded old scalar bal + per-step diffs; manual review output, no auto-adjust per TECH); mark imported items (marker persisted on synth grants/facts). Post-migration new system clean; legacy attempts use synth snapshots/facts.

#### Scenario: Migration on mock historical grants + answer_card for golden quest produces accurate synth + audit pass + mark; re-run is idemp no change
- **WHEN** migration job run with mock historical (old grant for "mystery-fortress-v1" + answer_card data for steps incl wrong at 1 + gift5 at 2 + completion); then re-run same job
- **THEN** first run: synth legacy snapshot matches golden-mystery-fortress-v1 structure (frozen content), synth_facts include answer_submitted/gift_claimed/attempt_completed etc with expected deltas + project_balance==5 + per-step; audit_report shows "bal match: 5", "wrongs diff: 0", "no scalar mismatch"; items marked "legacy_imported"; second run: no new synth/facts/marks, audit identical, idemp (no dupe, no inflate).

#### Scenario: Audit diffs flag scalar mismatch for manual review; no auto adjust; historical version preserved separately
- **WHEN** migration synth for quest with old scalar bal=7 but synth facts project to 5 (intentional diff from legacy)
- **THEN** audit_report contains flagged "bal diff: old=7 synth=5 (manual review required, no auto-adjust)"; synth facts/snap still created + marked; old scalar untouched; new attempts on live version use fresh not legacy synth.

#### Scenario: Version publish or concurrent attempt during/after migration does not corrupt or dupe
- **WHEN** migration synth for historical v1; later publish v2; attempt on v2; re-run migration
- **THEN** v1 synth snap/facts/marks preserved independently (bound attempts stay on v1 synth); v2 unaffected; re-run migration idemp (no dupe on v1 synth); stats/audits for v1 separate.

### Requirement: Measurement (post-MVP) covers real bundle sizes, ctor velocity/defect, sync corr rate, player feedback UX, abuse patterns; invariants/08_DECISIONS_LOG updated + adversarial re-run on new edges
The system SHALL support post-MVP measurement (basic, no advanced auto UI/instr per YAGNI): real bundle sizes with actual comics + audio + nav data (reuse validateForPublish est + manual with goldens from discovery exports + actual assets); ctor velocity and defect rate with new visual/UX fields and gates (manual timing + gate fail counts on valid/invalid drafts); sync correction rate (pure fold count of correction facts / appends from facts logs); player feedback on any-page "Оставить отзыв", navigator button, popup hint UX, animated bonuses (counts + notes from FeedbackReported + per-step analytics + usage facts); abuse patterns on rating spend (if enabled: facts fold for RATING_SPEND or equivalent); explicit update to invariants and 08_DECISIONS_LOG with learnings (e.g. migration accuracy, measured sizes/rates, UX notes); re-run full adversarial review if client data or real quest exports reveal new edges (covered in tasks/manual). Measurements SHALL be pure where possible or manual+goldens documented.

#### Scenario: Post-MVP manual measurement of bundle size + ctor vel + sync corr + player fb on golden + update 08
- **WHEN** manual measure: run validateForPublish on golden with 4-role comics/nav/audio notes (real assets from exported); time ctor add 4-role step + gate run (defect=0 on valid); replay happy+edges facts, count corr facts for rate; play + mid "Оставить отзыв" + nav + popup hint + bonus, inspect analytics/Feedback list; add learnings to 08_DECISIONS_LOG + re-run deconstruct note
- **THEN** bundle est reported (e.g. <=5MB target with comics); ctor vel ~N min/step, defect 0; corr rate 0 on happy or X on edges; fb/UX counts match (1 feedback, 1 nav, 1 hint spend, bonus claimed); 08 updated with e.g. "Phase4: migration idemp via mark accurate; real bundle ~4.2MB w/ comics; no abuse on golden; re-adv passed"; adversarial re-run confirms no new edges or notes them.

#### Scenario: Abuse pattern (if rating spend enabled) and sync corr captured in measurement from facts
- **WHEN** facts include multiple RATING_SPEND (if enabled) or high hint spends on easy quest + corr facts; measurement fold run
- **THEN** abuse pattern reported (e.g. "rating spend count high relative to completions"); corr rate calculated; pure from facts (no mutable).

### Requirement: Goldens TDD contract extended for migration and measurement flows
Goldens (mystery-fortress-v1 snapshot + happy-with-gift playthrough with expected_facts + grant/edges from prior) + replay harness SHALL drive TDD: extend with cases for migration (mock historical grants + answer_card → synth legacy snap + facts, audit diffs report expected, mark, re-run idemp no change) + measurement (bundle est, ctor gate defect, corr rate, fb/abuse counts, 08 update note); RED first (failing asserts before phase4 code), then impl to green. Existing happy "МИХАЙЛО ПУПИН"+gift+5+edges + reconnect/grants/admin fidelity SHALL be preserved exactly (no change to prior projectors/facts/ctor).

#### Scenario: Replay extended covers migration synth/audit/mark + measurement rates + prior fidelity
- **WHEN** replay harness builds mock historical + calls future synth/audit/mark + asserts on synth snap structure match golden, facts project bal=5 + per-step, audit "diffs 0", marked true, re-run no-op; + meas asserts (bundle<=target, corr_rate==0 on happy, fb from feedback facts, update note); prior happy/grant/reconnect/admin cases run
- **THEN** all new asserts pass (RED until pure migration fns + enhance + meas support); happy path + prior untouched; goldens fidelity holds.

#### Scenario: Backend replay tests green on migration fidelity + measurement from golden facts
- **WHEN** backend tests use happy+edges + mock historical, call synth/audit + assert report + marks + rates from facts
- **THEN** synth/audit/mark accurate; meas rates match; all prior facts-sync golden tests + admin stats + grants remain green.

### Requirement: Migration/measurement/ie/analytics preserve 100% reuse, small comps, YAGNI, idemp, facts/snapshots sole source, and survive races
All new flows SHALL 100% reuse facts/snapshots/goldens (no dupe parse/project/synth logic; import uses shared loaders, migration reuses Fact/QuestSnapshot/project_*, analytics/meas reuse project_version_stats + existing surfaces); small comps (enhance ctor stub + admin/ctor, narrow UI); YAGNI (in-mem marks, basic meas, no adv UI/persist); idempotent (migration pre-check + mark like grants/facts; pure reads); facts/snapshots sole source (pure folds, no mutable state); survive races (migration idemp on re-run/publish/attempts via mark/pure; audit pure/manual; meas accurate via facts even concurrent/long offline/multi-device via idemp union + recompute; version publish mid unaffected; player fb/abuse from append-only).

#### Scenario: All flows idempotent/pure/reuse on reconnect + version publish + concurrent
- **WHEN** migration run, import/export roundtrip, analytics fetch, meas rates during active play + reconnect facts + publish new version + concurrent sim
- **THEN** no dupe facts/marks/synth (idemp); pure values unchanged on re-fetch/re-run; reuse greps confirm no local reimpl of shared/project; stats/meas accurate (idemp protects); historical v1 untouched by v2 publish; no races hit (pure + lock + snap freeze + natural keys).

(These requirements + scenarios are directly testable via backend unit/integration tests that deserialize goldens, exercise pure fns + stores + handlers against the Axum router, assert on response bodies + internal state + marks + audit reports, and via frontend replay + manual. They map 1:1 to the decisions/edges in design and proposal while remaining implementation-free. All preserve invariants from facts as sole source, snapshots frozen, client auth, idemp, and prior cycle fidelity. Goldens TDD contract non-negotiable for migration/measurement accuracy.)