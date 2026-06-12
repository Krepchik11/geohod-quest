# Proposal: persistence-postgres

## Why

Every store is an in-memory HashMap: a backend restart silently destroys all facts, grants, attempts, and published quests. The product's core promises — lifetime grants, immutable published snapshots, append-only fact logs, completion-bonus once-ever — are durability claims, and today none of them survive a process restart. P1 deliberately shaped the stores so persistence is a backend swap with projectors and handlers untouched; this change executes that swap (owner decision: PostgreSQL + sqlx). It also closes two P1 leftovers that need real storage to exist: published snapshots are metadata-only (no frozen snapshot JSON is stored anywhere server-side), and there is no bundle download endpoint gated by grant (SPEC: "Grant before attempt/bundle").

## What Changes

- Add a storage backend abstraction with two implementations: the existing in-memory stores (kept for tests and zero-infra dev) and a new PostgreSQL implementation via sqlx. Selection at startup: `DATABASE_URL` set → Postgres (migrations run automatically); unset → in-memory with a logged warning.
- PostgreSQL schema (sqlx migrations): `attempts` (indexed by player_id+quest_id), `facts` (append-only, UNIQUE(attempt_id, natural_key) enforcing idempotency in the database, not just in code), `bonus_awards` (PRIMARY KEY(player_id, quest_id) — the completion-bonus once-ever invariant as a constraint), `grants` (PK(player_id, quest_id)), `published_quests`, `snapshots` (frozen JSONB per version, retained forever), `migration_marks`.
- Real snapshot storage: publish accepts the full frozen snapshot JSON and stores it per version; old versions are never overwritten (version freeze).
- New `GET /api/quests/{quest_id}/bundle?player_id=…`: returns the latest published snapshot JSON **only** for grant holders (403 otherwise) — the bundle download primitive (asset packing comes with the media store phase).
- Dev infra: `docker-compose.yml` (Postgres 17) + `.env.example`; README note.
- Handler tests stay on the in-memory backend (fast, no infra); a Postgres integration test suite runs when `DATABASE_URL` is present and self-skips otherwise.

## Capabilities

### New Capabilities

- `persistence`: durable storage behind the store abstraction — backend selection, restart survival, database-enforced idempotency/bonus invariants, frozen snapshot storage, grant-gated bundle endpoint.

### Modified Capabilities

(None — facts-sync/marketplace-grants behavior is unchanged; this change moves where the already-specified invariants are enforced. The bundle endpoint is specified under the new `persistence` capability.)

## Impact

- `backend/Cargo.toml`: + `sqlx` (postgres, runtime-tokio, migrate, uuid/chrono as needed).
- `backend/src/store.rs`: store enum/dispatch + in-memory impl (existing logic unchanged).
- New `backend/src/pg_store.rs` (or module): Postgres implementation; `backend/migrations/*.sql`.
- `backend/src/main.rs`: async store calls in handlers; startup backend selection; bundle route.
- `platform/docker-compose.yml`, `backend/.env.example`.
- Frontend: `lib/api.ts` gains `getBundle`; constructor publish extended to send full snapshot JSON (UI wiring stays minimal — design fidelity is P3).
