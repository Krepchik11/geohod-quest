# facts-sync
## Purpose

See the capability's change history; requirements below are the source of truth for behavior.
## Requirements
### Requirement: Idempotent append of fact batches by natural keys
The facts-sync backend SHALL accept POST /api/attempts/:attempt_id/facts with a batch of Fact objects (exact shape from shared model: type, step_position, submitted_value, local_is_correct, coins_delta, note, device_id) and append only facts not already present for that attempt, deduplicated by a **device-agnostic** natural key: step_position + fact type + submitted_value + coins_delta + note. device_id is recorded on the fact for audit/analytics but SHALL NOT participate in the key — the same semantic event (a gift claim, a completion, a hint purchase, a bonus) arriving from two devices is one fact, never two. Duplicate facts in the same batch or from reconnects/multi-device SHALL be no-ops (not re-appended, not double-counted in projections). The response SHALL list only the newly accepted facts for this call.

#### Scenario: Reconnect with exact pending facts produces no-op and unchanged projection
- **WHEN** a player has local facts [physical_confirmed at 0, answer_submitted at 1, gift_claimed at 2, attempt_completed at 3] (happy-with-gift), goes offline, then reconnects and POSTs the identical batch again for the same attempt_id
- **THEN** the server reports 0 newly accepted facts, the fact log length is unchanged, and project_balance and project_state are identical to before the second POST (no double +5 coins, no duplicate completed steps).

#### Scenario: Same gift claimed from two devices counts once
- **WHEN** device A and device B (offline, later syncing) both emit gift_claimed at step 2 with coins_delta +5 and the same note for the same attempt
- **THEN** the log contains exactly one gift_claimed fact for step 2 and project_balance includes +5 exactly once.

### Requirement: Pure deterministic projectors for balance, state and analytics exactly match client goldens
The system SHALL provide pure functions (no side effects, no IO, deterministic) project_balance(facts), project_state(facts) and project_analytics(facts) such that, for any sequence of Facts deserialized from the shared golden playthrough-happy-with-gift expected_facts (or equivalent actions on mystery-fortress-v1), the outputs are identical to the TypeScript projectBalance / projectState results: balance == 5, completed_steps == [0,1,3], revealed_hints == [], and analytics counts match (0 hints, 0 wrongs on happy path).

#### Scenario: Replay happy-with-gift expected_facts on server produces exact golden projections
- **WHEN** the server deserializes the exact expected_facts array from playthrough-happy-with-gift.json (physical at 0, answer "МИХАЙЛО ПУПИН" at 1, gift_claimed +5 at 2, attempt_completed at 3) and calls the Rust projectors
- **THEN** project_balance returns 5, project_state returns completed_steps sorted unique [0,1,3] and revealed_hints [], project_analytics reports 0 hints_used / 0 wrongs / 1 completion; results are byte-identical in semantic value to the client golden asserts.

#### Scenario: Extra edge facts (wrong answer + 0-cost hint spend + feedback + navigator) project correctly
- **WHEN** starting from happy facts and appending answer_submitted (wrong, local_is_correct=false) at 1, hint_purchased at 1 (coins_delta=0), feedback_reported at 1, navigator_used at 0
- **THEN** project_balance still accounts for the original +5 (no negative), project_state has revealed_hints containing 1 and completed unchanged, analytics reports 1 hint_used, 1 wrong, 1 nav_click; no overdraft or lost facts.

### Requirement: Multi-device fact merge by idempotent union converges to identical projection
Facts appended from different device_ids for the same attempt SHALL be unioned (deduped only on exact natural key match); the resulting log, when projected, SHALL be identical regardless of append order or interleaving. "Once revealed stays revealed" and additive sums hold.

#### Scenario: Device A and Device B interleave physical + answer + gift facts
- **WHEN** device-a appends physical at 0 and answer at 1; then device-b appends the same two facts plus gift_claimed at 2; then device-a appends the gift + terminal
- **THEN** after all three POSTs, both devices (or a GET /state from either) see the exact same projected balance=5, completed_steps=[0,1,3], fact log containing exactly the 4 unique facts (no duplicates even though sent twice), and no lost rewards.

