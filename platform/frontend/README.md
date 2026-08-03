# GeoQuest frontend (Next.js 16 · React 19)

The marketplace, the offline-capable PWA quest player, and the internal quest
constructor. App Router, RSC-first; client components only where interactivity or
local persistence demands them.

> **Read [`AGENTS.md`](./AGENTS.md) first.** This is Next.js 16 — APIs and
> conventions differ from older versions. Check `node_modules/next/dist/docs/`
> before using a Next API you're unsure about.

## Commands

```bash
npm run dev        # dev server (http://localhost:3000)
npm run build      # production build
npm test           # vitest run (the pure model + projector suite)
npm run lint       # eslint (next config)
```

The backend base URL is `NEXT_PUBLIC_API_URL` (inlined into the bundle at build
time; falls back to `http://localhost:8080` only in dev — a production build with
it unset throws, see `lib/api.ts`).

## Layout

```
app/
  page.tsx            landing v2 + marketplace (#shop)
  quest/              the production player (offline PWA): BundleGate → StartGate → QuestPlayerClient
    [questId]/about/  public product page (order card, purchase sheet, reviews)
    [questId]/manifest.webmanifest/  quest-scoped PWA manifest (install-per-quest)
  player/             presentational player components (paper frame, step views)
  quest-editor/       the constructor (editor-gated): Workspace → Builder → PageEditor → PublishPanel → StatusControl
  admin/              user/role management (admin-gated, search + pagination)
  auth/ profile/ my-quests/   account + library (email-first auth; auth/reset + auth/confirm)
  privacy/ terms/     legal pages
  components/         shared UI: ui.tsx (Button/Input), Toaster, TabBar, SiteFooter,
                      QuestCard, PurchaseSheet, InstallQuestButton (+useInstall)
  SiteHeader.tsx      role-aware nav
lib/
  shared-model.ts     wire types + pure projectors (projectState/projectBalance) — MUST match the Rust fold
  constructor-model.ts editor model + publish gates
  storefront.ts       product-page/marketplace presentation model
  pwa.ts              per-quest install/manifest logic
  install.ts          install-affordance state machine (installable/ios/hidden)
  queue.ts            IndexedDB fact queue (offline append-only log + bundles)
  sync.ts             flush controller (single-flight, attempt registration)
  identity.ts         anonymous-first device id + session (who is playing)
  api.ts              the single API client (attaches identity, normalizes errors)
  roles.ts            capability predicates (admin ⊃ editor ⊃ player)
```

## How it fits together

- **Identity** (`lib/identity.ts`): the device mints `dev:<uuid>` and plays offline
  with no round-trip. Registration attaches an account to that same id (zero
  migration); a session swaps in the account id. `authHeaders()` sends `Bearer` for
  a session, `X-User-Id` for an anonymous device.
- **Offline play** (`lib/queue.ts` + `lib/sync.ts`): facts append to IndexedDB
  immediately (write-through); `sync.flush*` drains pending facts to the server when
  online, single-flight per attempt. The reducer in `QuestPlayerClient` is the UI
  source of truth; the queue is durable persistence.
- **Parity**: the projectors in `lib/shared-model.ts` mirror the Rust backend fold
  exactly. The shared fixtures in `../goldens/parity/` are executed by both this
  suite (`lib/__tests__/parity.test.ts`) and the backend's — one-sided drift fails a
  suite.

See [`../README.md`](../README.md) for the monorepo and
[`../DEPLOYMENT.md`](../DEPLOYMENT.md) for how it ships.
