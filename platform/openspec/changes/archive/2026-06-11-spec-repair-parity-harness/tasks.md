# Tasks: spec-repair-parity-harness

## 1. Shared fixtures + frontend test harness (RED first)

- [x] 1.1 Create `platform/goldens/` with fixture JSONs: happy-with-gift (incl. completion_bonus), negative-balance (expected -7), duplicate-bonus-folds-once, multi-device-union, empty-log; add `goldens/README.md` documenting the `type`-tagged snake_case fact format
- [x] 1.2 Add vitest to frontend (devDependency, `test` script = `vitest run`); root `package.json` `test` chains `cargo test` (backend) + frontend test
- [x] 1.3 Write vitest parity test loading all `platform/goldens/*.json`, folding with `projectBalance`/`projectState`, asserting expected values (RED until model updated)
- [x] 1.4 Update `lib/shared-model.ts`: add `completion_bonus` fact type, remove `balance_corrected`/`version_mismatch_corrected` types, add pure `deriveSyncCorrections(local, authoritative)`; activate/fix existing `lib/__tests__/` so they run under vitest

## 2. Backend model repair (RED → GREEN)

- [x] 2.1 `facts.rs`: delete `BalanceCorrected` + `VersionMismatchCorrected` variants and all references; add `CompletionBonus` variant (serde `completion_bonus`); update natural key + projectors; rewrite affected unit tests (negative balance asserted as legal outcome)
- [x] 2.2 Rust parity test: integration test iterating `../goldens/*.json` (relative to backend crate), deserialize, fold, assert expected — same fixtures as vitest
- [x] 2.3 `store.rs`: remove `maybe_generate_corrections` and correction append path; add attempt registry (`AttemptMeta {player_id, quest_id, snapshot_id, created_at}`); bind snapshot at attempt creation (remove bind-on-first-append); enforce completion_bonus idempotency by (player_id, quest_id) across attempts; rewrite store tests (overdraft test inverted: balance stays negative, no corrections)

## 3. Backend API surface

- [x] 3.1 `main.rs`: add `POST /api/attempts` (403 without grant; binds latest published snapshot); append + GET /state return 404 for unknown attempts; remove `corrections` from append response shape
- [x] 3.2 Update integration tests: grant→attempt→facts happy chain; no-grant 403; unknown-attempt 404; multi-device negative-balance persistence; completion-bonus idempotency across attempts; version freeze (new publish doesn't rebind existing attempt)

## 4. Frontend integration

- [x] 4.1 `lib/api.ts`: add `createAttempt`; adjust append response type (no corrections)
- [x] 4.2 `QuestPlayerClient.tsx`: remove legacy template aliases (`first_screen`/`task_no_answer`/`task_with_answer` mapping); emit `completion_bonus` fact on terminal entry; drive correction popups from `deriveSyncCorrections` after sync
- [x] 4.3 Point frontend golden loaders at `platform/goldens/` (remove or re-point `frontend/goldens/` copies)

## 5. Quality gates + spec sync

- [x] 5.1 All gates green: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, frontend `vitest run`, `next build`, root `npm test`
- [x] 5.2 Sync delta specs into main specs (openspec sync) and verify change status complete
