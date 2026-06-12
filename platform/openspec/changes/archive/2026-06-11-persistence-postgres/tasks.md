# Tasks: persistence-postgres

## 1. Schema + infra

- [x] 1.1 Add sqlx to Cargo.toml (postgres, runtime-tokio-rustls, migrate, json); `platform/docker-compose.yml` (Postgres 17) + `backend/.env.example` (DATABASE_URL)
- [ ] 1.2 sqlx migrations: attempts (+ idx player_id,quest_id), facts (UNIQUE(attempt_id, natural_key)), bonus_awards (PK player_id,quest_id), grants (PK player_id,quest_id), published_quests, snapshots (JSONB, immutable), migration_marks

## 2. Store abstraction

- [ ] 2.1 `store.rs`: introduce async enum dispatch (`FactStores`, `GrantStores`: InMemory | Postgres) exposing the current store API as async Result methods; in-memory logic unchanged behind it
- [ ] 2.2 New Postgres impl: create_attempt (uuid), append_idempotent (single txn, ON CONFLICT DO NOTHING via natural_key column, bonus via bonus_awards insert), get_projected (load facts → pure fold), version stats + feedback list, grants/published/snapshots, migration marks
- [ ] 2.3 Snapshot storage + immutability: publish stores full snapshot JSON per snapshot_id; same id + different content rejected; same id + same content idempotent

## 3. API surface

- [ ] 3.1 `main.rs`: handlers await store calls; startup selects backend from DATABASE_URL (run migrations) with non-durability warning otherwise; publish accepts optional `snapshot` JSON body
- [ ] 3.2 `GET /api/quests/{quest_id}/bundle?player_id=…`: 403 without grant, 404 unpublished, else latest snapshot JSON

## 4. Tests

- [ ] 4.1 Existing integration tests stay green on in-memory backend (handler refactor only); add bundle-endpoint tests (403/404/200) on in-memory
- [ ] 4.2 Postgres integration suite (self-skips without DATABASE_URL): same scenarios via shared helpers — happy chain, idempotent reconnect, negative balance, bonus once-ever (incl. concurrent duplicate batch), version freeze, snapshot immutability, restart-survival (new pool, data persists)

## 5. Frontend + gates

- [ ] 5.1 `lib/api.ts`: add `getBundle(questId, playerId)`; constructor publish sends full snapshot JSON
- [ ] 5.2 All gates green: cargo fmt/clippy -D warnings/test, vitest, next build, root npm test; run Postgres suite once against docker compose; archive change
