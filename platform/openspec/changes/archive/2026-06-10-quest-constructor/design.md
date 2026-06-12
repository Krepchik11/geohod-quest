## Context

The project surface is now clean with `../blueprint/` as the sole primary source (per the updated PLAN.md "Current State" section). The previous `core-shared-model-goldens` change delivered the technology-agnostic shared model (GameStep, facts, snapshots matching SPEC.md), pure functions (isAnswerCorrect using real synonym lists from goldens, validateForPublish, serializeToSnapshot, projectState/projectBalance), and TDD goldens in the clean structure (goldens-clean/ with real data from exports + adversarial mapping).

Current platform/ is a minimal high-quality skeleton (Rust Axum backend, Next.js 16/React 19 RSC frontend with 3-component landing per CONCEPT and agents guidelines). No domain logic or packages/ yet (YAGNI). The constructor is explicitly the next priority in PLAN.md Phase 3 and Immediate Next Actions because it is the gatekeeper that protects the frozen-snapshot model (bad content in a published version is permanent for players who started against it).

This design implements the detailed constructor features from PLAN.md (4-template picker, structured AnswerListEditor + live Test match, 4-role comics, navigator, gifts, animations, popup, mini-previews, gates, explicit Publish, "Save + open in real player as test user", import/export) while consuming the shared model + goldens for correctness and tests.

## Goals / Non-Goals

**Goals:**
- Deliver a lean, usable internal Quest Constructor that enforces the 4 primary templates, structured data entry for frozen snapshot correctness (answers, gifts, supporting), 4-role comics, navigator as optional hint, animations/voice, popup hints, and visual mini-previews.
- Use live "Test match" (exact shared isAnswerCorrect + goldens) and pre-publish gates + checklist + "dry-run serialize" to make it "hard to publish bad".
- Enable explicit Publish that produces immutable snapshots + triggers bundles, plus "Save + open in real player as test user" for full UX validation (per "Save + real player test is acceptable MVP" in PLAN).
- Small focused components + shared renderers with the player side (no god objects, per PLAN and agents/react.md).
- TDD with existing goldens (extended as needed) + new constructor-specific tests for gates, mini-previews, import/export.
- Power-user import/export (YAML preferred) for bulk ops and future migration.

**Non-Goals:**
- No full high-fidelity live embedded preview in ctor at launch (use "Save + real player as test user").
- No backend publish/bundle implementation yet (YAGNI; "Save + real player test" sufficient for MVP per PLAN; backend can come in a follow-on slice or as part of this if explicitly needed).
- No DB, auth changes, or multi-quest features.
- No advanced answer normalization (basic membership per locked decisions).
- No external authors or branching (v1 cuts per CONCEPT/PLAN).
- Do not duplicate player rendering logic (share components/renderers).

## Decisions

**Decision: Implement entirely in frontend (Next.js) using shared-model-goldens for types/fns and goldens for validation/tests. Add small client components only where needed for interactivity (per agents/react.md).**

- Rationale: PLAN and design principles emphasize YAGNI ("lean form + ordered list as baseline", "Save + real player test is acceptable for MVP"). The shared model and pure functions (including live Test match) are already implemented and tested. Constructor is the authoring surface that feeds the model; keeping it frontend-only avoids premature backend work. "Small focused components + shared renderers with player" directly from PLAN. Use RSC where possible, client components for dnd, uploads, live test, mini-previews.
- Alternatives considered:
  - Full backend for publish/preview now: Violates YAGNI and "do not create packages just in case"; skeleton has no domain yet. Rejected.
  - High-fidelity embedded preview: Explicitly non-goal per PLAN ("Save + real player test" acceptable).
- Trade-off: Some context switch for authors ("Save + test in player"), but acceptable and matches client requirements. Easy to evolve later.

**Decision: Use the existing goldens-clean structure + shared isAnswerCorrect for "Test match", gates, and mini-previews. Extend goldens with constructor-specific cases as part of this change.**

