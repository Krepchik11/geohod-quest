# GeoQuest Platform (monorepo)

The runnable product: a Rust API, a Next.js app, and the fixtures that keep the two
in agreement.

- **backend/** — Rust 1.96 + Axum 0.8 HTTP API: event-sourced facts, frozen snapshots,
  access grants, bundles, identity/roles, commerce. In-memory or PostgreSQL storage,
  selected by `DATABASE_URL`.
- **frontend/** — Next.js 16.2 + React 19 (RSC-first): marketplace, offline PWA player,
  internal constructor, back office.
- **goldens/** — frozen demo snapshots plus the `parity/` fixtures that hold the Rust
  and TypeScript folds to the same output.

## Quick start

```bash
npm install          # sets up the frontend workspace + concurrently
npm run dev          # backend :8080 and frontend :3000, logs prefixed
```

Or split across two terminals: `npm run dev:backend` / `npm run dev:frontend`.

## Commands

| Command             | What it does                                 |
|---------------------|----------------------------------------------|
| `npm run dev`       | Concurrent backend + frontend (dev)          |
| `npm run build`     | Production frontend build                    |
| `npm test`          | Backend `cargo test` + frontend vitest       |
| `npm run lint`      | Frontend eslint + backend `clippy -D warnings` |
| `npm run fmt:check` | Rust formatting check                        |

## Quality gates (every change)

- **Backend**: `cargo fmt -- --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo doc --no-deps` with `RUSTDOCFLAGS=-D warnings`, `cargo test` — all green,
  and all four run in `backend-ci.yml`. (Until recently only `cargo test` did; the
  other three were documented here and enforced nowhere.) The integration suite
  runs the same scenarios against both storage backends.
- **The PostgreSQL half needs a server, and `.env` decides that** — not the
  absence of a variable. The `pg_*` tests skip only when `DATABASE_URL` is unset,
  the harness calls `dotenv().ok()` first, and `backend/.env.example:5` ships
  `DATABASE_URL` **uncommented** — so copying the example as instructed makes
  those 32 tests run, and fail with `PoolTimedOut` if nothing is listening. Start
  Postgres (`docker compose up -d postgres`) or comment the line out.
- **Frontend**: `npm test`, `npm run build`, `npm run lint` — TypeScript strict, clean.
  `npm run lint` also runs three mechanical rules: `lint:ds` (no deprecated
  design-system class), `lint:css-scope` (no route renders a class whose
  stylesheet that route does not load — see `frontend/README.md`) and
  `lint:doc-paths` (every repository path a document names is one git tracks or
  deliberately ignores, and the frontend origin in the docs is the one the deploy
  unit sets).
- **The HTTP surface is generated, not written.** `backend/API.md` — 70 endpoints
  over 67 paths — is produced from the `router()` functions and the `///` on each
  handler by `cargo test api_reference_is_committed`, which is also the gate that
  it still matches. Regenerate with `UPDATE_API=1`. A new route whose handler
  carries no doc fails that test.
- **One lockfile**, `platform/package-lock.json`. Install from `platform/`;
  `npm ci` in CI does the same. A second lockfile inside `frontend/` used to make
  CI resolve a tree nobody ran.
- Every edit is held to KISS/YAGNI: no over-extracted crates, no premature client
  components, no barrel imports. The rules that carry weight here are the ones a
  gate enforces (above) — prose rules that nothing checks are how the two
  vendored `agents/*.md` rule books ended up mandating crates this workspace does
  not have and database mocking this codebase deliberately rejects.

## Layout

```
platform/
├── package.json          # npm workspaces root + orchestration scripts
├── deploy/               # deploy artifacts + their docs (README/releases/vps)
├── goldens/              # frozen demo snapshots + shared parity fixtures (parity/)
├── backend/
│   ├── Cargo.toml · rust-toolchain.toml
│   ├── migrations/       # sqlx migrations, applied at startup
│   └── src/
│       ├── main.rs       # Axum router, handlers, auth gates, integration tests
│       ├── config.rs     # env-driven AppConfig (no unwraps)
│       ├── errors.rs     # thiserror + IntoResponse, structured errors only
│       ├── auth.rs       # identity primitives (argon2, session tokens, roles)
│       ├── social.rs     # Google + Telegram sign-in (OIDC verification)
│       ├── snapshot.rs   # the ONE reader of a frozen snapshot (chips, start point, colours)
│       ├── facts.rs      # the event vocabulary + pure deterministic projectors
│       ├── grants.rs     # lifetime access grants (idempotent by player+quest)
│       ├── coupons.rs    # discount codes + server-validated redemption
│       ├── payments.rs   # PaymentProvider seam (always-approving mock)
│       ├── yookassa.rs   # YooKassa redirect provider (checkout, webhook, poll)
│       ├── features.rs   # feature-flag registry (code) over runtime overrides
│       ├── settings.rs   # runtime string settings registry
│       ├── admin_stats.rs# back-office aggregates, trends, per-quest funnels
│       ├── export.rs     # full quest export to zip
│       ├── media.rs      # media storage + serving (local or R2 via the API origin)
│       ├── icons.rs      # per-quest PWA icons: cover → maskable 192/512 PNG
│       ├── mailer.rs     # transactional mail (lettre SMTP or log fallback)
│       ├── store.rs      # store dispatch + in-memory backend (the executable spec)
│       └── pg_store.rs   # PostgreSQL backend (mirrors in-memory exactly)
└── frontend/             # see frontend/README.md for its app/ + lib/ layout
```

## Identity model

- **Anonymous-first**: the browser mints a device UUID once
  (`localStorage['geohod-device-id:v1']`); the player id is `dev:<uuid>`. No
  registration is needed to buy or play; identity exists before any network call.
- **Email-first**: `POST /api/auth/identify` (rate-limited) tells the client whether an
  email is new or known, so the user never picks the wrong mode. Registration attaches
  the email and an argon2 hash to the SAME player id — purchases, coins and facts
  survive with zero migration. Login returns the account id and an opaque session token.
- **Social sign-in**: Google and Telegram identities link to an account as rows in
  `identities` (every sign-in method is one row there — password included); a
  Telegram account may have neither email nor password. Both are behind feature
  flags and fail closed when the deployment has no credentials.
- **Recovery**: `POST /api/auth/recover` issues a hashed single-use token (mailed as
  both a link and a 6-digit code); `POST /api/auth/reset` consumes it. Email
  confirmation is soft — a banner nudges, nothing blocks.
- **Sessions are secrets, and they are stored like secrets**: only `sha256(token)`
  reaches the `sessions` table, exactly as the mailed reset link and code do — a
  leaked dump yields no working login. The raw token exists in the client's
  storage and nowhere else, and exactly one function opens a session
  (`handlers::auth::open_session`), so no route can persist a bearer secret by
  taking a shortcut.
- **A session never outlives the password it came from**: a reset closes every
  session (recovery means the account may already be in other hands); a password
  change closes every OTHER one and spares the device doing the change. Nothing
  else expires a session, which is precisely why these two must.
- **Guessing is bounded**: sign-in allows 10 failed attempts per email per 15
  minutes, and a success hands the whole budget back — ordinary use can never
  accumulate into a lockout. Argon2 runs on the blocking pool, so a burst of
  sign-ins cannot stall the request loop. What is NOT bounded is per-IP: that
  needs a trusted proxy-header contract this deployment does not yet state, and
  a limiter keyed on a spoofable header is worse than none.
- **Two-tier enforcement**: a registered player id requires `Authorization: Bearer
  <token>` on player-scoped endpoints; anonymous ids are credentialed by device
  possession (`X-User-Id`, sent automatically by `frontend/lib/identity.ts`).

## Quest ownership

A constructor quest belongs to the account that created it: only that author sees it
in their workspace, and only they may edit, publish or delete it. An **admin** is the
superuser — they reach every author's quest, and they alone may hand one over
(`POST /api/constructor/quests/{id}/author`), choosing from the accounts that may own
a quest at all (editor or admin, `auth::AUTHOR_ROLES`). The shared `ADMIN_TOKEN` never
qualifies: it carries no identity, so an operator credential cannot redistribute
authorship.

Because ownership can change, every per-quest mutation carries the owner the access
check observed (`store::AuthorGuard`) and applies only while that still holds — a
transfer landing mid-request can cost the loser their edit, never the quest.

## Feature flags

The registry lives in code (`backend/src/features.rs`) — adding a flag is a code change,
so the set is always reviewable. What an admin controls at runtime is only the override,
stored in `feature_overrides`.

Every flag ships **off**, and nothing seeds overrides. A fresh deployment therefore comes
up with social sign-in and both payment providers disabled; enabling each is an explicit
admin decision in the back office. Evaluation is two independent fail-closed gates:
*capability* (the deployment holds the credentials) and *toggle* (the override, else the
code default).

## Adding packages

When a genuinely shared concern appears (a shared `contract` package for API types,
say), create it under `packages/`, add it to the root `workspaces` array, and keep
it framework-agnostic.
Do **not** create packages "just in case".
