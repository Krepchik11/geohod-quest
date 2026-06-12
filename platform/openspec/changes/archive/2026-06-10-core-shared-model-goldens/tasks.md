## 1. Model Definition (Technology-Agnostic + TS Interfaces)

- [x] 1.1 Read goldens-clean/README.md and the created golden JSON samples + playthroughs to internalize the exact clean structure (GameStep with template, rich_content, 4-role media, completion, supporting; plus playthrough actions + expected_facts).
- [x] 1.2 Define technology-agnostic model (e.g. as documented interfaces or JSON schema comments) in a new location (e.g. platform/frontend/src/model or equivalent per YAGNI in design). Mirror SPEC exactly: GameStep, supporting types, facts (AttemptFact/CoinFact/FeedbackReport), Snapshot, PlaythroughGolden.
- [x] 1.3 Implement TypeScript interfaces/types in the chosen location that match the goldens structure (including real acceptable lists, RU content focus, optional supporting). Verify by loading one golden JSON and type-checking.
- [x] 1.4 Add basic serialization helpers if needed for loading goldens (pure, no side effects). Verify with `npm run build` or tsc check in frontend.

## 2. Pure Functions Implementation

- [x] 2.1 Implement isAnswerCorrect(submitted: string, acceptable: string[]): boolean as pure function (basic membership/contains after trim per locked decisions in blueprints). Use real lists from goldens (e.g. ["ПУПИН", "МИХАЙЛО ПУПИН"]). Add unit tests.
- [x] 2.2 Implement validateForPublish(draft: any): {errors: string[], warnings: string[], estBundleMB?: number} covering required fields per goldens structure and SPEC (e.g. primary comic for Task templates, valid answers count). Test against clean goldens.
- [x] 2.3 Implement serializeToSnapshot(draft: any): QuestVersionSnapshot producing exact frozen shape (all supporting amounts, media refs, completion data). Verify roundtrips with goldens.
- [x] 2.4 Implement projectState(facts: any[]): AttemptState and projectBalance(facts: any[]): number as deterministic pure folds. Cover gift, answer_submitted (with local_is_correct), hint, terminal. Verify against playthrough goldens expected values.
- [x] 2.5 Ensure all functions are side-effect free, deterministic, and documented (per agents guidelines). Run `npm run lint` and relevant tests to verify.

## 3. Goldens Integration and Loading

- [x] 3.1 Set up goldens loading (e.g. import JSON from goldens-clean/ or copy to a test/goldens/ location in platform for easy access). Keep traceability to raw_bubble_ids and old-knowledgebase exports.
- [x] 3.2 Wire goldens into test setup so they can drive the pure fns (load snapshot + playthrough actions → call fns → assert expected_facts, balance, local_is_correct).
- [x] 3.3 Add at least the provided samples (mystery-fortress-v1 + happy-with-gift) as initial goldens. Verify loading produces usable data for tests.

## 4. Comprehensive Tests (TDD Goldens + Unit + Adversarial)

- [x] 4.1 Unit tests for each pure fn (isAnswerCorrect with real synonyms and rejects, validate/serialize edge cases from goldens structure, projections for simple facts).
- [x] 4.2 Golden-driven tests: for each snapshot + playthrough, assert full playthrough (4 templates, real answers, gifts, terminal), facts emitted match expected, projections match expected_final_balance, client claims preserved.
- [x] 4.3 Race / adversarial tests (per PLAN): concurrent devices (facts union), reset during play, version freeze (old snapshot amounts used), long offline + multiple actions, overdraft correction. Use synthesized interleavings on top of real goldens data.
- [x] 4.4 Fidelity tests: client projection (local fold on facts) == server projection for all goldens. Run full suite.
- [x] 4.5 Verify all tests pass with `npm test` (or specific frontend test command) and backend `cargo test` if any shared logic touches it.

## 5. Gates, Documentation, and Integration Prep

- [x] 5.1 Run full quality gates: `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test` (backend), `npm run lint`, `npm run build` (frontend), root `npm test`. Fix any issues.
- [x] 5.2 Update relevant docs minimally (e.g. platform/README.md architecture notes or goldens-clean/README.md if needed) to reference the new shared model location and how slices will consume it. No changes to blueprints.
- [x] 5.3 Ensure the foundation is importable/usable for next changes (e.g. constructor can import types + isAnswerCorrect + goldens for its Test match and gates).
- [x] 5.4 Self-critique + final verification: Re-read design.md, specs/shared-model-goldens/spec.md, proposal.md, and goldens-clean/README.md + samples. Confirm every requirement and decision is addressed by implemented code/tests. Run full gates one last time. Document any open questions or follow-ups in a comment or the change.

## 6. Completion

- [x] 6.1 Mark all prior tasks [x] only after verification (tests green, gates pass, code follows principles).
- [x] 6.2 Run `openspec status --change "core-shared-model-goldens"` to confirm readiness.
- [x] 6.3 This change enables the next slices per PLAN (constructor MVP using the live Test match and gates from goldens). Revisit goldens when more real data (4-role comics, navigator from exports) arrives.