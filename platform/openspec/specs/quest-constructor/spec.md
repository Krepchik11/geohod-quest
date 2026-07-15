# quest-constructor

## Purpose

The internal-only quest authoring surface (Quest Constructor) is the sole entry point for content that becomes frozen into immutable QuestVersionSnapshots for players (per core invariants). It delivers the 4 primary templates via a picker with pre-fills, Structured AnswerListEditor with live "Test match" using the exact shared isAnswerCorrect function and goldens, 4-role comic upload zones (task/character/hint/atmosphere), Navigator + supporting behaviors (gifts, hints, physical_action, etc.), pre-publish gates + checklist + "dry-run serialize", explicit Publish that creates immutable snapshots and triggers materialization, "Save + open in real player as test user" for end-to-end validation in the real PWA flow, import/export (YAML/JSON), and is implemented entirely from small, single-responsibility components with shared renderers (e.g. StepPreview, AnswerListEditor) also used by the player. This makes it "hard to publish bad" and satisfies the client requirements while building directly on the shared-model-goldens capability. (Purpose derived from the quest-constructor proposal's Why and New Capabilities sections.)

## Requirements

### Requirement: 4-template picker with pre-fills
The Quest Constructor SHALL provide a picker for the four primary templates (Первый экран / Задание без ответа / Задание с ответом / Продолжить) that pre-fills sensible defaults for mode, supporting behaviors, button text, and confirmation copy based on the selected template.

#### Scenario: Author selects "Задание с ответом" template
- **WHEN** author adds a new step and selects the "Задание с ответом" template
- **THEN** the editor pre-fills completion.mode to "answer", shows AnswerListEditor, and sets default button text to a sensible value like "Ответить"

### Requirement: Structured AnswerListEditor with live Test match
The system SHALL provide a structured AnswerListEditor (supporting chips/rows, reorder, "Paste lines" helper) for answer tasks, with a live "Test match" box that uses the exact shared isAnswerCorrect function and goldens data to validate submissions against the current acceptable list.

#### Scenario: Author pastes lines and tests a submission
- **WHEN** author pastes multiple lines into the AnswerListEditor and enters a submission in the live Test match box
- **THEN** the list is parsed (trimmed, deduped), and the Test match immediately shows whether the submission would be accepted using the real isAnswerCorrect logic from goldens

### Requirement: 4-role comic upload zones
The Constructor SHALL support per-step upload zones for 4 comic roles (task, character, hint, atmosphere) with thumbnails, where task role is required for Task templates and hint role is used for coin-gated reveals.

#### Scenario: Author uploads images for a task step
- **WHEN** author uploads images to the 4-role zones for a "Задание без ответа" step
- **THEN** the step stores media.task, media.character, media.hint, media.atmosphere (task is mandatory for publishing gates)

### Requirement: Navigator and supporting behaviors
The system SHALL allow configuration of navigator (geo picker + enable toggle with hint_only/shortest_route options, visible on physical steps), gifts (coins + narrative with freeze note), hint costs, physical_action metadata, bonus_animation, and other supporting fields per the GameStep model in blueprint/SPEC.md.

#### Scenario: Author enables navigator on a physical step
- **WHEN** author adds a physical step, enables the navigator toggle, and picks lat/lng
- **THEN** the step records supporting.navigator with the data, and the toggle is only shown for physical/Task-no templates

### Requirement: Pre-publish gates and checklist
The Constructor SHALL enforce pre-publish validation gates and a checklist (primary comic for Task templates, >=1 acceptable for answer steps, valid answers count, geo sanity, bundle size est, no missing terminal, etc.) with "dry-run serialize" before allowing explicit Publish.

#### Scenario: Author attempts to publish without primary comic on a task step
- **WHEN** author clicks Publish on a draft missing media.task on a "Задание с ответом" step
- **THEN** the gate blocks publish, shows error in checklist, and offers "dry-run serialize" to preview the would-be snapshot

### Requirement: Explicit Publish and immutable snapshot
The system SHALL support an explicit Publish action that creates a new immutable QuestVersionSnapshot (frozen GameSteps with all content, acceptable lists, supporting amounts, media refs) and triggers bundle materialization. Old attempts remain bound to their original version.

#### Scenario: Author publishes a quest
- **WHEN** author completes the checklist and clicks the explicit Publish button
- **THEN** a new snapshot version is created with frozen data matching the draft at publish time, and the quest becomes available in the marketplace for new grants/attempts

### Requirement: "Save + open in real player as test user"
The Constructor SHALL support "Save + open in real player as test user" that persists the current draft, creates a temporary grant, and opens the real PWA player flow (exercising popup hints, navigator, animated bonuses, any-page feedback, rating spend) against the draft.

#### Scenario: Author tests a draft end-to-end
- **WHEN** author clicks "Save + open in real player as test user" on a draft with gifts, answers, and navigator
- **THEN** the real player opens (with temp grant), allows playing the 4 templates, spending coins on hints, claiming gifts, and the experience matches the live shared functions and goldens

### Requirement: Import and export
The Constructor SHALL support an import tab (YAML/JSON paste or file → strict parse/validate/load using the shared model) and "Export current as YAML" for power-user bulk operations and future migration.

#### Scenario: Author imports a quest definition
- **WHEN** author pastes a valid YAML/JSON quest definition (matching the goldens-clean structure) into the import tab
- **THEN** it is parsed, validated against the model/gates, and loaded into the sortable step list for editing

### Requirement: Full quest backup export (zip)
The backend SHALL provide `GET /api/constructor/quests/{quest_id}/export`, owner-or-admin gated like every other per-quest constructor route, that returns a single zip archive containing the complete quest record: `manifest.json` (format version, export timestamp, quest id), `quest.json` (the full constructor quest — name, attributes, all steps, cover), and every media file the quest references under `media/<hash>.<ext>`, with `quest.json`'s media URLs rewritten to those zip-relative paths so the archive is self-contained and portable between environments. The export is quest content ONLY — play/rating stats (completions, buyers, reviews) are live projections of the fact log, not quest content, and are excluded. This is a distinct capability from the "Export current as YAML" content-only round-trip above — it is a full backup/migration artifact, not an editor paste target.

#### Scenario: Author downloads a full quest backup
- **WHEN** the quest's author (or an admin) requests `GET /api/constructor/quests/{quest_id}/export`
- **THEN** the response is a zip archive whose `quest.json` media fields point at `media/<hash>.<ext>` entries also present in the archive, and whose `stats.json` reports the quest's current completions, buyers, and (if published) version stats and reviews

#### Scenario: Non-owner requests another author's export
- **WHEN** a non-admin editor who does not own the quest requests its export
- **THEN** the response is 404, the same opaque not-found every other per-quest constructor route returns for a non-owner

### Requirement: Small focused components and shared renderers
All constructor UI SHALL be built from small, single-responsibility components with shared renderers (e.g., StepPreview, AnswerListEditor) that are also used by the player side, avoiding god objects and duplication.

#### Scenario: Mini-preview renders a draft step
- **WHEN** author views the per-step mini-preview
- **THEN** it uses the exact same player component/renderer that will be used in the live PWA (against the current draft values and goldens)
