## 1. Setup and Shared Integration

- [x] 1.1 Read the proposal.md, design.md, specs/quest-constructor/spec.md, and referenced goldens-clean/README.md + samples + shared-model-goldens artifacts to internalize the exact requirements (4-template picker, AnswerListEditor + live Test match using shared isAnswerCorrect, 4-role comics, navigator, gates, Publish, "Save + real player test", import/export, small shared components).
- [x] 1.2 Set up basic constructor section in the frontend (e.g. under the existing 3-component structure or new route/page in app/). Ensure it can import from the existing shared-model (frontend/lib/shared-model) and goldens (frontend/goldens or goldens-clean reference). Verify with `npm run build`.
- [x] 1.3 Add any minimal dependencies for interactivity (e.g. drag-and-drop for sortable list, file inputs for comics) only if not already in the skeleton. Follow agents/react.md (no waterfalls, narrow effects, explicit conditionals).

## 2. Core Editor UI (Templates, Steps, Answers, Gifts)

- [x] 2.1 Implement 4-template picker component that pre-fills mode + supporting + button/confirm copy when a template is chosen (Первый экран, Задание без ответа, Задание с ответом, Продолжить). Use the clean goldens structure for defaults.
- [x] 2.2 Implement sortable step list + basic quest metadata form (title, summary, price, difficulty, etc.). Support reorder only on drafts (per SPEC).
- [x] 2.3 Implement per-step editor with structured AnswerListEditor (chips/rows/reorder/"Paste lines" that splits and trims). For answer tasks, show live "Test match" box that calls the exact shared isAnswerCorrect against the current list + real goldens data.
- [x] 2.4 Implement gift subform (coins input + narrative) with explicit UI note "this freezes in the snapshot at publish".
- [x] 2.5 Wire basic supporting editors for the other fields from the goldens structure (navigator geo picker + toggle visible only on physical steps, animation/voice refs, physical_action description/confirm_label, hint cost).

## 3. Media, Previews, and Visual Features

- [x] 3.1 Implement 4-role comic upload zones (task/character/hint/atmosphere) with thumbnails and validation that task role is present for Task templates.
- [x] 3.2 Implement per-step mini-preview that uses the real shared player components (from the existing player side or goldens-driven preview) rendered against the current draft values.
- [x] 3.3 Add popup hint wiring UI (default enabled for answer tasks) and animation/voice assignment UI for task bonuses.

## 4. Pre-publish Gates, Checklist, and Publish

- [x] 4.1 Implement pre-publish checklist + gates UI (primary comic for Task templates, valid answers count >0 for answer steps, geo sanity for navigator, est size, no missing terminal step, etc.). Use validateForPublish from shared model + goldens for the logic.
- [x] 4.2 Add "dry-run serialize" button that exercises serializeToSnapshot and shows the would-be frozen snapshot diff or JSON (without actually publishing).
- [x] 4.3 Implement explicit big Publish button/action that creates a new immutable snapshot (using serializeToSnapshot), triggers bundle (stub for MVP or call future API), and marks the quest as published. Old versions remain bound for existing attempts.
- [x] 4.4 Implement "Save + open in real player as test user" that persists the current draft (as a temp version), creates a temporary grant (reuse existing temp grant logic if present), and navigates to the real PWA player flow exercising the full UX (popup, navigator, bonuses, feedback, rating).

## 5. Import/Export and Power Features

- [x] 5.1 Implement import tab: YAML/JSON paste or file upload → strict parse using shared model types + validate against goldens structure/gates → load into the editor list. Show clear errors.
- [x] 5.2 Implement "Export current as YAML" button that serializes the current draft (or published version) to the goldens-clean compatible YAML format.
- [x] 5.3 Ensure import/export roundtrips cleanly with the existing goldens samples for TDD.

## 6. Polish, Shared Components, and Gates

- [x] 6.1 Refactor all constructor UI into small focused components (e.g. TemplatePicker, StepList, AnswerListEditor, ComicUploadZone, MiniPreview, GateChecklist) that share renderers/logic with the player side where possible. No god objects.
- [x] 6.2 Add comprehensive TDD tests (unit for editor logic, integration using goldens for "Test match"/gates/mini-previews, import/export roundtrips, gate failure cases). Extend goldens with ctor-specific cases as needed.
- [x] 6.3 Run full quality gates: `npm run lint`, `npm run build` (frontend), any relevant backend checks, root `npm test`. Fix issues. Verify no violations of agents/react.md or principles (TDD, YAGNI, small components).
- [x] 6.4 Update minimal docs (e.g. platform/README.md or frontend notes) to describe the new constructor section and its use of shared model + goldens. No changes to blueprints.
- [x] 6.5 Self-critique + final verification: Re-read proposal.md, design.md, specs/quest-constructor/spec.md, PLAN.md constructor section, goldens-clean/README.md, and the shared-model-goldens artifacts. Confirm every requirement, decision, and "hard to publish bad" goal is addressed by the implementation + tests. Run full gates one last time. Note any open questions (e.g. full backend publish timing) in a comment or the change.

## 7. Completion

- [x] 7.1 Mark all prior tasks [x] only after full verification (tests green, gates pass, code follows principles, goldens drive the live Test match and gates).
- [x] 7.2 Run `openspec status --change "quest-constructor"` to confirm all tasks complete.
- [x] 7.3 This change delivers the constructor MVP per PLAN Phase 3 priority and enables the next slices (player PWA will consume the same templates/mini-previews; publish flows will use the snapshots). Revisit goldens and import when more real 4-role/navigator data or ctor usage feedback arrives.