# persistence Specification

## Purpose
TBD - created by archiving change persistence-postgres. Update Purpose after archive.
## Requirements
### Requirement: Storage backend is selected at startup and behavior is identical across backends
The server SHALL run against PostgreSQL when `DATABASE_URL` is set (running pending sqlx migrations on startup) and against the in-memory stores when it is not (logging a clear non-durability warning). All API behavior specified by facts-sync and marketplace-grants SHALL be identical on both backends; the projectors remain the single pure implementations and are never reimplemented in SQL.

#### Scenario: Same test suite passes on both backends
- **WHEN** the integration suite runs against the in-memory backend and the Postgres-backed suite runs with `DATABASE_URL` present
- **THEN** the grant→attempt→facts chain, idempotent append, negative-balance persistence, completion-bonus once-ever, and version-freeze scenarios pass identically on both.

### Requirement: All domain state survives a restart on the Postgres backend
Facts, attempts, grants, published quests, snapshots, and migration marks SHALL be durable: after a server process restart, projections, grant checks, attempt bindings, and bonus idempotency reflect all data written before the restart.

#### Scenario: Restart preserves projections and invariants
- **WHEN** a player completes steps and earns the completion bonus, the server restarts, and the same player creates a new attempt and re-uploads the bonus
- **THEN** GET state for the old attempt still returns the pre-restart projection, and the re-uploaded bonus is rejected as a duplicate (once per player+quest survives restart).

### Requirement: Idempotency invariants are enforced by database constraints, not only application code
The facts table SHALL carry a uniqueness constraint on (attempt_id, natural_key) — the device-agnostic natural key — and completion-bonus once-ever SHALL be enforced by a primary-key constraint on (player_id, quest_id) in a bonus-award table, so that concurrent duplicate appends racing past the application check are absorbed by the database (insert-on-conflict-do-nothing), never double-applied.

#### Scenario: Concurrent duplicate batches collapse to one fact
- **WHEN** two clients concurrently POST the same gift_claimed fact for the same attempt
- **THEN** exactly one row exists afterwards, exactly one request reports it as accepted, and project_balance counts it once.

### Requirement: Published snapshots are stored frozen per version and never overwritten
Publish SHALL accept the full snapshot JSON and store it keyed by snapshot_id; publishing a new version inserts a new row and updates only the quest's latest pointer. Existing snapshot rows are immutable — re-publish with an existing snapshot_id for different content SHALL be rejected.

#### Scenario: Version freeze at the storage layer
- **WHEN** quest Q publishes v1 with snapshot S1, then publishes v2 with snapshot S2
- **THEN** S1 remains retrievable byte-identical for attempts bound to it, and new attempts bind S2.

### Requirement: Bundle download is gated by grant
GET /api/quests/{quest_id}/bundle SHALL return the latest published snapshot JSON only when the requesting player holds an AccessGrant for the quest; otherwise 403. Unpublished quests return 404.

#### Scenario: Grant required before bundle
- **WHEN** a player without a grant requests the bundle for a published quest
- **THEN** the server returns 403 and no snapshot content; after checkout, the same request returns the snapshot JSON.

