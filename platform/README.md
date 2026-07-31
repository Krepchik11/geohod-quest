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

- **Backend**: `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test` — all
  green. The integration suite runs the same scenarios against both storage backends;
  the PostgreSQL pass self-skips without `DATABASE_URL` (see `backend/.env.example`).
- **Frontend**: `npm test`, `npm run build`, `npm run lint` — TypeScript strict, clean.
- Every edit is held to [`agents/rust.md`](../agents/rust.md) and
  [`agents/react.md`](../agents/react.md) plus KISS/YAGNI: no over-extracted crates, no
  premature client components, no barrel imports.

## Layout

```
platform/
├── package.json          # npm workspaces root + orchestration scripts
├── DEPLOYMENT.md         # build, deploy, first-boot procedure
├── goldens/              # frozen demo snapshots + shared parity fixtures (parity/)
├── backend/
│   ├── Cargo.toml · rust-toolchain.toml
│   ├── migrations/       # 0001_init.sql — the whole schema, applied at startup
│   └── src/
│       ├── main.rs       # Axum router, handlers, auth gates, integration tests
│       ├── config.rs     # env-driven AppConfig (no unwraps)
│       ├── errors.rs     # thiserror + IntoResponse, structured errors only
│       ├── auth.rs       # identity primitives (argon2, session tokens, roles)
│       ├── social.rs     # Google + Telegram sign-in (OIDC verification)
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
- **Social sign-in**: Google and Telegram identities link to an account through
  `auth_identities`; a Telegram account may have neither email nor password. Both are
  behind feature flags and fail closed when the deployment has no credentials.
- **Recovery**: `POST /api/auth/recover` issues a hashed single-use token (mailed as
  both a link and a 6-digit code); `POST /api/auth/reset` consumes it. Email
  confirmation is soft — a banner nudges, nothing blocks.
- **Two-tier enforcement**: a registered player id requires `Authorization: Bearer
  <token>` on player-scoped endpoints; anonymous ids are credentialed by device
  possession (`X-Player-Id`, sent automatically by `frontend/lib/identity.ts`).

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

When a genuinely shared concern appears (e.g. `packages/contract` for API types), create
`packages/<name>/`, add it to the root `workspaces` array, and keep it framework-agnostic.
Do **not** create packages "just in case".
