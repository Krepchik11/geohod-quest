## Why

The backend facts-sync change (now archived, 13 tests green, idempotent natural keys, pure projectors matching client goldens exactly incl. happy-with-gift "МИХАЙЛО ПУПИН"+gift+5 + overdraft corrections) has made the server side of the append/correct contract real. The player PWA (from prior archived quest-player-pwa) still has only a no-op "simulate sync" stub in OfflineBanner/QuestPlayerClient (alert, no fetch). Without wiring the local append-only facts + LS + project* to the real POST /api/attempts/:id/facts (with snapshot), applying returned corrections (append + re-project + LS), and updating banner for pending/sync/corrected/offline states, the PLAN Phase 3 reconnect story ("upload pending facts, receive authoritative state + corrections (clear banners...)"), "Offline mode indicator + pending sync status", "facts mandatory", "idempotency keys, explicit corrections" + client/server loop closure remain unproven for "Save + open in real player as test user" + offline play. This follow-on wires the stub to enable full fidelity demonstration.

## What Changes

- Wire real reconnect sync in frontend player: enhance existing small components (OfflineBanner + QuestPlayerClient 'use client' reducer/effects/handlers), collect pending (current facts), native fetch POST {facts: Fact[], snapshot_id?} to /api/attempts/{attemptId}/facts (demo attemptId derived from golden, no grants), on success append corrections (normalize to shared Fact shape) to local log, re-project via imported shared, persist via existing LS effect, update UI/banners; on error keep local + error banner.
- Extend shared Fact type additively (to accept server correction variants like balance_corrected) + ensure projectBalance/projectState tolerant (already nearly are).
- Update/extend TDD goldens-driven replay test (or add reconnect cases) to cover: offline pending facts -> reconnect call (mocked or harness) -> corrections applied -> final projection authoritative + LS roundtrip post-sync; happy path + edges + overdraft corr case.
- Preserve simulate toggle for "force offline" (no real POST); keep all 4-template/feedback/nav/gift/ctor "Save+test" flows working.
- No backend changes, no new packages, no auth, no deep corrected UI, small focused per react.md, 100% reuse of lib/shared-model imports and project*.

**No BREAKING changes.**

## Capabilities

### New Capabilities

(none; wiring closes the loop on existing player + facts-sync contracts)

### Modified Capabilities

- `quest-player-pwa`: Update requirements/scenarios for real (vs simulate) reconnect, corrections folding into local facts log, post-sync authoritative state from server projected + goldens fidelity, offline sim toggle still functional, banner states for sync/pending/corrected/error, LS persist of applied corrs, attempt binding for demo. (facts-sync spec already documents the expected client reconnect contract; this delivers the player side.)

## Impact

- **Frontend code**: `frontend/app/quest/QuestPlayerClient.tsx` (add sync handler, attemptId, syncing state, handle corrections in append path, call real vs sim), `frontend/app/quest/OfflineBanner.tsx` (enhance props for status/pending/corrected without bloat), `frontend/lib/shared-model.ts` (additive Fact union variants + fields for corr types; projectors unchanged behavior), `frontend/lib/__tests__/player-replay.test.ts` (extend with reconnect sim + corr asserts driven by goldens), possibly ctor/page for status if needed.
- **OpenSpec**: proposal.md + design.md + specs/quest-player-pwa/spec.md (delta) + tasks.md ; on apply syncs delta to openspec/specs/quest-player-pwa/spec.md (additive to prior).
- **Tests/gates**: replay test green (new reconnect scenarios), `cd frontend && npm run build && npm run lint`, manual "Save + open in real player" + toggle offline + sync (with backend running on expected port for demo) exercises full. Goldens fidelity post-corr.
- **Downstream**: Enables "on reconnect" per PLAN, proves client/server facts convergence + corrections for multi-device/offline, unblocks future real auth/grants without rewrite. "Save + test" from ctor now exercises end-to-end local + reconnect.
- All per TDD (goldens first), SOLID/DRY/KISS/YAGNI (enhance not rewrite, reuse 100%, small comps, sim preserved), react.md (RSC page thin, 'use client' narrow, explicit, derived in render), no scope creep.

This makes the full offline/reconnect story real and verifiable against the contract.
