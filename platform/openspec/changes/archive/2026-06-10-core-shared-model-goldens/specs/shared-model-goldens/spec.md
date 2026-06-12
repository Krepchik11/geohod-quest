## ADDED Requirements

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
The system SHALL implement pure projectState(facts) and projectBalance(facts) as deterministic folds that compute attempt state and player master coin balance from immutable facts (AttemptFact + CoinFact), matching client local projection exactly.

#### Scenario: Projects balance and state from happy-path playthrough golden
- **WHEN** facts from a playthrough golden (e.g. happy-with-gift including physical_confirmed, answer_submitted, gift_claimed, attempt_completed) are folded
- **THEN** projectBalance SHALL equal the expected_final_balance and projectState SHALL reflect completed steps, revealed hints, etc. matching the golden

### Requirement: TDD goldens from real exports in clean structure
The system SHALL maintain goldens (quest snapshots + playthroughs) in the clean structure (see goldens-clean/README.md) derived from real exported quest data, covering 4 templates, real answer matching, gifts, popup hints, navigator, bonuses, terminal, races, version freeze, and client/server fidelity.

#### Scenario: Goldens drive tests for full linear playthrough with real data
- **WHEN** a golden snapshot (with real acceptable lists and Page_type-mapped templates) + playthrough actions are used
- **THEN** tests SHALL assert isAnswerCorrect outcomes, emitted facts, projections, and no lost/double rewards

#### Scenario: Goldens cover race conditions from PLAN
- **WHEN** multi-device interleaved actions from a playthrough golden (concurrent devices, reset-during-play, version publish while active) are simulated
- **THEN** projections SHALL converge without lost/double facts or overdraft

### Requirement: Goldens and pure fns are the contract for future slices
All future capabilities (constructor, player PWA, sync backend) SHALL consume the shared model, pure functions, and goldens for their "Test match", local validation, publish, facts append, projectors, and tests. No implementation shall duplicate or diverge from this foundation.