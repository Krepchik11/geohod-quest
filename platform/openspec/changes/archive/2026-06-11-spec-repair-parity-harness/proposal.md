# Proposal: spec-repair-parity-harness

## Why

The backend (and the `facts-sync` spec it was built from) violates the canonical product invariants in `design/uploads/SPEC.md`, which is the source of truth for data shapes and invariants. SPEC says: **negative balance is a legal state** — no overdraft compensation facts, no hint revocation; corrections are exactly two client-facing notices (balance re-projection after multi-device merge, attempt-advance offer). The backend instead emits `BalanceCorrected` compensation facts that force balance back to ≥ 0, plus a `VersionMismatchCorrected` fact that exists in no spec. Additionally, the canonical completion bonus (+5, first completion per player+quest, idempotent) is entirely missing, the "grant before attempt" invariant is unenforced (facts append for any attempt_id), and client/server fold parity — required exactly by SPEC ("Client fold == server fold, exactly (goldens enforce)") — is only enforced by hand-mirrored assertions, not by shared fixtures. Frontend tests exist but no runner is wired, so they never run.

Fixing this now is the highest-leverage move: every later phase (persistence, PWA sync, commerce) builds on the fact model and the parity guarantee. Bad invariants frozen into a database schema or a sync protocol get exponentially more expensive.

## What Changes

- **BREAKING** Remove `Fact::BalanceCorrected` and `Fact::VersionMismatchCorrected` variants and all compensation logic (`maybe_generate_corrections`) from the backend. Balance may go negative and stays negative; it is a deterministic fold of facts.
- **BREAKING** Sync response no longer carries `corrections` facts. Server returns the authoritative projected state + accepted facts; the client derives the two SPEC corrections (balance re-projected popup, attempt-advanced offer) by diffing its pre-sync local projection against the post-sync server projection. No correction facts are ever stored in the log.
- Add `completion_bonus` fact: +5 coins, awarded on first completion per (player, quest), idempotent across attempts and devices. Toast fires on entering terminal step (client); fact recorded like any other.
- Add Attempt lifecycle: `POST /api/attempts` (player_id, quest_id) creates an attempt bound to the latest published snapshot **only if an AccessGrant exists** for (player, quest). Fact append requires a known attempt. Player identity pre-auth = client-generated stable device UUID (decision logged; Telegram identity-link comes in a later phase).
- Cross-language parity harness: shared JSON golden fixtures (fact logs + expected projections, including negative-balance scenarios) stored once, executed by **both** `cargo test` and frontend test runner. Drift fails CI on either side.
- Wire `vitest` in the frontend; activate the orphaned tests in `lib/__tests__/`; root `npm test` runs both suites.
- Remove legacy template aliases (`first_screen`, `task_no_answer`, `task_with_answer`) from `QuestPlayerClient.tsx` — the 7-template vocabulary is canonical.

## Capabilities

### New Capabilities

- `parity-goldens`: shared JSON fixtures (fact logs → expected balance/state projections) consumed by both Rust and TypeScript test suites; the mechanical enforcement of "client fold == server fold, exactly".

### Modified Capabilities

- `facts-sync`: correction protocol requirement is **replaced** — no compensation facts, no version-mismatch facts; server returns authoritative projection only; negative balance is legal and persists. New requirements: completion-bonus fact idempotency (per player+quest, cross-attempt), attempt creation gated by AccessGrant, append rejected for unknown attempts.
- `shared-model-goldens`: golden source moves from frontend-only JSON to the shared parity fixture set; TS projectors and types gain `completion_bonus`; correction fact types removed from the shared model.

## Impact

- `backend/src/facts.rs` — remove 2 fact variants + compensation helpers; add `completion_bonus`; tests rewritten (negative balance becomes the asserted-correct outcome).
- `backend/src/store.rs` — remove `maybe_generate_corrections`; add attempt registry (player, quest, snapshot binding) + grant check; completion-bonus idempotency by (player, quest) natural key.
- `backend/src/main.rs` — new `POST /api/attempts` route; append handler gains unknown-attempt rejection; integration tests updated (overdraft test inverted: balance stays negative, no corrections in response).
- `frontend/lib/shared-model.ts` — fact type additions/removals mirrored; projection diff helper for the two client-side corrections.
- `frontend/lib/api.ts`, `app/quest/QuestPlayerClient.tsx` — attempt creation call, alias cleanup, correction popups driven by projection diff.
- `frontend/package.json`, root `package.json` — vitest wiring.
- New top-level fixture directory shared by both suites (e.g. `platform/goldens/`).
- `openspec/specs/facts-sync` — delta spec replaces the compensation-correction requirement (the old requirement contradicted SPEC.md; precedence rule: conflicts resolved by updating the loser).
