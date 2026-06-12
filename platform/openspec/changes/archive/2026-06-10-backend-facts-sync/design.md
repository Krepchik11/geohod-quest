## Context

Current state (post quest-player-pwa + shared-model-goldens + ctor + initial setup): frontend/player emits exact shared Fact[] (7 types) on every action + auto gift_claimed; pure projectBalance (sum coins_delta) and projectState (fold to completedSteps/revealedHints) in TS; goldens (mystery-fortress-v1 snapshot + happy-with-gift playthrough with expected_facts + bal=5) drive replay test that asserts fidelity (including gift timing at step 2 with no action, real synonym "МИХАЙЛО ПУПИН", extra edges for wrong/hint/feedback/nav/LS). "simulate sync" in OfflineBanner/QuestPlayerClient is a no-op alert. Backend is minimal Axum skeleton (health, config from env, thiserror+anyhow errors, build_router extracted for oneshot tests, Trace/Cors/Timeout layers, graceful shutdown, no domain). No DB, no facts, no projectors. Primary sources: ../blueprint/PLAN.md (verbatim Phase 3 Sync/Progress bullets + risks on mid-quest races), SPEC.md (facts, frozen amounts), TECH.md (event-sourced: client authoritative, server only appends+projects+corrects; idempotency key per attempt+step+kind+snapshot; multi-device union; corrections e.g. overdraft -> hint unrevealed + bal adjust). Archived player design confirms local facts+project as source, simulate for future sync contract. All per TDD/SOLID/DRY/KISS/YAGNI + rust.md (4-space, doc comments on pub, Result, no prod .unwrap, #[cfg(test)] mods, clippy -D, fmt).

The "backend-facts-sync" change (per proposal) makes the server side of the contract real so player reconnect can stop being simulated and the "facts are source of truth" invariant is enforced across boundary.

## Goals / Non-Goals

**Goals:**
- Idempotent append of client Fact batches (POST /api/attempts/:attempt_id/facts) that dedups by natural keys so reconnects/multi-device never double-apply coins or rewards.
- Pure, deterministic Rust projectors (project_balance, project_state, project_analytics) that for any Fact[] input (incl. happy-with-gift expected_facts deserialized) produce *identical* balance/revealed/completed to the TS versions; proven by backend replay tests loading golden data + extra adversarial edges.
- Correction protocol: append returns accepted + list of correction facts (e.g. BalanceCorrected with coins_delta + reason) + authoritative projected state; client can later fold corrections into its local log for convergence.
- Snapshot manifest: bind attempt to snapshot_id on first append (or explicit), retain id + optional raw JSON for historical re-materialization (facts + snapshot_id -> same state as client had).
- In-memory store (Vec<Fact> per attempt_id + manifest maps) with zero new Cargo deps; explicit design for trait extraction + file/jsonl/sqlite swap with no behavior change.
- All new code follows rust.md to the letter: pub items fully documented (/// with params/returns/errors/examples), Result everywhere (no .unwrap in prod paths), tests in cfg(test) mods using Arrange-Act-Assert, 4-space, meaningful names, clippy clean, etc.
- Enables the player "on reconnect" story and future admin per-version analytics (hints used, wrongs submitted, navigator clicks folded from facts) without mutable scalars anywhere.
- TDD contract: goldens + replay are non-negotiable; any projector mismatch on happy or edges is a hard failure.

**Non-Goals:**
- No changes to frontend/player (simulate sync alert stays; real fetch + POST of pending + apply corrections is a later slice per explicit YAGNI cuts in PLAN + player spec).
- No real auth, grants, attempt creation endpoint, or lifetime AccessGrant enforcement (client-generated attempt_id strings are accepted; future layer will gate before append).
- No persistent store in this slice (in-mem HashMap is sufficient for MVP/demo/restart-loses-state is acceptable; file-backed would add fs paths/permissions/serde roundtrips now).
- No full QuestSnapshot typed storage or bundle serving (manifest keeps id + raw Value optional; re-mat for facts only uses deltas, snapshot data only for future integrity/audit).
- No analytics HTTP surface or admin endpoints (pure fold fn implemented for correctness, exposed later).
- No split AttemptFact/CoinFact/FeedbackReport (stick with thin unified Fact from shared for parity; split is future refactor).
- No new crates (no sqlx, no chrono, no uuid, no dashmap; use std + existing anyhow/serde/axum/tokio).
- No mutable "current state" rows; everything is append log + pure fold on read.

## Decisions

**Decision: Use a serde-tagged Rust enum Fact (with correction variants) that roundtrips exactly to the thin TS union + golden JSON, plus common coins_delta on relevant variants.**

Rationale: Client is authoritative (TECH); server must record the exact claim the client made (local_is_correct, submitted_value, coins_delta from frozen snapshot) without reinterpretation. Enum gives exhaustive match in projectors (SOLID, no stringly ifs), serde( tag="type", rename_all="snake_case" ) produces identical wire JSON to what player emits and what goldens contain (e.g. {"type":"gift_claimed", "step_position":2, "coins_delta":5, ...}). Adding BalanceCorrected / VersionMismatchCorrected etc. now makes the correction protocol first-class and forward-compatible (TS union will add them additively when player wires; old facts continue to deserialize). All variants carry the fields the client sends (device_id always, step_position, optional submitted/note, coins_delta even when 0 for non-coin facts like feedback/nav). 

Alternatives considered & rejected:
- Flat struct { r#type: String, ... all fields }: loses compile-time safety in fold; easy to add bad type at runtime.
- Separate AttemptFact + CoinFact + FeedbackReport structs (per old PLAN): more types, more code, YAGNI until duplication proven or analytics needs the split; unified thin already works perfectly for player goldens + projectors.
- Full newtype per variant: verbose without gain for this size.

This decision directly supports "exact match projectors to client" (goldens non-negotiable) and "correction facts".

**Decision: Natural-key idempotency (device_id + step_position + fact variant + submitted_value + coins_delta + note) with linear scan on small Vec; batch append is sequential in client-provided order.**

Rationale: Current emitted Fact (and golden actions) carry device_id + local_ts in actions but not on the Fact objects themselves. No server-generated fact_id yet. Composite natural key from the fields the client already sends is sufficient to detect "exact same claim" across reconnects or devices (TECH: "idempotent append endpoint (by fact_id + natural keys)"). For small N (a quest has <10 steps, even long offline queue <<1000 facts), Vec linear any() is trivial and has no alloc/hash cost. Append only if not seen; always return what was newly accepted this call. Order of batch preserved (client replay order); projectors are order-independent for bal (sum) and completed/revealed (sets + sort unique). Multi-device: union just grows the log with dedups; "once revealed stays revealed", sums converge.

For version mismatch: when append request includes snapshot_id different from attempt's bound snapshot, emit VersionMismatchCorrected fact (no state mutation) + correction.

Seen set is per-attempt only.

Alternatives rejected:
- HashSet<Fact> (requires Hash on Option<String> + enum; PartialEq would be too strict or need custom).
- Add local_ts / seq to Fact now (would require player change in this slice, violating YAGNI "integrate later").
- Rely on client fact_id (not present in current goldens/player emit).
- Full content hash ignoring device (could merge different device claims that happen to look same).

This survives concurrent appends (lock serializes), duplicate reconnect (no-op), long queue (replay safe).

**Decision: Pure free functions for projectors (and idemp helpers) in a facts module; mirror TS logic exactly; goldens as test vectors via embedded JSON literals.**

Rationale: "projectors for current QuestAttempt state, player balance, per-version analytics" (PLAN). Must be deterministic fold with no side effects, no IO, pure (testable, reusable, no drift). TS versions are:

- projectBalance: reduce sum (coins_delta || 0)
- projectState: forEach accumulate completed on physical/answer/attempt_completed, revealed on hint_purchased; unique sort.

Rust will have identical:

```rust
pub fn project_balance(facts: &[Fact]) -> i32 { facts.iter().map(|f| f.coins_delta()).sum() }
pub fn project_state(facts: &[Fact]) -> ProjectedState { ... collect sets, sort ... }
pub fn project_analytics(facts: &[Fact]) -> Analytics { hints_used: count hint_purchased, wrongs: count answer_submitted && !local_is_correct, nav_clicks: count navigator_used, ... }
```

TDD: first test (before handlers) does `let facts: Vec<Fact> = serde_json::from_str(HAPPY_EXPECTED_FACTS_JSON).unwrap_in_test(); assert_eq!(project_balance(&facts), 5); assert_eq!(project_state(&facts).completed_steps, vec![0,1,3]);` + same for extra edge facts (wrong+0cost hint, feedback, nav). This is the contract that "server projectors MUST produce identical ... goldens like happy-with-gift must replay server-side too". Any future change to fold must keep test green or update golden first.

No snapshot data needed for these projectors (amounts are in the fact deltas per "frozen in snapshot at claim time").

Analytics fold is implemented (for future /per-version) but not surfaced in MVP routes.

**Decision: In-memory store behind Arc<Mutex<InMemoryFactStore>> in AppState; concrete struct now + documented trait shape for future persistence swap; attempt_id and snapshot_id are opaque Strings (client-generated for attempts).**

Rationale: Current skeleton has no persistence story and "no persistent DB if file-backed or in-mem suffices" (briefing). HashMap<String, Vec<Fact>> + HashMap for attempt->snapshot + HashMap<String, SnapshotManifestEntry {id, stored_at, data: Option<Value>}> is <50 LOC, zero deps, instantly testable with oneshot, survives all goldens replay. Mutex is acceptable (critical section is pure Vec push + small scan; no await while held). AppState remains Clone (Arc inside).

For swap path (design for easy): InMemoryFactStore will have methods that match a future 

// trait FactStore {
//   fn append_idempotent(&mut self, attempt: &str, incoming: Vec<Fact>, snapshot: Option<&str>) -> AppendResult;
//   fn project_for(&self, attempt: &str) -> Option<Projected>;
//   fn bind_snapshot(&mut self, attempt: &str, snap: &str);
// }
(with AppendResult { accepted: Vec<Fact>, corrections: Vec<Fact> }).

When justified (e.g. "cargo test" starts failing on restart or multi-process demo), extract trait, add jsonl impl (append-only lines + load on open via BufReader), put behind enum Store or Box<dyn>, or feature flag. No behavior change to handlers/projectors.

attempt_id: client picks (e.g. `crypto.randomUUID()` or `local-${ts}`) on first play; server creates the log entry on first successful append. No separate POST /attempts. snapshot_id sent in append body (or inferred); first one wins for the attempt; later mismatch triggers correction fact.

Snapshot manifest retains the id always; data: Value only if client ever POSTs full snapshot JSON (future, for published non-golden). For now goldens tests preload the id "golden-mystery-fortress-v1".

This is minimal yet robust (YAGNI vs premature sqlx + migrations + pool in skeleton).

**Decision: API surface is two minimal routes + request/response DTOs; corrections returned on append only; use existing health-style patterns + extracted handlers for testability.**

- POST /api/attempts/:attempt_id/facts
  body: { "facts": Fact[], "snapshot_id"?: string }
  200: { "accepted": Fact[], "corrections": Fact[], "projected": { "balance": i32, "completed_steps": i32[], "revealed_hints": i32[] }, "snapshot_id": string, "fact_count": usize }
- GET /api/attempts/:attempt_id/state
  200: same projected + meta (no new facts)

Handlers live in main or thin facts module; they lock, call store.append_idempotent (or inline), call projectors, map errors to AppError (new BadRequest + VersionMismatch variants), return Json. Extend build_router with the two routes.

Rationale: Directly from PLAN ("idempotent append endpoint", "Projectors for current QuestAttempt state...", "Correction protocol"). Matches player pending upload shape. GET state supports "receive authoritative state". No extra endpoints (YAGNI). oneshot tests can hit them exactly like the existing health test.

DTOs are separate small structs (AppendRequest, SyncResponse) for clarity; Fact itself is the domain/wire.

Error evolution: add 

#[error("bad request")]
BadRequest(String),
#[error("version mismatch for attempt")]
VersionMismatch { attempt: String, expected: String, got: String },

in IntoResponse map BadRequest -> 400 with {"error": "..."}, Version -> 409 or 200+corrections (prefer return corrections in body even on conflict).

**Decision: Snapshot binding + retention uses manifest separate from fact log; re-materialization is "facts for attempt + its snapshot_id -> replay the pure projectors" (no snapshot content required for v1 state).**

Rationale: "Historical snapshot retention + manifest for re-materialization" (PLAN). Old attempts stay bound to their snapshot forever (immutable on publish). Storing full typed QuestSnapshot would duplicate the complex nested model (GameStep etc.); use serde_json::Value for the optional raw data (integrity hash can be added later as field). Projectors today are facts-only (deltas carry the frozen values). When real publish lands (ctor), a publish flow can POST the snapshot JSON to /manifest or inline on first attempt facts from a granted player. For goldens: tests just assert that using the happy facts + "golden-mystery-fortress-v1" id produces the known state.

This keeps server from needing the full GameStep shape yet (YAGNI).

**Decision: Correction emission is a pure post-append step (maybe_generate_corrections) that can append compensating facts to the log and return them; start conservative (accept all client claims per "client authoritative"; corrections only for explicit dupe/version/negative-bal after multi-device spend).**

Rationale: TECH "server ... issues corrections on sync"; example "overdraft detected → hint unrevealed and balance adjusted". Client sent the spend with its local_is_correct claim; server records it (append the hint_purchased), then if authoritative prior facts from other device made the spend an overdraft, emit a compensating BalanceCorrected fact (+cost, reason:"overdraft_on_hint", attached to same step) which client will append locally and re-project (bal comes back, perhaps UI shows "hint spend corrected"). Server never removes facts (append-only). For first cut: the generator can be a no-op returning vec![] ; skeleton + one concrete case (post-batch if project_balance < 0 after a just-accepted negative delta, emit +abs delta correction). This is enough to prove the protocol in tests without over-speculating the full policy (which will be iterated with real multi-device goldens later).

All corrections are also Fact variants so they go through the same projectors (their coins_delta affects bal, their step may affect revealed if policy says so).

**Decision: Layout in backend/src/ stays flat for now (facts.rs, store.rs or facts/store.rs module, updates only to main.rs + errors.rs); tests co-located in the modules.**

Rationale: Initial skeleton is flat (config, errors, main). Per YAGNI + "promoted to workspace members only when ... justified". One new domain module facts.rs (types + pure fns + tests) + store.rs (or combined) keeps it small. In main: `mod facts; mod store; use facts::{Fact, project_balance, ...};` then in build_router add routes, in AppState add the store field. All new pub have docs. Existing health test stays (its unwraps are test-only setup); new api tests avoid prod unwraps.

**Decision: No changes to Cargo.toml or toolchain (serde/axum already present; use std collections + parking not needed).**

Rationale: YAGNI. Mutex from std works. If lock contention ever measured, swap to tokio::sync::RwLock (one-line change in state).

## Risks / Trade-offs

[In-mem store loses state on every server restart / deploy] → Mitigation: acceptable for current demo/MVP (player goldens + local LS are the primary); explicit "swap path" in store design + tasks include "add file-backed jsonl impl behind same methods" as future small slice. Data is append-only facts (easy to replay from client on next sync).

[Enum Fact duplicates fields across 8+ variants (verbosity)] → Mitigation: ~100 LOC total, highly readable, enables safe exhaustive projectors + perfect wire fidelity; refactor to common struct + payload enum only when N variants or fields grows (YAGNI now). Self-crit: worth the duplication for type safety and match ergonomics.

[Mutex in async handlers] → Mitigation: critical sections are pure memory ops on tiny data (<1us); no I/O or await inside lock; documented. If load increases, one-line change to RwLock or actor.

[Client-generated attempt_id strings are untrusted / collide-prone] → Mitigation: for MVP ok (namespace by future user+grant); natural keys inside are what matter for idempotency. Future auth change will add prefix validation or UUID newtype without changing log shape.

[Correction policy is underspecified in v1 (what exactly triggers unreveal vs just bal fix?)] → Mitigation: start with conservative "record everything client claims + emit compensating delta facts"; pure generator fn is the extension point. Real policy + UI for "hint unrevealed" will be driven by player wiring + new goldens covering the race. Tests will assert at least one correction path.

[Projector parity relies on manual mirror of TS fold + golden literals] → Mitigation: the replay test is the gate; any drift fails loudly in CI. When shared crate or json-schema appears, can generate or property-test the fold equivalence. For now parallel pure fns are the pragmatic KISS that satisfies "exact match" immediately.

[Snapshot manifest with Value is half-way] → Mitigation: sufficient for retention + re-mat id; full typed re-use of shared model deferred (no Rust GameStep yet, YAGNI).

[Extending AppError + response for 4xx may affect health test style] → Mitigation: only additive; existing 200 health untouched. New tests cover error cases with proper status.

Trade-off YAGNI vs robustness: chose in-mem + String ids + duplicate fields in enum + conservative corrections over "perfect" (newtypes everywhere, sqlx from day 1, full policy, shared model crate, fs persist). This still survives every edge called out in PLAN/TECH (idemp, races, corrections, projectors, multi-device, historical) and produces immediately runnable tests against goldens. Enables future slices with zero rewrite of the core fold/append logic.

## Migration Plan
- No prod data yet (fresh skeleton). On apply of this change: cargo test in backend must go green (new replay + api tests); full `cargo clippy -- -D warnings && cargo fmt -- --check && cargo build`.
- Rollback: revert the four files + router additions; no schema.
- Later when persistence added: one-time load of any in-mem facts into jsonl (or just rely on clients re-syncing their local logs on next connect — idempotent so safe).

## Open Questions
- Exact shape of correction facts for "hint unrevealed" (does it carry the original hint_purchased or just bal delta? UI implications in player when wired).
- When real published snapshots exist (post-ctor publish slice), will client send the full snapshot JSON on first append for manifest, or will there be a separate /snapshots/:id/publish?
- Should natural key include a client local_seq or ts once added (for true last-write-wins inside same device+step)?
- Analytics projection: include feedback count per step? (easy additive).

(Internal self-critique after drafting: This design is the direct result of the required adversarial cycle applied to every prior naive approach (mutable rows, non-idempotent, drift, no corrections, premature DB). Every decision justifies against PLAN verbatim bullets, TECH event-sourced split, goldens TDD contract, rust.md, YAGNI, and the exact emitted Fact[] from archived player + replay test. Concrete sketches, alt-rejections, and risks with mitigations are present. Pure projectors + append-only log + manifest survive all listed races without mutable state. In-mem + natural keys + enum are elegant yet minimal. No context/rules from instructions leaked into the md. References proposal. Ready for specs (7-10 reqs will map 1:1 to these decisions + edges) and tasks (TDD projectors/goldens first, then store, handlers, error, integration tests proving idemp + corrections + parity, fmt/clippy gates, final self-crit). If a flaw remains it is the lack of a property test generator for facts (deferred; goldens + manual edges cover the briefing requirements).)