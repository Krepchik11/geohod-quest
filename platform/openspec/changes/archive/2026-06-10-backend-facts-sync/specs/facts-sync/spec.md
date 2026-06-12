# facts-sync

## ADDED Requirements

### Requirement: Idempotent append of fact batches by natural keys
The facts-sync backend SHALL accept POST /api/attempts/:attempt_id/facts with a batch of Fact objects (exact shape from shared model: type, step_position, submitted_value, local_is_correct, coins_delta, note, device_id) and append only facts not already present for that attempt (deduplicated by natural key: device_id + step_position + fact type + submitted_value + coins_delta + note). Duplicate facts in the same batch or from reconnects/multi-device SHALL be no-ops (not re-appended, not double-counted in projections). The response SHALL list only the newly accepted facts for this call.

#### Scenario: Reconnect with exact pending facts produces no-op and unchanged projection
- **WHEN** a player has local facts [physical_confirmed at 0, answer_submitted at 1, gift_claimed at 2, attempt_completed at 3] (happy-with-gift), goes offline, then reconnects and POSTs the identical batch again for the same attempt_id
- **THEN** the server reports 0 newly accepted facts, the fact log length is unchanged, and project_balance and project_state are identical to before the second POST (no double +5 coins, no duplicate completed steps).

#### Scenario: Mixed batch with some duplicates and one new fact
- **WHEN** client sends a batch containing 3 already-seen facts (by natural key) plus 1 new feedback_reported at step 1 for the attempt
- **THEN** response.accepted contains exactly the 1 new fact, response.projected reflects the added fact (fact_count increases by 1), and re-projection on client after applying accepted produces the same state as server.

### Requirement: Pure deterministic projectors for balance, state and analytics exactly match client goldens
The system SHALL provide pure functions (no side effects, no IO, deterministic) project_balance(facts), project_state(facts) and project_analytics(facts) such that, for any sequence of Facts deserialized from the shared golden playthrough-happy-with-gift expected_facts (or equivalent actions on mystery-fortress-v1), the outputs are identical to the TypeScript projectBalance / projectState results: balance == 5, completed_steps == [0,1,3], revealed_hints == [], and analytics counts match (0 hints, 0 wrongs on happy path).

#### Scenario: Replay happy-with-gift expected_facts on server produces exact golden projections
- **WHEN** the server deserializes the exact expected_facts array from playthrough-happy-with-gift.json (physical at 0, answer "МИХАЙЛО ПУПИН" at 1, gift_claimed +5 at 2, attempt_completed at 3) and calls the Rust projectors
- **THEN** project_balance returns 5, project_state returns completed_steps sorted unique [0,1,3] and revealed_hints [], project_analytics reports 0 hints_used / 0 wrongs / 1 completion; results are byte-identical in semantic value to the client golden asserts.

#### Scenario: Extra edge facts (wrong answer + 0-cost hint spend + feedback + navigator) project correctly
- **WHEN** starting from happy facts and appending answer_submitted (wrong, local_is_correct=false) at 1, hint_purchased at 1 (coins_delta=0), feedback_reported at 1, navigator_used at 0
- **THEN** project_balance still accounts for the original +5 (no negative), project_state has revealed_hints containing 1 and completed unchanged, analytics reports 1 hint_used, 1 wrong, 1 nav_click; no overdraft or lost facts.

### Requirement: Correction protocol returns compensating facts and authoritative projection on append
On append, after processing the batch idempotently, the server SHALL compute any required corrections (explicit compensation facts such as balance_corrected with coins_delta and reason) for detected inconsistencies (overdraft after multi-device spend, version mismatch, duplicate reward), append those corrections to the log as well, and return them in the response.corrections array together with the updated authoritative projected state. Client can fold corrections locally to converge.

#### Scenario: Overdraft on hint spend from stale local balance produces compensating correction
- **WHEN** attempt has prior facts giving authoritative bal=3 (from another device), client (offline with stale view of bal=5) sends hint_purchased step=1 coins_delta=-5; server appends the client's fact (per client authority) then detects post-append bal=-2
- **THEN** response contains a balance_corrected fact (coins_delta=+5, reason containing "overdraft_on_hint", same step), the log now includes both the original spend and the correction, response.projected.balance == 3 (or + client delta after correction), and client applying the returned correction re-projects to the authoritative value.

#### Scenario: Version mismatch on append for bound snapshot emits correction without dropping facts
- **WHEN** attempt is bound to snapshot "golden-mystery-fortress-v1", client sends new facts carrying snapshot_id "v2-published"
- **THEN** the facts are still accepted (idempotent), a version_mismatch_corrected (or equivalent) fact is returned in corrections, projected state uses the original bound snapshot's facts, and the attempt binding is unchanged.

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
The append endpoint SHALL process the entire supplied batch (in order), apply idempotency per fact, emit any corrections, and return a response containing accepted, corrections, and the final projected state for that attempt. The client (on reconnect) can append the accepted + corrections to its local log and re-project to obtain server-authoritative state.

#### Scenario: Long offline queue with one conflicting fact from other device
- **WHEN** player has 10 pending facts offline; on reconnect one of them is now duplicate because other device completed the same step; server also detects a small overdraft on a hint in the queue
- **THEN** response.accepted has 9 facts, corrections has 1 (the compensating bal fact), projected is the converged authoritative view; client applies exactly those to its local facts array and its UI balance/revealed now matches server with no lost actions or double rewards.

### Requirement: Projectors and append are pure / deterministic with no mutable server state outside the append-only log
All projectors SHALL be pure functions of their fact input only (same input always same output, no globals, no randomness, no time). The only mutable thing on server SHALL be the append-only fact logs + manifest bindings; there SHALL be no direct mutation of balance, completed sets, or revealed outside of appending a fact (or correction) and re-folding.

#### Scenario: Empty log and repeated identical projections
- **WHEN** an attempt has zero facts, project_balance([]) is called 100 times, or after appending a single gift_claimed fact the projectors are called before/after unrelated operations
- **THEN** empty always yields balance=0, completed=[], revealed=[]; post-append yields the same values on every call; no side effects visible (logs only grow via explicit append paths).

### Requirement: Error handling for bad payloads returns structured errors without leaking internals
Malformed fact batches (missing required fields, unknown type for current schema, negative step_position) SHALL be rejected with 4xx before any append or projection; the error response SHALL be consistent JSON and shall not expose store internals or stack traces.

#### Scenario: POST facts with missing device_id or non-numeric coins_delta
- **WHEN** client sends a fact object lacking device_id or with coins_delta as string
- **THEN** the handler returns 400 Bad Request (or equivalent via AppError), no facts are appended, and the attempt log is untouched; the error message is high-level ("invalid fact payload").

(These requirements + scenarios are directly testable via backend unit/integration tests that deserialize goldens, call the pure fns, exercise the Axum oneshot router against the handlers, and assert on response bodies + internal log state after each operation. They map 1:1 to the decisions and edge cases in the design and proposal while remaining implementation-free.)