- Rationale: Goldens are the non-negotiable TDD foundation (PLAN: "goldens from real exported quests are non-negotiable"). Live Test match must use the exact shared fn. Pre-publish gates use validateForPublish + size est + visual checks. Mini-previews use the same player components that will render in the real PWA.
- How: Import goldens in tests and "Test match" UI. Add new golden playthroughs or snapshot variants if needed for ctor flows (e.g., import roundtrip, gate failures).

**Decision: Support 4-role comics, navigator geo picker, animation/voice assignment, and popup wiring from day one, even if some legacy data was single-image.**

- Rationale: Directly from client requirements ("Описание сайта") and CONCEPT (4 roles per page, navigator button as optional hint, animated+voiced bonuses, hints via wrong popup). Ctor must produce the exact supporting data that goes into snapshots/bundles. Use the clean goldens structure (4-role media, supporting.navigator, bonus_animation, etc.).
- Legacy mapping: Single Image_link/Hint_Image from exports maps to task/hint roles; others start null/optional. Full 4-role will be author-driven in ctor.

**Decision: Structured AnswerListEditor + "Paste lines" + live Test match as primary UI (not raw multiline). Import/export as YAML power path.**

- Rationale: PLAN explicitly calls for "structured AnswerListEditor + 'Paste lines' + live 'Test match' (exact client fn)" to avoid errors (dups, blanks) and enforce "hard to publish bad". YAML for bulk/migration (preferred over JSON per PLAN).
- Alternatives: Raw textarea only: Weak (high error rate per adversarial analysis in goldens-clean history). Rejected.

**Decision: No new packages/ or shared crates yet; keep logic in frontend/lib or app/ as small modules. Backend integration (publish endpoint) deferred.**

- Rationale: Matches YAGNI in initial setup and PLAN ("do not create packages 'just in case'"). Current skeleton has no packages/. Constructor logic can live alongside the shared model. Future slices (player, publish) will drive extraction if duplication appears.
- Layout: e.g., frontend/lib/constructor/ for editor components, using frontend/lib/shared-model and goldens.

## Risks / Trade-offs

- [Risk: Authors experience context switch with "Save + real player test" instead of embedded preview] → Mitigation: Explicitly acceptable per PLAN and client alignment. Mini-previews + live Test match + dry-run provide immediate feedback. Can evolve post-MVP.
- [Risk: Legacy data has single images and limited supporting (no 4-role, sparse navigator/gifts)] → Mitigation: Ctor supports full model from day one. Goldens note "synthesized" vs real. Import will handle mapping.
- [Risk: Gate strictness slows initial authoring velocity] → Mitigation: Soft gates + warnings first ("publish anyway"), templates with good defaults, "Paste lines" helpers. PLAN calls for staged rollout if needed.
- [Risk: Import/export YAML parsing/validation complexity] → Mitigation: Strict schema using the shared model types + goldens for roundtrip tests. Start with simple format.
- Trade-off: More fields in ctor (4-role, navigator, animations) vs lean baseline. Wins on fidelity to client requirements and frozen-content protection. Mitigated by pre-fills and small components.

## Migration Plan

N/A for initial MVP (new capability). Future migration of legacy quests will use the import tab (YAML/JSON from old page_constructor data, transformed via the goldens mapping rules already developed).

Existing platform skeleton remains untouched until this change is applied. New code will be additive under the constructor section of the app.

## Open Questions

- Exact file layout for constructor components (e.g., app/constructor/ vs lib/constructor/) — decide in tasks.
- Whether to implement a minimal backend "publish" stub in this change or defer fully to "Save + real player".
- How many additional goldens to add specifically for ctor gates/import (beyond extending the existing ones).
- Image upload handling (local preview vs real storage) — keep simple (file input + URL for MVP, per YAGNI).

This design directly implements the constructor details from blueprint/PLAN.md while leveraging the shared model + goldens and following all project principles.