### Requirement: Snapshot manifest retains binding for historical re-materialization from facts
The system SHALL bind an attempt to a snapshot_id on the first append that supplies one (or explicit), retain the binding + optional raw snapshot data in a manifest, and support re-materialization: given only the fact log for an attempt + its manifest snapshot_id, the pure projectors produce the identical balance / completed / revealed that the client produced when it emitted those facts against that snapshot.

#### Scenario: Re-materialize happy path state from stored facts + manifest ref only
- **WHEN** facts for happy-with-gift have been appended and bound to snapshot_id "golden-mystery-fortress-v1" (manifest entry exists with id only, no full data needed for deltas), server is restarted (in-mem cleared), then the same facts are re-ingested or a GET /state is performed
- **THEN** project_balance(facts) == 5 and project_state matches the original golden exactly; the manifest entry for the snapshot_id survives (or is re-supplied) and the attempt remains bound; state can be reproduced without any mutable scalar storage.

### Requirement: GET /state returns authoritative projected view + meta after any appends
After any successful append (or independently), GET /api/attempts/:attempt_id/state SHALL return the current projected state (balance, completed_steps, revealed_hints) computed from the full fact log for the attempt, plus snapshot_id, fact_count, and last known meta. It SHALL be consistent with what an append response would have returned for the same log.

#### Scenario: State after partial play + gift claim
- **WHEN** only the first two facts (physical 0 + answer 1 + synthesized gift 2) have been appended for the attempt
- **THEN** GET /state returns balance=5, completed_steps=[0,1], revealed_hints=[], snapshot_id matching the bound value, fact_count=3; subsequent append of terminal updates the view on next GET.

### Requirement: Batch append and correction response enable client reconnect without data loss
The append endpoint SHALL process the entire supplied batch (in order), apply idempotency per fact, and return a response containing the accepted facts and the final authoritative projected state for that attempt. The server SHALL NOT generate, store, or return compensation facts of any kind. The client (on reconnect) appends the accepted facts to its local log, re-projects, and derives the two SPEC corrections itself: if the authoritative balance differs from its pre-sync local balance after a multi-device merge it shows the «Баланс обновлён» notice (old → new); if the authoritative furthest completed step exceeds its local position it offers to continue from the farther step. Steps are never lost (union of facts).

#### Scenario: Long offline queue with one duplicate fact from other device
- **WHEN** player has 10 pending facts offline; on reconnect one of them is now a duplicate because another device completed the same step
- **THEN** response.accepted has 9 facts, response contains no corrections array (or an always-empty legacy field is absent entirely), projected is the converged authoritative union view; client applies accepted facts, re-projects, and its balance/completed/revealed match the server with no lost actions and no double rewards.

#### Scenario: Multi-device merge leaves balance negative and it stays negative
- **WHEN** device A's facts give balance 2, device B (offline) purchased a hint costing 5 and syncs it
- **THEN** the hint fact is accepted, the authoritative projected balance is -3, no compensating fact is appended or returned, and a later GET /state still reports -3; the client compares -3 with its stale local value and shows the balance re-projection notice itself.

### Requirement: Projectors and append are pure / deterministic with no mutable server state outside the append-only log
All projectors SHALL be pure functions of their fact input only (same input always same output, no globals, no randomness, no time). The only mutable server state SHALL be the append-only fact logs, the attempt registry, and manifest bindings; there SHALL be no direct mutation of balance, completed sets, or revealed hints outside of appending a fact and re-folding. Balance is a plain signed sum of coins_delta and MAY be negative.

#### Scenario: Empty log and repeated identical projections
- **WHEN** an attempt has zero facts, project_balance([]) is called 100 times, or after appending a single gift_claimed fact the projectors are called before/after unrelated operations
- **THEN** empty always yields balance=0, completed=[], revealed=[]; post-append yields the same values on every call; no side effects visible (logs only grow via explicit append paths).

