## Why

The player PWA now emits real append-only Fact[] locally (physical_confirmed, answer_submitted, gift_claimed, hint_purchased, attempt_completed, feedback_reported, navigator_used) and re-projects balance/revealed/completed via pure shared fns, with exact fidelity to goldens like happy-with-gift (expected_facts + final balance 5). The "simulate sync" banner is a stub alert. Without backend idempotent append of those facts, authoritative projectors proven identical to the client folds for the same inputs, explicit correction facts (for overdraft, dupe, version mismatch), and snapshot manifest for re-materialization, the blueprint invariants (facts as sole source of truth, client-authoritative offline PWA, multi-device union by facts, historical replay) are unproven server-side and reconnect cannot work. This is the required Phase 3 "Sync / Progress backend" slice to close the event-sourced model before commerce or admin views.

## What Changes

- Backend append-only fact log (per attempt) + idempotent append endpoint accepting batches of the exact shared Fact shape (dedup by natural keys: device_id + step_position + type + value/delta + note).
- Pure deterministic projectors in Rust (project_balance, project_state, plus analytics fold) that must produce identical outputs to TS project* for the same fact sequences from goldens; enforced by TDD replay tests using happy-with-gift + extra edges (wrongs, hints, feedback, nav).
- Correction protocol: append handler returns accepted facts + corrections (e.g. balance_corrected compensating facts with reason) + current authoritative projected state for client to fold in on reconnect.
- Snapshot manifest: retain QuestSnapshot refs/ids (bound at first append or explicit) + integrity for historical re-materialization of attempt state from facts alone.
- Minimal Axum additions (new handlers, routes under /api/attempts/:id, in-mem store behind state) with clear path to file/jsonl or sqlite persistence; no new Cargo deps.
- Strict rust.md compliance on all new code (pub docs, Result everywhere, #[cfg(test)] modules with Arrange-Act-Assert, no .unwrap in prod paths, 4-space, clippy -D, fmt).
- **Non-changes (YAGNI)**: no player wiring (simulate stub stays; real POST + correction apply is subsequent), no auth/grants/attempt creation endpoint, no persistent DB (in-mem first), no full snapshot JSON storage or bundle serving, no analytics HTTP surface yet.
- No **BREAKING** changes.

## Capabilities

### New Capabilities
- `facts-sync`: Append-only immutable fact log (Attempt/Coin/Feedback facts via unified thin Fact), idempotent append by (fact_id or) natural keys, pure projectors for QuestAttempt state / player balance / per-version analytics that match client exactly (goldens contract), correction protocol via explicit compensating facts, historical snapshot retention + manifest for re-materialization, multi-device merge by idempotent union. Directly enables real "on reconnect" upload + corrections for the player and future admin per-version visibility. (Creates `specs/facts-sync/spec.md`)

### Modified Capabilities
(none; existing shared-model-goldens and quest-player-pwa REQUIREMENTS are unchanged — Fact extensions for corrections if introduced later are additive and do not alter current player/local projection behaviors or golden assertions)

## Impact
- **Backend code**: `backend/src/facts.rs` (serde types/enum mirroring shared Fact + correction variants, pure projector fns + idempotency helpers), `backend/src/store.rs` (InMemoryFactStore + trait for future persist), updates to `main.rs` (build_router + AppState with store), `errors.rs` (new variants for bad facts/version etc with proper status), new integration tests in `#[cfg(test)]` that deserialize golden expected_facts and assert projector parity + idempotent no-op + correction emission.
- **No frontend changes** this slice (YAGNI per explicit cuts; contract + goldens already prove the client side; "simulate sync" becomes real POST in player follow-up).
- **Tests/gates**: `cargo test` (in backend) must replay goldens and pass fidelity; `cargo clippy -- -D warnings`, `cargo fmt -- --check`, `cargo build` all clean. New unit tests for projectors in isolation.
- **OpenSpec**: New `proposal.md` + `design.md` + `specs/facts-sync/spec.md` + `tasks.md`; on apply will sync the spec to `openspec/specs/facts-sync/spec.md`.
- **Downstream**: Unblocks real multi-device/offline reconnect in player (stub -> live), provides source-of-truth facts for future admin analytics (hints per step, wrongs, navs from folds), proves "server only appends + projects + corrects" before any mutable state or commerce.
- All decisions follow TDD (goldens non-negotiable for server too), SOLID (pure fns separate from IO/store, thin handlers), DRY/KISS/YAGNI (parallel pure projectors ok until shared crate justified; in-mem + String ids first; no over-engineering), extreme skepticism on every edge (see design).

This change makes the facts model real and trustworthy across client/server boundary.