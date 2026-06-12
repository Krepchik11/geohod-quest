# Design: spec-repair-parity-harness

## Context

`design/uploads/SPEC.md` is canonical for data shapes and invariants (precedence rule in CONCEPT.md). The backend and the `facts-sync` spec drifted from it in three load-bearing places: overdraft compensation facts (SPEC: negative balance is legal, no compensation), a `version_mismatch_corrected` fact (exists nowhere in SPEC), and a missing completion bonus (SPEC: canonical +5, first completion per player+quest, idempotent). Separately, "grant before attempt" is unenforced, and the SPEC requirement "Client fold == server fold, exactly (goldens enforce)" has no mechanical enforcement — the Rust and TS folds are tested against hand-mirrored constants that can drift silently. Frontend tests exist but no runner is configured.

Decisions already taken with the owner: SPEC wins over existing code; Postgres comes in the next change (this change stays in-memory); pre-auth player identity is a client-generated stable device UUID; payment/auth are later phases.

## Goals / Non-Goals

**Goals:**
- Backend behavior matches SPEC invariants exactly: negative balance legal and persistent, no compensation facts, completion bonus idempotent per (player, quest), grant → attempt → facts chain enforced.
- Corrections become pure client-side derivations (one shared pure helper) from pre/post-sync projection diffs.
- One fixture set, two consumers: `platform/goldens/*.json` loaded by both `cargo test` and `vitest`; root `npm test` runs both.
- Frontend test runner wired; orphaned tests in `lib/__tests__/` run and pass.
- Legacy template aliases removed from the player.

**Non-Goals:**
- Persistence (next change; this one keeps in-memory stores but shapes the traits the DB swap will implement).
- Bundle download endpoint, real auth, payments, PWA service worker.
- Any UI redesign — design-fidelity work is a separate phase.

## Decisions

1. **Corrections are derived, not stored.** Server returns authoritative projection; client diffs old vs new locally via a pure `deriveSyncCorrections(local, authoritative)` in `shared-model.ts`. Alternative considered: server-computed notice objects in the sync response. Rejected: server would need the client's pre-sync view (extra protocol surface), and SPEC's "fold parity" already guarantees the client can compute the diff itself. Fewer moving parts, zero stored correction state.

2. **`Fact` enum shrinks to player events only** (physical_confirmed, answer_submitted, gift_claimed, hint_purchased, completion_bonus, attempt_completed, feedback_reported, navigator_used). Both correction variants deleted, not deprecated — no persistence exists yet, so no migration burden; carrying dead variants would re-freeze the wrong model into the upcoming DB schema.

3. **Completion bonus idempotency keyed by (player_id, quest_id), enforced at the store.** The attempt registry (new) gives the store attempt → (player, quest) resolution, so a `completion_bonus` arriving on any attempt of the same player+quest dedupes against history across attempts, devices, and versions. Alternative: trust the client to send it once. Rejected: violates "Facts are immutable and idempotent" under retries/multi-device.

4. **Attempt registry as a third in-memory store** (`attempts: HashMap<attempt_id, AttemptMeta {player_id, quest_id, snapshot_id, created_at}>`), created via `POST /api/attempts` which checks the grant store first. Append and GET /state reject unknown attempt ids (404). Existing snapshot-binding-on-first-append behavior is replaced by binding at creation — one authoritative binding point instead of two racy ones.

5. **Fixture format:** `{ name, facts: [...], expected: { balance, completed_steps, revealed_hints } }`, serde-compatible with the Rust `Fact` enum tagging (`type`, snake_case) and the TS union. Rust side: an integration test iterates `platform/goldens/`, deserializes, folds, asserts. TS side: vitest does the same via `fs` glob. Path resolution: relative from each suite to the repo-root `goldens/` directory (both suites live inside the monorepo, stable relative paths).

6. **Device-agnostic natural key.** Dedup key = (type, step_position, submitted_value, coins_delta, note); device_id recorded for audit but excluded from the key. Rationale: with device_id in the key, the same gift/bonus claimed on two devices double-counts coins after union — violating SPEC goldens ("duplicate uploads of completions/gifts/bonus → single fact", "no double rewards"); the prior spec's own long-offline-queue scenario already assumed cross-device dedup. Trade-off accepted: identical wrong answers retried with the same value collapse to one fact (analytics undercounts exact-duplicate retries) — harmless for v1.

7. **Correct answers complete steps; wrong ones don't.** Both folds previously counted any answer_submitted as completing its step, which would fire the attempt-advance offer off a wrong answer. Fixed in both implementations; pinned by a parity fixture containing a wrong answer.

8. **Vitest over Jest/node:test** — first-class TS + ESM, zero-config with the existing tsconfig, fastest watch loop. Frontend `test` script = `vitest run`; root `test` script chains backend `cargo test` + frontend.

## Risks / Trade-offs

- [Deleting tested behavior (overdraft compensation) regresses "balance recovers" UX someone may have expected] → It was never specified; SPEC explicitly legislates the opposite. Decision confirmed by owner. Tests inverted, not deleted: negative balance persistence is now the asserted contract.
- [Cross-attempt bonus dedup makes append latency depend on per-player history scan] → In-memory v1: negligible. The DB change must index (player_id, quest_id) for the bonus check; noted for next phase.
- [Shared fixtures create serde-format coupling between Rust and TS] → That coupling is the point; format pinned by both suites' tests. A schema note in `goldens/README.md` documents the tagging convention.
- [Breaking API change (no `corrections` in response, 404 on unknown attempt) breaks the current frontend sync path] → Frontend is updated in the same change; no external consumers exist.

## Migration Plan

Single change, no deploy concerns (in-memory, no external consumers). Order: shared fixtures + TS model first (RED), Rust model second (RED→GREEN), handlers/routes, frontend wiring, alias cleanup, gates green (`cargo fmt/clippy -D warnings/test`, `next build`, `vitest run`).

## Open Questions

None blocking. The DB indexing note above transfers to the persistence change.
