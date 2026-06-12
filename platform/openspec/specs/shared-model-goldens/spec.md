# shared-model-goldens

## Purpose

The core shared data model (GameStep, facts, snapshots per blueprints), pure functions for validation/matching/serialization/projection, and goldens (from real exports) for testing all invariants, client match fidelity, facts model, and race conditions. Enables all future slices with proven correctness.
## Requirements
### Requirement: Shared GameStep model
The system SHALL provide a technology-agnostic shared model for GameStep exactly matching the shape in blueprint/SPEC.md: position, rich Russian content (title, main_text, place_text, button variants, etc.), media as explicit 4-role object (task/character/hint/atmosphere), discriminated completion (mode physical|answer + optional acceptable list + allow_note), and additive supporting behaviors (gift, hint, navigator with lat/lng, bonus_animation, physical_action, terminal, narrative_advance, is_start, etc.).

#### Scenario: Model represents a complete step from real export data
- **WHEN** a golden quest snapshot is loaded (e.g. golden-mystery-fortress-v1 with Page_type-derived template and real acceptable lists)
- **THEN** the GameStep SHALL have position, rich_content populated from RU text, media roles (stubbed where legacy single-image), completion with mode and acceptable from export, supporting for present behaviors (e.g. gift or hint)

### Requirement: Pure isAnswerCorrect function
The system SHALL implement a pure isAnswerCorrect(submitted, acceptableList) function that performs exact client matching (basic membership/contains after trim/normalize per blueprint locked decisions) and is the single source of truth used by constructor "Test match", player local validation, tests, and any bundler.

#### Scenario: Matches real synonym answers from exported quests
- **WHEN** submitted value is "МИХАЙЛО ПУПИН" and acceptableList is ["ПУПИН", "МИХАЙЛО ПУПИН"] (from real export)
- **THEN** isAnswerCorrect SHALL return true (local_is_correct claim matches)

#### Scenario: Rejects incorrect answers
- **WHEN** submitted value is "wrong" and acceptableList is a real list from goldens
- **THEN** isAnswerCorrect SHALL return false

### Requirement: Pure validateForPublish and serializeToSnapshot
The system SHALL provide pure validateForPublish(draft) returning {errors, warnings, estBundleMB} and serializeToSnapshot(draft) producing the exact frozen bundle shape (per SPEC) for use in ctor gates, publish, and goldens.

#### Scenario: Validates a draft from clean golden structure
- **WHEN** a draft matching the goldens-clean structure (with required primary comic for Task templates, valid answers count) is passed
- **THEN** validateForPublish SHALL return no errors and serializeToSnapshot SHALL produce a snapshot with all fields frozen

### Requirement: Pure projection functions for facts
The system SHALL implement pure projectState(facts) and projectBalance(facts) as deterministic folds that compute attempt state and player master coin balance from immutable facts (AttemptFact + CoinFact), matching client local projection exactly. The fact vocabulary SHALL include `completion_bonus` (+5, once per player+quest) and SHALL NOT include any compensation/correction fact types (`balance_corrected`, `version_mismatch_corrected` are removed). projectBalance is a plain signed sum and MAY return negative values; no clamping exists in the shared model (display flooring at 0 applies only to the personal rating in profile UI).

#### Scenario: Projects balance and state from happy-path playthrough golden
- **WHEN** facts from a playthrough golden (e.g. happy-with-gift including physical_confirmed, answer_submitted, gift_claimed, completion_bonus, attempt_completed) are folded
- **THEN** projectBalance SHALL equal the expected_final_balance and projectState SHALL reflect completed steps, revealed hints, etc. matching the golden

#### Scenario: Negative balance passes through the shared fold unclamped
- **WHEN** facts containing hint spends exceeding total earnings are folded
- **THEN** projectBalance returns the exact negative sum, and projectState carries it unchanged.

#### Scenario: Wrong answer submissions do not mark a step completed
- **WHEN** the log contains answer_submitted at step 2 with local_is_correct=false and no other facts for step 2
- **THEN** projectState.completedSteps does not include 2 (only correct answers, physical confirms, and attempt completion complete a step); the attempt-advance offer therefore never fires off a wrong answer.

### Requirement: TDD goldens from real exports in clean structure
The system SHALL maintain goldens (quest snapshots + playthroughs) in the shared parity fixture location (platform/goldens/) consumed by both the TypeScript and Rust test suites, derived from real exported quest data where available, covering the 7 canonical templates, real answer matching, gifts, popup hints, navigator, completion bonus, terminal, races, version freeze, and client/server fidelity. Frontend-only golden copies SHALL be removed or re-pointed to the shared location.

#### Scenario: Goldens drive tests for full linear playthrough with real data
- **WHEN** a golden snapshot (with real acceptable lists and templates from the 7-template vocabulary) + playthrough actions are used
- **THEN** tests SHALL assert isAnswerCorrect outcomes, emitted facts, projections, and no lost/double rewards

#### Scenario: Goldens cover race conditions from PLAN
- **WHEN** multi-device interleaved actions from a playthrough golden (concurrent devices, reset-during-play, version publish while active) are simulated
- **THEN** projections SHALL converge without lost or doubled facts; balances may legally be negative and remain so.

### Requirement: Goldens and pure fns are the contract for future slices
All future capabilities (constructor, player PWA, sync backend) SHALL consume the shared model, pure functions, and goldens for their "Test match", local validation, publish, facts append, projectors, and tests. No implementation shall duplicate or diverge from this foundation.

#### Scenario: Future slices use the shared contract exclusively
- **WHEN** any future capability (constructor, player PWA, sync backend) is developed
- **THEN** it SHALL consume the shared model, the pure functions, and the goldens (no duplication or divergence allowed)

### Requirement: Client derives sync corrections from projection diffs
The shared model SHALL provide a pure helper that, given the pre-sync local projection and the post-sync authoritative projection, returns the applicable SPEC corrections: a balance re-projection notice {old, new} when balances differ after a merge, and an attempt-advance offer {local_step, server_step} when the authoritative furthest completed step exceeds the local position. The helper SHALL be the only source of correction UI events; no correction facts exist.

#### Scenario: Diff produces balance notice and advance offer after multi-device merge
- **WHEN** local projection has balance 5 / furthest step 2 and the authoritative post-sync projection has balance 3 / furthest step 4
- **THEN** the helper returns both a balance notice {old: 5, new: 3} and an advance offer {local_step: 2, server_step: 4}; with identical projections it returns neither.

