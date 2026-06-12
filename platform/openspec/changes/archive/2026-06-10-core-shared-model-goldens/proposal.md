## Why

After completing real quest data exports (per the "Immediate Next Actions" in blueprint/PLAN.md), the project must implement the foundational shared model, pure functions, and TDD goldens before any feature slices (constructor, player, sync, etc.). This establishes the contract for invariants (client-authoritative snapshot validation, deterministic projections from facts, frozen amounts at publish, exact isAnswerCorrect matching) using real exported data. The monorepo skeleton is deliberately minimal and ready (YAGNI); without this, implementation risks recreating old Bubble problems (scattered logic, untested races, mutable state under players). Blueprints (CONCEPT/SPEC/TECH/PLAN) are now the sole source of truth.

## What Changes

- Introduce technology-agnostic shared model for GameStep (per SPEC: position, rich RU content, 4-role media, discriminated completion, additive supporting), facts (AttemptFact/CoinFact/FeedbackReport), QuestVersionSnapshot, etc.
- Implement pure, heavily testable functions (same logic for ctor, player, tests, bundler): isAnswerCorrect (exact client matching with real synonym lists), validateForPublish, serializeToSnapshot, projectState/projectBalance (deterministic folds for attempt state and player balance).
- Populate and maintain clean TDD goldens (quest snapshots + playthroughs with expected facts/projections) derived from real exported quest data (transformed into the perfect new structure in goldens-clean/).
- Add comprehensive tests: unit for fns, goldens for full playthroughs (4 templates, gifts, hints via popup, navigator, bonuses, terminal), property/adversarial for races (concurrent devices, reset-during-play, version freeze, overdraft, long offline), client/server projection fidelity.
- No breaking changes. This is pure foundation (no DB, no APIs, no UI yet).

**No breaking changes.**

## Capabilities

### New Capabilities
- `shared-model-goldens`: The core shared data model (GameStep, facts, snapshots per blueprints), pure functions for validation/matching/serialization/projection, and goldens (from real exports) for testing all invariants, client match fidelity, facts model, and race conditions. Enables all future slices with proven correctness.

### Modified Capabilities
(none — this introduces the foundational shared model and test data; no existing requirement-level specs are modified)

## Impact

- New shared types and pure functions will be the contract consumed by constructor (live Test match, gates, publish), player (local validation/projection/offline), backend (facts append, projectors, corrections), and tests/CI.
- Goldens live alongside exported data (in old-knowledgebase for now, movable); will drive TDD for Phase 2+.
- Likely introduces shared code location (e.g. packages/shared or dual TS/Rust with parity tests) when duplication appears (YAGNI until then).
- Affects future OpenSpec changes for slices (they will depend on this).
- No user-facing changes or DB yet.
- Aligns with TDD/SOLID/DRY/KISS/YAGNI + agent guidelines + blueprints as single source.

This change is complete once proposal, design, specs, and tasks are created and the foundation (types + fns + goldens + tests) is implemented and passing gates. It directly follows the updated PLAN.md Phase 2 and Immediate Next Actions (after exports).