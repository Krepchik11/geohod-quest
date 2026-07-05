# GeoQuest Platform (monorepo)

Clean, minimal source tree containing **only** the production project files for the GeoQuest quest platform.

- **backend/** — Rust 1.96 + Axum 0.8 HTTP API: event-sourced facts, frozen snapshots, access grants, bundles, identity/roles; in-memory or PostgreSQL storage (selected by `DATABASE_URL`)
- **frontend/** — Next.js 16.2 + React 19 (RSC-first, PWA player, marketplace, internal constructor)
- Root orchestration for install, dev, build, test, lint across parts.

**Everything else** (historical analyses, legacy docs, discovery data, old Bubble reverse-engineering) lives in `../old-knowledgebase/`. The primary concepts and development guidance are in `../blueprint/`. This separation keeps the runnable code and active model pristine and reviewable.

## Versions (pinned / latest at init)

- Rust: 1.96.0 (see `backend/rust-toolchain.toml`)
- Next.js: 16.2.9 (React 19)
- Edition: Rust 2024, TypeScript strict + modern Next app dir

## Principles enforced from day one

- TDD, SOLID, DRY, KISS, YAGNI
- Highest readability and maintainability
- Full adherence to:
  - [agents/rust.md](../agents/rust.md) (no `.unwrap()` in prod paths, `thiserror` + `anyhow`, tracing not println, doc comments, `cargo fmt` + `clippy -D warnings`, tests, 4-space, meaningful names, etc.)
  - [agents/react.md](../agents/react.md) (eliminate waterfalls at the source, RSC composition, module-level hoisting where appropriate, avoid barrel abuse, narrow effects, explicit conditionals, etc.)
- Backend: layered (config, errors, router/state), graceful shutdown, timeout + trace + cors middleware, structured logs.
- Frontend: pure RSC by default, no premature client components or global mutable state, small focused pieces.

## Quick start (two terminals recommended for clarity)

```bash
# From platform/ root
npm install          # sets up frontend workspace + concurrently

# Terminal 1 — backend
npm run dev:backend   # or: cd backend && cargo run

# Terminal 2 — frontend
npm run dev:frontend  # or: cd frontend && npm run dev
```

Or try the combined (logs prefixed):

```bash
npm run dev
```

## Common commands (from platform/)

| Command              | What it does                              |
|----------------------|-------------------------------------------|
| `npm run dev`        | Concurrent backend + frontend (dev)       |
| `npm run build`      | Build frontend (prod)                     |
| `npm test`           | Backend tests + frontend lint             |
| `npm run lint`       | Frontend lint + backend clippy -D warnings|
| `npm run fmt:check`  | Rust formatting check                     |
| `cd backend && cargo test` | Direct backend (recommended for iteration) |

After changes to Rust: always run `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test` before commit.

## Architecture notes (initial)

- Backend surfaces: facts/attempts/state, publish/bundle (frozen snapshots), checkout/grants (mock `PaymentProvider`), public product page (`GET /api/quests/{id}` — description, author, chips, ratings, reviews), admin per-version stats/feedbacks + user management (search/pagination/roles), legacy migration, per-quest PWA icons (cover→192/512 PNG), transactional mail (lettre; `SMTP_URL` or log fallback), and identity v2 (`/api/auth/identify|register|login|recover|reset|confirm`, change-password, display-name, delete-account, `/api/players/me`, `/api/players/me/stats`).
- Frontend: live marketplace (landing v2 + `/quest/[id]/about` product page with order card, purchase sheet, reviews), design player (7 templates, paper frame, offline PWA queue + bundles, per-quest manifests), constructor with publish + status chip, my-quests collection, live profile stats, email-first auth (`/auth`, `/auth/reset`, `/auth/confirm`), `/privacy` + `/terms`.
- Shared contracts (OpenAPI / TS types / generated client) will appear under `packages/` only when the first cross-boundary API is designed. Not before.

## Identity model (player-identity spec)

- **Anonymous-first**: the browser mints a device UUID once (`localStorage['geohod-device-id:v1']`); the player id is `dev:<uuid>`. No registration needed to buy or play; identity exists before any network (offline-first).
- **Email-first flow (auth v2)**: `POST /api/auth/identify` (rate-limited) tells the client whether an email is new or known, so the user never picks the wrong mode. Registration attaches email + argon2 password hash to the SAME player id — purchases/coins/facts survive with zero migration. Login (`POST /api/auth/login`) returns the account id + opaque session token; that device adopts the account.
- **Recovery & confirmation (auth v2)**: `POST /api/auth/recover` issues a hashed single-use reset token mailed via `src/mailer.rs` (real SMTP when `SMTP_URL` is set, honest log fallback otherwise); `POST /api/auth/reset` consumes it. Email confirmation is soft (`email_confirmed_at`, migration 0003) — a banner nudges, nothing blocks. Account management: change-password, display-name, delete-account (blocked with 409 while the account has published quests).
- **Two-tier enforcement**: a REGISTERED player id requires `Authorization: Bearer <token>` on player-scoped endpoints (checkout, attempts, bundle, profile/stats); anonymous ids are credentialed by device possession (`X-Player-Id` header — the client sends the right one automatically via `frontend/lib/identity.ts`).
- **Payments**: `backend/src/payments.rs` — `PaymentProvider` trait with an always-approving `MockPaymentProvider`; the mock `payment_ref` is audited on the grant (`source_ref`). Real provider (YooKassa redirect + webhook) slots in behind the same trait.
- Recorded MVP cuts: no token expiry; login does not merge a device's local anonymous progress into the account. (Email confirmation, password reset, and identify rate limiting shipped with auth v2.)
- E2E: `node e2e-identity.mjs` (servers on :8080/:3000) covers anonymous buy → play → register → cross-device login → enforcement; `node e2e-player-check.mjs` covers the production player (access gate, all 7 templates on «Ирония судьбы», 2nd-wrong hint popup, real offline banner, no debug chrome).

See `../blueprint/TECH.md`, `../blueprint/SPEC.md`, `../blueprint/PLAN.md`, and `../blueprint/CONCEPT.md` for the non-negotiable model (event-sourced facts, client-validated snapshots, frozen supporting values, 7 page templates, etc.). Historical supporting material (including prior business docs and analyses) is archived in `../old-knowledgebase/`.

## Project layout (current)

```
platform/
├── package.json          # npm workspaces root + orchestration scripts
├── README.md
├── goldens/              # frozen demo snapshots + shared parity fixtures (parity/)
├── backend/
│   ├── Cargo.toml · rust-toolchain.toml
│   ├── migrations/       # sqlx Postgres migrations (run at startup)
│   └── src/
│       ├── main.rs       # Axum server: router, handlers, auth gates, graceful shutdown, integration tests
│       ├── config.rs     # env-driven AppConfig (no unwraps)
│       ├── errors.rs     # thiserror + IntoResponse, structured errors only
│       ├── auth.rs       # identity primitives (argon2, session tokens, roles)
│       ├── facts.rs      # the event vocabulary + pure deterministic projectors
│       ├── grants.rs     # lifetime access-grant model (idempotent by player+quest)
│       ├── icons.rs      # per-quest PWA icons: cover → maskable 192/512 PNG
│       ├── mailer.rs     # transactional mail (lettre SMTP or log fallback)
│       ├── payments.rs   # PaymentProvider seam (always-approving mock)
│       ├── store.rs      # store dispatch + in-memory backend (the executable spec)
│       └── pg_store.rs   # PostgreSQL backend (mirrors in-memory exactly)
└── frontend/             # see frontend/README.md for its app/ + lib/ layout
```

## Adding future packages (when needed)

When a true shared concern appears (e.g. `packages/contract` for API types or `packages/ui` for player + ctor renderers):

1. Create `packages/<name>/`
2. Add it to root `workspaces` array.
3. Keep it framework-agnostic where possible.
4. Update import paths and build graphs.

Do **not** create packages "just in case".

## OpenSpec / change tracking

OpenSpec is fully integrated and self-contained inside this monorepo:

- `openspec/` (config + changes/)
- `.claude/skills/` and `.claude/commands/opsx/` (the /openspec-apply-change etc. workflow)

The `engine/` tooling that used to live in a sibling directory has been moved here (see change `initial-project-setup`). Legacy documentation and analyses were later archived to `../old-knowledgebase/` to keep `../blueprint/` as the single primary conceptual source.

All future spec-driven work (proposals, design, tasks, apply) should be done from the `platform/` root so that the rich context in `openspec/config.yaml` (monorepo layout, Rust/Next.js details, primary domain from blueprint/, principles) is always in scope.

Current change example: `openspec status --change initial-project-setup`

The authoritative source of truth for *what* to build and the recommended steps to start development is `../blueprint/` (especially PLAN.md). All prior exploratory material has been moved to `../old-knowledgebase/`.

## Quality gates (every change)

- Backend: `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test` — all green.
  The integration suite runs the same scenarios against both storage backends; the
  PostgreSQL pass self-skips without `DATABASE_URL` (see `backend/.env.example`).
- Frontend: `npm test` (vitest), `npm run build`, `npm run lint` — TypeScript strict, clean.
- Every edit is held to the two agent guideline files + KISS/YAGNI: no over-extracted
  crates, no premature client components, no barrel imports.

## License / contribution

Internal project. Follow the style and quality gates above on every change.

---

Questions or model drift? Start with the blueprints in `../blueprint/` (CONCEPT, PLAN, SPEC, TECH). Historical context is in `../old-knowledgebase/`.
