## Why

The quest constructor is the only entry point for content that becomes frozen in immutable snapshots for players. Bad or incorrect content published in a version is permanent for any player who started an attempt against that snapshot (per core invariants in blueprint/CONCEPT.md and SPEC.md). Now that the shared model, pure functions (including isAnswerCorrect), and TDD goldens (from the previous core-shared-model-goldens change) are in place, we must build the authoring surface that uses live "Test match" and pre-publish gates to make it "hard to publish bad". This directly follows the "Start with the constructor slice" recommendation in blueprint/PLAN.md (Phase 3 priority and Immediate Next Actions).

## What Changes

- Add Quest Constructor capability in the frontend (Next.js RSC + client components where needed per agents/react.md).
- 4-template picker (Первый экран / Задание без ответа / Задание с ответом / Продолжить) that pre-fills mode, supporting fields, button/confirm copy.
- Sortable step list + metadata form for quests.
- Per-step editor with structured AnswerListEditor (chips/rows, "Paste lines", live "Test match" using the exact shared isAnswerCorrect + goldens).
- Gift subform (narrative + coins + explicit "this freezes in the snapshot" note).
- 4-role comic upload zones (task/character/hint/atmosphere) + thumbnails.
- Navigator geo picker + "enable navigator button (optional hint / shortest route)" toggle (visible on physical steps).
- Animation/voice asset assignment for task bonuses.
- Popup hint wiring (default for answer tasks).
- Per-step mini-preview using real shared player components against the current draft.
- Pre-publish checklist + gates (primary comic required for Task templates, valid answers count, geo sanity, est size, no terminal warning, etc.) + "dry-run serialize".
- Explicit Publish action that creates immutable QuestVersionSnapshot + triggers bundle materialization.
- "Save + open in real player as test user" (persists draft, creates temp grant, opens real PWA flow to exercise popup, navigator, anim/voice, feedback, rating spend).
- Import tab (YAML/JSON paste or file → strict parse/validate → load into list); "Export current as YAML".
- Small focused components + shared renderers with the player side; no god objects.
- Use the existing shared-model-goldens capability and goldens for live validation and tests.

**No breaking changes.** This is additive foundation for content authoring (internal admins only).

## Capabilities

### New Capabilities
- `quest-constructor`: The internal-only quest authoring surface. Supports the 4 primary templates, structured data entry for correctness (answers, gifts, supporting behaviors), 4-role comics, navigator, animations, popup hints, visual mini-previews, pre-publish gates + explicit Publish that produces frozen snapshots per the model in blueprint/SPEC.md. Uses live shared isAnswerCorrect and goldens for "Test match" and validation. Enables "hard to publish bad" while satisfying client "Описание сайта" requirements (3 components, 4 templates, comics per page with 4 roles, navigator as optional hint, etc.).

### Modified Capabilities
(none — this introduces a new capability; no changes to requirements of existing specs like shared-model-goldens)

## Impact

- Primarily frontend (Next.js in platform/frontend): new pages/components under the constructor section of the 3-component app.
- Consumes the shared model, pure functions, and goldens from the previous change for live "Test match", gates, and TDD.
- Affects future slices: player will render the same 4 templates + mini-previews; publish flows will use serializeToSnapshot; goldens will be extended with more real data from ctor.
- No backend changes yet (YAGNI per PLAN; publish/bundle will come in later slices or as part of this if needed for MVP).
- No DB or auth changes (internal admins only; uses existing temp grant for "test in real player").
- Follows all principles: TDD (goldens-driven), SOLID/DRY (small components + shared renderers with player), KISS/YAGNI (lean form + ordered list baseline, "Save + real player test" acceptable for preview), agent guidelines (react.md for perf, no waterfalls, etc.).
- Goldens in old-knowledgebase/discovery/goldens-clean/ (and copies in platform) will be used/extended for testing the new UI flows and validation.

This change is complete once the artifacts are written and the tasks are implemented and verified with gates. It is the direct next step after shared model + goldens per the updated PLAN.md.