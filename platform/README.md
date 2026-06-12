# GeoQuest Platform (monorepo)

Clean, minimal source tree containing **only** the production project files for the GeoQuest quest platform.

- **backend/** — Rust 1.96 + Axum 0.8 HTTP API (facts, snapshots, grants, bundles later)
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
  - [agents/rust.md](../../agents/rust.md) (no `.unwrap()` in prod paths, `thiserror` + `anyhow`, tracing not println, doc comments, `cargo fmt` + `clippy -D warnings`, tests, 4-space, meaningful names, etc.)
  - [agents/react.md](../../agents/react.md) (eliminate waterfalls at the source, RSC composition, module-level hoisting where appropriate, avoid barrel abuse, narrow effects, explicit conditionals, etc.)
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

- Backend surfaces: facts/attempts/state, publish/bundle (frozen snapshots), checkout/grants (mock `PaymentProvider`), admin per-version stats/feedbacks, legacy migration, and identity (`/api/auth/register`, `/api/auth/login`, `/api/players/me`, `/api/players/me/stats`).
- Frontend: live marketplace (landing `#shop` — all published quests, per-quest buy with mocked payment, owned state), design player (7 templates, paper frame, offline PWA queue + bundles), constructor with publish, my-quests collection, live profile stats, email auth page.
- Shared contracts (OpenAPI / TS types / generated client) will appear under `packages/` only when the first cross-boundary API is designed. Not before.

## Identity model (player-identity spec)

- **Anonymous-first**: the browser mints a device UUID once (`localStorage['geohod-device-id:v1']`); the player id is `dev:<uuid>`. No registration needed to buy or play; identity exists before any network (offline-first).
- **Email registration** (`POST /api/auth/register`): attaches email + argon2 password hash to the SAME player id — purchases/coins/facts survive with zero migration. No email confirmation (MVP cut). Login (`POST /api/auth/login`) returns the account id + opaque session token; that device adopts the account.
- **Two-tier enforcement**: a REGISTERED player id requires `Authorization: Bearer <token>` on player-scoped endpoints (checkout, attempts, bundle, profile/stats); anonymous ids are credentialed by device possession (`X-Player-Id` header — the client sends the right one automatically via `frontend/lib/identity.ts`).
- **Payments**: `backend/src/payments.rs` — `PaymentProvider` trait with an always-approving `MockPaymentProvider`; the mock `payment_ref` is audited on the grant (`source_ref`). Real provider (YooKassa redirect + webhook) slots in behind the same trait.
- Recorded MVP cuts: no email confirmation/password reset/rate limiting/token expiry; login does not merge a device's local anonymous progress into the account.
- E2E: `node e2e-identity.mjs` (servers on :8080/:3000) covers anonymous buy → play → register → cross-device login → enforcement; `node e2e-player-check.mjs` covers the production player (access gate, all 7 templates on «Ирония судьбы», 2nd-wrong hint popup, real offline banner, no debug chrome).

See `../blueprint/TECH.md`, `../blueprint/SPEC.md`, `../blueprint/PLAN.md`, and `../blueprint/CONCEPT.md` for the non-negotiable model (event-sourced facts, client-validated snapshots, frozen supporting values, 4 templates, etc.). Historical supporting material (including prior business docs and analyses) is archived in `../old-knowledgebase/`.

## Project layout (current)

```
platform/
├── .gitignore
├── package.json          # npm workspaces root + orchestration scripts
├── README.md
├── backend/
│   ├── Cargo.toml
│   ├── rust-toolchain.toml
│   └── src/
│       ├── main.rs       # Axum server, router, health, graceful shutdown, tests
│       ├── config.rs     # env-driven AppConfig (no unwraps)
│       └── errors.rs     # thiserror + IntoResponse, structured errors only
└── frontend/
    ├── app/
    │   ├── layout.tsx    # RSC root, Geist fonts (hoisted), lang=ru, metadata
    │   └── page.tsx      # Pure RSC landing reflecting 3 components
    ├── next.config.ts
    └── ...
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

## Verification performed at creation time

- `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test` — all green.
- `npm run build` (frontend) — clean static generation, TypeScript happy.
- All edits passed adversarial review against the two agent guideline files + KISS/YAGNI (no DB, no over-extracted crates, no client components on landing, no barrel imports introduced, etc.).

## License / contribution

Internal project. Follow the style and quality gates above on every change.

---

Questions or model drift? Start with the blueprints in `../blueprint/` (CONCEPT, PLAN, SPEC, TECH). Historical context is in `../old-knowledgebase/`.
