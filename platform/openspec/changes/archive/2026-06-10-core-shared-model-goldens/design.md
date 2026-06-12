## Context

The project has completed real quest data exports (fulfilling the first "Immediate Next Actions" from blueprint/PLAN.md) and maintains clean goldens in the new structure (goldens-clean/ under archived discovery data, derived from real exports + adversarial mapping to exact SPEC shape).

Current platform/ is a high-quality minimal skeleton (Rust Axum backend with health/config/errors/layers/tests per agents/rust.md; Next.js 16/React 19 RSC frontend with 3-component landing per agents/react.md and CONCEPT). No domain logic, DB, or packages/ yet (YAGNI). Blueprints (../blueprint/) are the sole primary source; old analyses/legacy docs are archived.

This design implements Phase 2 of PLAN: shared types (technology-agnostic first), pure functions (isAnswerCorrect, validateForPublish, serializeToSnapshot, projectState/projectBalance), and TDD goldens (quest snapshots + playthroughs with expected facts/projections) using the clean fixtures. This foundation must exist before slices (constructor first per priority, then player, sync, commerce) to prove invariants with real data and avoid old Bubble anti-patterns.

Proposal context: new capability `shared-model-goldens`.

## Goals / Non-Goals

**Goals:**
- Define a clean, readable, maintainable shared model exactly matching SPEC.md (GameStep with 4-role media, discriminated completion, additive supporting; facts; snapshots) + CONCEPT invariants.
- Implement pure functions as the single source of truth (used by ctor "Test match", player local validation/projection, bundler, tests, future backend).
- Establish TDD goldens from real exported data (transformed to the perfect new structure) covering 4 templates, answer matching with synonyms, gifts, hints (popup), navigator, bonuses, terminal, races, version freeze, client/server fidelity, facts emission + projections.
- Enable all future OpenSpec slices with proven correctness, following TDD/SOLID/DRY/KISS/YAGNI + agent guidelines + blueprints.
- Technology-agnostic model first (e.g. JSON schema + TS interfaces as starting point); language-specific impls (TS for frontend goldens/ctor/player parity) only when needed.

**Non-Goals:**
- No DB, APIs, publish/attempt endpoints, UI components, or backend projectors yet (those belong in later slices per PLAN Phase 3).
- No premature packages/ or dual Rust/TS impl (YAGNI until duplication or shared contract appears in a slice).
- No advanced normalization, full 4-role comics from legacy (use real data where present; augment only for coverage, marked), or migration job.
- No changes to existing specs or infrastructure.

## Decisions

**Decision: Technology-agnostic model + TS-first pure fns + data goldens (JSON fixtures).**
- Rationale: PLAN explicitly calls for "technology-agnostic first, then language-specific". Pure fns and goldens are the contract. Starting with TS (frontend is where ctor + player live initially per 3 components) + loadable JSON goldens allows immediate TDD and parity tests. Model can be expressed as interfaces + JSON schema for future Rust sharing or validation. Matches "small focused components, shared renderers" and "same code used by ctor, player, tests, bundle packer".
- Alternatives considered:
  - Pure Rust crate from day 1: Overkill (YAGNI); skeleton has no domain; would delay goldens/ctor work. Rejected.
  - Embedded in frontend only (no shared): Violates DRY when backend needs projectors/facts. Rejected for now but monitored.
  - Full JSON schema + codegen: Premature complexity for v1 goldens. Use manual TS interfaces + comments mirroring SPEC for highest readability.
- Trade-off: Some duplication risk later, but YAGNI wins; easy to extract when a slice (e.g. sync) forces it.

**Decision: Goldens as separate snapshot + playthrough JSONs in clean structure (see goldens-clean/README.md).**
- Rationale: Separates static frozen content (QuestSnapshot matching SPEC exactly: position, rich_content, 4-role media, completion, supporting) from dynamic test cases (actions + expected_facts + projections). Directly supports "Golden fixtures from real exported quests", "simulate complete playthroughs exercising 4 templates...", "property-based and adversarial tests for races", "client/server projection fidelity". Real data (synonym answers, Page_type → templates, RU text, Hint_Image) fills them; augmentations for missing supporting (gifts, navigator) explicitly noted for coverage.
- Alternatives: Single mega-JSON per quest or code-only fixtures: Less readable, harder to maintain/expand with new exports. Rejected for KISS + readability.
- How goldens are used: Load JSON → call pure fns → assert outcomes. Enables "test in real player" later.

**Decision: Implement in platform/ (start with frontend or simple shared TS module; add backend parity when needed). No new packages/ yet.**
- Rationale: Current layout (per initial setup design) keeps YAGNI: "No multi-crate... or shared packages/ (added only when duplication or a real shared contract appears)". Goldens + fns can live alongside frontend code initially (or a internal shared/ dir) for ctor/player tests. Backend skeleton can consume via API contracts later. Aligns with "lean form + ordered list as baseline" and "small focused components".
- Alternatives: Force packages/shared now: Violates YAGNI and "do not create packages 'just in case'".
- Layout: Types/fns in e.g. frontend/lib/model or similar (exact path decided in tasks); goldens referenced from tests.

**Decision: Pure functions must be deterministic, side-effect free, and exactly match across consumers.**
- Rationale: Core to "client is the sole judge... server only records"; "deterministic fold"; "same code". isAnswerCorrect is the linchpin (real lists from exports test synonyms/membership). Projections must survive races per TECH.
- Risks mitigated by goldens covering the exact scenarios in PLAN.

## Risks / Trade-offs

- [Risk: Goldens rely on some synthesized supporting data (gifts/navigator in samples where legacy export lacked it)] → Mitigation: Explicit "notes" in fixtures; real data prioritized (synonym answers, texts, Page_type); regenerate on future exports/ctor work. Marked as coverage-only.
- [Risk: Starting TS-focused may lead to later duplication when backend facts/projectors added] → Mitigation: Monitor in slices; extract to shared when a real contract appears (per YAGNI in initial design). Goldens are data, reusable.
- [Risk: Model changes as more real data/ctor arrives] → Mitigation: Goldens + tests make changes safe (TDD). Specs will capture requirements.
- [Risk: No full 4-role comics or geo in initial goldens] → Mitigation: Legacy reality (single images, sparse); structure supports them; ctor will populate. Tests focus on core (matching, projections, linear flow).
- Trade-off: More up-front test data vs. minimal code. Wins on robustness (prevents races/lost facts per adversarial cycle in PLAN).

## Migration Plan

N/A — pure foundation. No runtime data or existing code affected. Goldens are new test artifacts alongside archived exports. Future slices will reference this change.

## Open Questions

- Exact location for shared TS code/goldens loading (frontend/src/model? internal shared dir?).
- When to introduce Rust side (or WASM) for true single impl vs. TS parity tests.
- How many goldens initially (2-3 snapshots + playthroughs sufficient to unblock constructor slice?).
- Integration with future bundle/publish (serializeToSnapshot will feed it).

This design enables the tasks and directly supports the blueprints' emphasis on shared code, real goldens, and "hard to publish bad" via tested gates.