#### Scenario: Fold of spends exceeding earnings projects a stable negative balance
- **WHEN** facts contain gifts totaling +3 and hint purchases totaling -10
- **THEN** project_balance returns -7 on every invocation, in any fact order, with no clamping to zero anywhere in the server.

### Requirement: Error handling for bad payloads returns structured errors without leaking internals
Malformed fact batches (missing required fields, unknown type for current schema, negative step_position) SHALL be rejected with 4xx before any append or projection; the error response SHALL be consistent JSON and shall not expose store internals or stack traces.

#### Scenario: POST facts with missing device_id or non-numeric coins_delta
- **WHEN** client sends a fact object lacking device_id or with coins_delta as string
- **THEN** the handler returns 400 Bad Request (or equivalent via AppError), no facts are appended, and the attempt log is untouched; the error message is high-level ("invalid fact payload").

(These requirements + scenarios are directly testable via backend unit/integration tests that deserialize goldens, call the pure fns, exercise the Axum oneshot router against the handlers, and assert on response bodies + internal log state after each operation. They map 1:1 to the decisions and edge cases in the design and proposal while remaining implementation-free.)

### Requirement: Completion bonus is a fact awarded once per player and quest
The system SHALL record a `completion_bonus` fact of +5 coins when a player first completes a quest (enters the terminal step). The bonus SHALL be idempotent per (player_id, quest_id): duplicate uploads, retries, multi-device syncs, repeat attempts after reset, and replays on new versions of the same quest SHALL all yield exactly one `completion_bonus` fact for that player+quest, ever. The bonus participates in balance like any other fact.

#### Scenario: Duplicate completion bonus uploads collapse to one fact
- **WHEN** the client submits a `completion_bonus` fact for (player P, quest Q) twice in one batch, again on reconnect, and again from a second device
- **THEN** the log contains exactly one completion_bonus fact for P+Q, project_balance counts +5 exactly once, and every duplicate submission is reported as not-accepted.

#### Scenario: Replay after reset does not re-award the bonus
- **WHEN** player P completed quest Q (bonus recorded), resets progress, replays, and completes again on a new attempt
- **THEN** the new attempt's completion produces no second completion_bonus fact for P+Q; coins from the first award survive the reset (coins always survive reset).

### Requirement: Attempt creation is gated by an AccessGrant and binds the latest published snapshot
The system SHALL expose attempt creation (POST /api/attempts with player_id, quest_id) that succeeds only when an AccessGrant exists for (player_id, quest_id). On success it SHALL create an attempt bound to the latest published snapshot of the quest at creation time; the binding never changes for the attempt's lifetime. Without a grant the request SHALL be rejected with a structured 403 and no attempt is created.

#### Scenario: Attempt without grant is rejected
- **WHEN** player P has no grant for quest Q and POSTs /api/attempts {player_id: P, quest_id: Q}
- **THEN** the server returns 403 with a structured error, no attempt id is allocated, and no state exists for any attempt of P on Q.

#### Scenario: Attempt after grant binds the current latest version and keeps it after a new publish
- **WHEN** P holds a grant for Q (version 1 published), creates an attempt, and version 2 is published afterwards
- **THEN** the attempt remains bound to version 1 (its projections and amounts use version 1's snapshot), while a newly created attempt binds version 2.

### Requirement: Fact append is rejected for unknown attempts
The append endpoint SHALL reject batches addressed to an attempt_id that was not created via attempt creation, returning a structured 404 without appending anything. This enforces the chain grant → attempt → facts.

#### Scenario: Append to non-existent attempt
- **WHEN** a client POSTs facts to /api/attempts/ghost-attempt/facts where no such attempt exists
- **THEN** the server returns 404 with a structured error, no log is created, and a subsequent GET /state for that id also returns 404.

