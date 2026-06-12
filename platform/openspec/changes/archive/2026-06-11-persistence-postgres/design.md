# Design: persistence-postgres

## Context

P1 left the backend with pure projectors, an attempt registry, device-agnostic natural keys, and a bonus-once-ever rule — all enforced in in-memory HashMaps under `Arc<Mutex>`. Handlers never await inside the lock, so the swap point is clean. Owner decisions: PostgreSQL + sqlx; in-memory stays for tests/dev; the (player_id, quest_id) bonus check must be indexed.

## Goals / Non-Goals

**Goals:**
- Durable Postgres backend with identical observable behavior to in-memory (same integration scenarios green on both).
- Database-enforced idempotency (UNIQUE on natural key) and bonus-once-ever (PK on player+quest) so concurrent races are absorbed below application code.
- Frozen snapshot JSON stored per version; grant-gated bundle endpoint.
- Zero-infra dev/test path preserved (no DATABASE_URL → in-memory).

**Non-Goals:**
- Media/asset storage (separate phase, local-FS-behind-trait decision).
- Bundle asset packing/size measurement (needs media store).
- Auth/session storage (P5).
- SQL-side projections — folds stay in Rust, fixtures keep enforcing client parity.

## Decisions

1. **Enum dispatch over trait objects.** `Store` and `GrantStore` become enums (`InMemory(Mutex<…>)` | `Postgres(PgPool)`), with async methods matching the current store API but returning `Result`. Rationale: exactly two backends form a closed set; async-fn-in-trait is not dyn-compatible without `async_trait` boxing, and generics would make `AppState`/router viral. Enum keeps one concrete `AppState`, exhaustive matches, no new deps. Revisit as a trait only if a third backend ever appears (YAGNI).

2. **Natural key as a stored column.** `facts.natural_key TEXT` computed in Rust (canonical serialization of the P1 tuple) with `UNIQUE(attempt_id, natural_key)`. Rationale: a multi-column UNIQUE over nullable `submitted_value`/`note` is broken in Postgres (NULLs compare unequal), so dedup would silently fail for facts with NULL fields. One canonical string column makes `INSERT … ON CONFLICT DO NOTHING` the idempotency mechanism; "accepted" = rows actually inserted (RETURNING).

3. **`bonus_awards(player_id, quest_id)` PK table.** The bonus invariant is cross-attempt, but facts rows are attempt-scoped; enforcing it via a join-based check is racy under concurrency. Inserting into `bonus_awards` ON CONFLICT DO NOTHING inside the same transaction as the fact insert makes the invariant atomic: conflict → drop the bonus fact from the batch.

4. **Append is one transaction per batch.** All inserts for a batch (facts + any bonus award) commit atomically; the response's `accepted` list is derived from what actually inserted. Projection still happens by loading the attempt's facts and running the pure fold.

5. **Runtime-checked sqlx queries (no `query!` macros yet).** Macros require a live DATABASE_URL or a committed `.sqlx` offline cache at compile time, which would break `cargo clippy/test` on machines without Postgres — including the zero-infra path this design promises. Trade-off accepted: SQL typos surface at test time (the Postgres suite) instead of compile time. Revisit with `cargo sqlx prepare` once the schema stabilizes.

6. **Postgres tests self-skip.** A `pg_tests` integration module runs the same scenario set as the in-memory suite (shared helper fns) but early-returns with an eprintln when `DATABASE_URL` is unset. CI/dev without a database stays green; with `docker compose up -d` + env they execute. Each test uses schema-isolated state (unique ids per run) to tolerate a shared database.

7. **Snapshot immutability check.** Publishing with an existing snapshot_id compares stored JSONB to the supplied snapshot: identical → idempotent no-op, different → 409-style rejection (BadRequest). Prevents silent content swaps under a frozen id.

8. **Attempt ids become UUIDs on Postgres** (`gen_random_uuid()`); in-memory keeps its sequence. Ids are opaque strings to clients — no contract change.

## Risks / Trade-offs

- [Runtime SQL errors instead of compile-time] → Postgres suite covers every query path; offline cache later.
- [Two backends can drift] → both run the same scenario helpers; the in-memory store is also the executable specification for the SQL behavior.
- [Shared dev database pollutes test runs] → tests generate unique player/quest/attempt ids per run; no truncation needed.
- [JSONB snapshot size] → quests are ~5 MB bundles dominated by media, which is NOT in the snapshot JSON (refs only); text snapshots are small.

## Migration Plan

Additive: new files + handler signature changes. No data to migrate (nothing durable exists). Rollback = unset DATABASE_URL.

## Open Questions

None blocking.
