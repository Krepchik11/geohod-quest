# GeoQuest frontend (Next.js 16 · React 19)

The marketplace, the offline-capable PWA quest player, and the internal quest
constructor. App Router, RSC-first; client components only where interactivity or
local persistence demands them.

> **Read [`AGENTS.md`](./AGENTS.md) first.** This is Next.js 16 — APIs and
> conventions differ from older versions. Check `node_modules/next/dist/docs/`
> before using a Next API you're unsure about.

## Commands

```bash
npm run dev            # dev server (http://localhost:3000)
npm run build          # production build
npm test               # vitest run (the pure model + projector suite)
npm run lint           # eslint (next config)
npm run lint:ds        # no deprecated design-system class
npm run lint:css-scope # no route renders a class whose stylesheet it doesn't load
```

The backend base URL is `NEXT_PUBLIC_API_URL` (inlined into the bundle at build
time; falls back to `http://localhost:8080` only in dev — a production build with
it unset throws, see `lib/api.ts`).

`NEXT_PUBLIC_SITE_URL` is this deployment's own address (`https://app.quest.geohod.ru`).
Unlike the API base it never fails a build: without it the app works exactly the
same, it just cannot hand a crawler or a chat preview an absolute link, so the
sitemap comes back empty and `robots.txt` omits its `Sitemap:` line rather than
pointing at a guessed host (`lib/site.ts`).

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
  components/         shared UI: ui.tsx (Button/Input/Toggle), Toaster, TabBar, SiteFooter,
                      QuestCard, PurchaseSheet, InstallQuestButton (+useInstall),
                      useDialog.ts (Escape + focus for every overlay)
  SiteHeader.tsx      role-aware nav
  error.tsx not-found.tsx   the two pages Next would otherwise serve in English
  sitemap.ts robots.ts      what a crawler may find
  quest/share-metadata.ts   the <head> of one quest (title, blurb, cover, manifest)
lib/
  shared-model.ts     wire types + pure projectors (projectState/projectBalance) — MUST match the Rust fold
  constructor-model.ts editor model + publish gates
  snapshot.ts         the ONE reader of a published snapshot (chips, start point, colours)
  quest-theme.ts      the quest's three author-set colours → the player's full palette
  cover.ts            cover ref → renderable URL, and the letter shown when there is none
  storefront.ts       product-page/marketplace presentation model
  pwa.ts              per-quest install/manifest logic
  install.ts          install-affordance state machine (installable/ios/hidden)
  queue.ts            IndexedDB fact queue (offline append-only log + bundles)
  sync.ts             flush controller (single-flight, attempt registration)
  identity.ts         anonymous-first device id + session (who is playing)
  api.ts              the single API client (attaches identity, normalizes errors)
  roles.ts            capability predicates (admin ⊃ editor ⊃ player)
  site.ts             this deployment's own address (optional; degrades, never throws)
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
- **Quest colours** (`lib/quest-theme.ts`): an author picks three — background, text,
  button — and `themeVars` derives the player's whole `--p-*` palette from them,
  including the tones that must stay readable on a background the author chose. The
  paper defaults in `app/styles/player-paper.css` are a transcript of
  `themeVars(PAPER_THEME)`, held to it by test, so there is one derivation and a
  quest with no colours renders exactly like one whose colours are the paper palette.
  The colours freeze into the snapshot at publish, so a started attempt never
  repaints, and the page shell is themed server-side so nothing flashes.
- **Parity**: the projectors in `lib/shared-model.ts` mirror the Rust backend fold
  exactly. The shared fixtures in `../goldens/parity/` are executed by both this
  suite (`lib/__tests__/parity.test.ts`) and the backend's — one-sided drift fails a
  suite.
- **Stylesheets belong to a route, not to everybody.** The root layout imports
  only what every visitor renders (`globals.css` plus commerce/store/my-quests);
  the admin desk, the constructor and the player paper are imported by the layout
  of the subtree that owns them. That is ~50% of the CSS a public page used to
  download. `npm run lint:css-scope` builds the import graph, works out what each
  route actually renders, and fails if a class appears on a route whose
  stylesheet is not loaded there — the one silent failure this split allows.
- **Overlays** (`app/components/useDialog.ts`): Escape closes, focus enters on
  open, Tab cycles inside, focus returns to whatever opened it. One rule for
  every sheet, dialog and confirm — the alternative is twelve of them each
  deciding separately, which is how eleven ended up without Escape.
- **Share cards** (`app/quest/share-metadata.ts` + `lib/storefront.ts`
  `shareCard`): a quest link carries that quest's title, blurb and cover. Facts
  only — city and duration appear when the author filled them in — and the cover
  is made absolute against the API origin, because a relative one would resolve
  against the site, which serves no media.

See [`../README.md`](../README.md) for the monorepo and
[`../DEPLOYMENT.md`](../DEPLOYMENT.md) for how it ships.
