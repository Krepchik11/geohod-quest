# P4 Handoff — Real PWA (offline bundle, fact queue, live collection)

Handoff document for the next Claude Code agent. Read this fully before writing code.
Date of handoff: 2026-06-11. Phases P1–P3 are complete and archived.

---

## 1. Project context

**GeoQuest** — marketplace of city quests + offline-capable PWA quest player + internal-only
quest constructor. Monorepo at `platform/`: Rust (Axum) backend + Next.js 16 / React 19
frontend (App Router, RSC-first).

**Sources of truth (read in this order):**

| Artifact | Role |
|---|---|
| `design/uploads/CONCEPT.md` | Product boundaries + model. 7 page templates over one GameStep. |
| `design/uploads/SPEC.md` | Exact shapes, contracts, invariants. **Wins over code on conflict.** |
| `design/uploads/PLAN.md` | Implementation sequence + cuts. |
| `design/` (player/, commerce/, ctor/, pwa/, myquests/ + HTML canvases) | Pixel truth for UX/UI. Reference JSX/CSS. |
| `agents/rust.md`, `agents/react.md` | Code-quality rules. Follow to the letter. |

**Precedence rule:** design files > SPEC > CONCEPT for UI; SPEC > design for data shapes and
invariants. Conflicts are resolved by editing the losing artifact, never silently.

**Non-negotiable invariants (SPEC):**
- Balance is a plain signed fold of facts and **may be negative**. No compensation facts, no
  insufficient-funds UI, hint purchase never blocked by balance.
- Facts are immutable, append-only, idempotent by a **device-agnostic** natural key
  `(type, step_position, submitted_value, coins_delta, note)`.
- Completion bonus +5: once per (player, quest), EVER. Enforced server-side
  (`bonus_awards` PK), client only guards locally.
- Grant → attempt → facts chain. Attempt binds the latest published snapshot at creation,
  forever (version freeze).
- Sync corrections are exactly two **client-derived** notices (no stored correction facts):
  «Баланс обновлён» (old → new) and the attempt-advance offer. Both come ONLY from
  `deriveSyncCorrections(localProjection, authoritativeProjection)` in
  `frontend/lib/shared-model.ts`.
- Client fold == server fold, exactly. Enforced mechanically: shared fixtures in
  `platform/goldens/parity/*.json` are executed by BOTH `cargo test`
  (`backend/src/facts.rs::parity_fixtures_project_identically`) and vitest
  (`frontend/lib/__tests__/parity.test.ts`). Never duplicate expected values; edit the
  fixture and both suites flip together.
- Offline never blocks play. Client validates answers locally (shared `isAnswerCorrect`,
  verbatim from `design/player/matcher.js`); server records claims, never re-validates.

**Locked owner decisions (do not re-ask):** PostgreSQL + sqlx (in-memory fallback for
dev/tests); payment provider = stub behind interface until P5; Telegram auth in P5;
pre-auth identity = client device UUID in `localStorage['geohod-device-id:v1']`, linked to
tg_id at P5; constructor media = local FS behind a storage trait (future phase). Container
runtime is **podman**, not docker (compose images must be fully qualified,
e.g. `docker.io/library/postgres:17-alpine`).

---

## 2. Current state (after P1–P3)

### Backend (`platform/backend`, Rust 1.96, edition 2024)

- `src/facts.rs` — `Fact` struct + `FactKind` enum (8 kinds incl. `completion_bonus`,
  serde tag `"type"` snake_case, wire-identical to TS). Pure projectors
  `project_balance` / `project_state` / `project_analytics` / `project_version_stats`.
  Parity fixture test lives here.
- `src/store.rs` — in-memory stores + **enum dispatch** `FactStores` / `GrantStores`
  (`InMemory | Postgres`), async API. In-memory impl is the executable specification for SQL.
- `src/pg_store.rs` — Postgres impls (sqlx, runtime-checked queries — no `query!` macros,
  so the crate builds without a DB). Idempotency enforced by DB constraints:
  `facts UNIQUE(attempt_id, natural_key)`, `bonus_awards PK(player_id, quest_id)`.
  Snapshots stored frozen as JSONB (same id + different content → 400).
- `src/main.rs` — routes + handlers + tests. 14 shared scenario functions run against the
  in-memory backend (per-test) AND live Postgres (`pg_full_suite`, self-skips without
  `DATABASE_URL`). Startup: `DATABASE_URL` set → Postgres (migrations auto-run via
  `sqlx::migrate!`), unset → in-memory with a warning. Demo quest seeded at boot
  (golden embedded via `include_str!`).
- `migrations/0001_init.sql` — full schema.

**API surface (all under `http://localhost:8080` by default):**

| Method/path | Behavior |
|---|---|
| `GET /health` | `{status, version}` |
| `POST /api/checkout` | `{player_id, quest_id, coupon_percent?}` → idempotent lifetime grant (100 → CouponRedemption) |
| `POST /api/quests/publish` | meta + optional `snapshot_id` + optional full `snapshot` JSON (frozen per version) |
| `GET /api/quests` | published list (incl. `snapshot_id`) |
| `GET /api/quests/{id}/bundle?player_id=…` | **bundle primitive**: latest frozen snapshot JSON; 403 without grant, 404 unpublished |
| `POST /api/attempts` | `{player_id, quest_id}` → 403 no grant / 404 unpublished / `AttemptMeta` (binds latest snapshot) |
| `POST /api/attempts/{id}/facts` | `{facts: Fact[]}` → `{accepted, projected, snapshot_id, fact_count}`; 404 unknown attempt. NO corrections field. |
| `GET /api/attempts/{id}/state` | same shape, accepted empty; 404 unknown |
| `GET /api/admin/versions/{snap}/stats` · `/feedbacks` | per-version analytics |
| `POST /api/migrate/legacy` · `GET /api/measure/rates` | phase-4(product) stubs |

### Frontend (`platform/frontend`, Next.js 16.2, React 19, Tailwind 4 + ported design CSS)

- `lib/shared-model.ts` — types (`Fact`, `GameStep` 7-template union, `ProjectedState`,
  `SyncCorrections`…), pure fns (`isAnswerCorrect`, `projectBalance`, `projectState`,
  `deriveSyncCorrections`, `validateForPublish`, `serializeToSnapshot`, grants helpers).
- `lib/api.ts` — typed client (`createAttempt`, `appendFacts`, `getBundle`,
  `listQuests/Grants`, admin). `NEXT_PUBLIC_API_URL` env, default `http://localhost:8080`.
- `lib/__tests__/` — vitest: parity fixtures, model unit tests, player replay sim.
- `app/styles/` — design CSS ported **verbatim-adapted, file-per-design-source**:
  `player-paper.css` (← `design/player/theme.css`, paper art only, all keyframes,
  `[data-anims="off"]` + reduced-motion gating), `commerce.css`, `myquests.css`,
  `admin-ctor.css`, `pwa-sync.css` (← `design/pwa/pwa.css`). To review fidelity, diff
  against the design source. Imported from `app/layout.tsx`.
- `app/player/PlayerComponents.tsx` — typed design components: `PlayerFrame` (360×740),
  `TopBar`, `StepView` (all 7 templates, FinalB), `MenuOverlay` (with «Синхронизация»
  entry), `SyncBanner` (3 states, exact RU copy, `.cnt` badge), `SyncSheet` (queue rows +
  ждёт/отправлено chips), `BalanceCorrectionPopup`, `AdvanceOfferPopup`, `HintPopup`,
  `FeedbackSheet`, `CoinToast`.
- `app/quest/QuestPlayerClient.tsx` — player runtime. Reducer holds `facts` (append-only),
  `stepIdx`, `corrections: SyncCorrections|null`, `syncedKeys: string[]` (natural-key
  strings of server-accepted facts — the **approximation P4 replaces**). Persists to
  `localStorage['quest-player-{goldenId}']` (the other thing P4 replaces). Sync:
  `ensureAttempt()` (checkout-then-create-attempt fallback, player `'demo-player'`) →
  `api.appendFacts` → diff projections → popups. Completion bonus emitted on terminal entry
  with a local once-guard. Device UUID via `localStorage['geohod-device-id:v1']`.
- Pages on designed structure: `/` (market demo), `/quest-detail` (entry card
  paid/free/owned), `/commerce` (checkout with coupon states + 0 ₽ path, success/fail),
  `/my-quests` (**design-fixture DEMO rows — P4 wires them live**), `/profile` (tiles fold
  local facts), `/constructor` (7-template picker with live mini-previews, versions panel,
  publish checklist + modal), `/review/visual-control` (visual regression fixture),
  `/auth` (TG stub), `/cabinet`, `/admin/stats`.
- eslint: **0 errors is the standard now** — keep it that way (`npm run lint` must pass).

### Goldens (`platform/goldens/`)

`parity/*.json` (5 fixtures incl. negative balance −7, bonus, multi-device union),
`golden-mystery-fortress-v1.json` (canonical 7-template snapshot, also embedded in backend
seed), `playthrough-happy-with-gift.json`, `README.md` (fixture format contract).

### Workflow (mandatory)

OpenSpec spec-driven changes. For P4:
1. `openspec new change "pwa-offline"` (from `platform/`), then write `proposal.md`,
   `specs/<capability>/spec.md` (delta format: `## ADDED/MODIFIED/REMOVED Requirements`,
   scenarios with `####` + WHEN/THEN), `design.md`, `tasks.md` (checkboxes `- [ ] N.N`).
   Or use the `/openspec-propose` skill. Check `openspec status --change pwa-offline`.
2. Implement task-by-task, tick checkboxes, TDD where it bites (queue logic, SW caching
   decisions, projection wiring).
3. Gates green (see §5), then `openspec archive pwa-offline --yes` (syncs delta specs into
   `openspec/specs/`).

Existing specs live in `platform/openspec/specs/` (`facts-sync`, `parity-goldens`,
`persistence`, `design-fidelity`, `quest-player-pwa`, …). Archived changes with full
proposals/designs: `platform/openspec/changes/archive/2026-06-11-*`.

---

## 3. P4 scope — WHAT and WHY

Goal: turn the simulated offline player into a real installable offline PWA, and replace
demo data with live state. SPEC: *"Full offline PWA: downloadable bundle contains everything
needed to play; progress recorded as local facts and synced when online. Offline never
blocks play."*

### 3.1 Web App Manifest + installability
- `app/manifest.ts` (Next.js metadata route) — name «GEOHOD QUEST», `display: standalone`,
  theme/background from the site system (`#3B71FE` / `#fff`), icons (generate from
  `public/assets/icons/logo-mark--navy.svg`; need 192/512 PNG — render or hand-convert).
- Why: install-to-homescreen is the delivery model for street play.

### 3.2 Service worker — app shell + bundle cache
- No heavy framework needed. Two options, decide in design.md:
  (a) hand-written `public/sw.js` + manual registration component;
  (b) `serwist` (maintained next-pwa successor) if it earns its keep.
  Recommendation: **hand-written** — caching policy here is domain logic (quest bundles),
  generic precache solves the wrong problem, and next dev-mode SW integration is simpler to
  reason about by hand. Register only in production build (`next dev` + SW = pain).
- Cache strategy:
  - App shell (`/quest` route assets, styles, fonts): stale-while-revalidate.
  - **Quest bundle**: explicit, user-triggered download («скачать для офлайна» in
    my-quests / start gate). Fetch `GET /api/quests/{id}/bundle?player_id=…`, store
    snapshot JSON in IndexedDB (NOT the SW cache — it's data, not assets), pre-cache
    referenced media into a named Cache (`quest-bundle-{snapshot_id}`) — media refs are
    currently null/demo paths, so cache what exists (`/assets/img/quest-card.png`) and
    structure the code for real media refs later.
  - API `POST`s never cached; sync handled by the queue, not SW background-sync (keep v1
    simple: flush on `online` event + on app start + manual button; document Background
    Sync API as a later enhancement).
- Why bundle-in-IndexedDB: player must boot the quest with zero network; snapshot versions
  are immutable so cache invalidation is trivial (keyed by `snapshot_id`).

### 3.3 IndexedDB fact queue (replaces localStorage + `syncedKeys` approximation)
This is the core of P4. Design it first.

- New module `frontend/lib/queue.ts` (pure-ish, testable; use `idb` npm wrapper — tiny,
  typed). Schema (one DB `geohod`, version 1):
  - `attempts` store: `{attempt_key, quest_id, snapshot_id, server_attempt_id?, created_at}`
    — `attempt_key` is a client-generated UUID so attempts can start fully offline;
    `server_attempt_id` filled on first successful online registration
    (grant + `POST /api/attempts`).
  - `facts` store: `{key: factNaturalKey, attempt_key, fact: Fact, status: 'pending'|'sent',
    queued_at}` — keyPath `[attempt_key, key]`. Status flips to `sent` when the server
    accepts OR reports it as duplicate (a successful `POST` response means every fact in
    the batch is on the server — current client logic already encodes this; keep it).
  - `bundles` store: `{snapshot_id, quest_id, version, snapshot}` (frozen JSON).
- Player integration (`QuestPlayerClient.tsx`):
  - Reducer stays the source of UI truth; queue is the persistence layer. On every
    `append`, write-through to IndexedDB. On mount, hydrate facts + position from the
    queue (migrate any existing `localStorage['quest-player-*']` data once, then delete it
    — version the migration like the localStorage pattern in `agents/react.md` §4.4).
  - `SyncSheet`'s `isSent` reads queue status instead of the `syncedKeys` array; remove
    `syncedKeys` from the reducer.
  - Sync flow: collect `pending` facts → `ensureAttempt` (replace the `demo-` prefix hack:
    attempt identity comes from the `attempts` store) → `POST` → mark batch `sent` →
    derive corrections (existing code path; don't touch `deriveSyncCorrections`).
  - Flush triggers: `window 'online'` event, app start, the existing manual button.
    The `simOffline` toggle should now ALSO gate flush triggers, so the PWA sim screens in
    `design/PWA-синк.html` remain reproducible.
- Why IndexedDB: localStorage is synchronous, size-limited, string-only; the fact log +
  bundles outgrow it, and SW/page both need access.

### 3.4 Live My Quests + start gate + download UX
- Replace `DEMO_QUESTS` in `app/my-quests/page.tsx` with real rows composed from:
  `api.listQuests()` (published) × `api.listGrants()` (owned, filter `demo-player`) ×
  local queue (`attempts` + projected facts → state new/progress/done, step N of M from
  the bundle's step count) × `bundles` store (download state: «✓ скачан · size» vs
  «скачать для офлайна»). Fall back to the design demo rows only when the backend is
  unreachable (label them clearly).
- «Скачать для офлайна» button → bundle download flow with the designed 3 states
  (progress `.dl-bar`, ready `.dl-ready`, update available `.mq-version` — classes already
  ported in `app/styles/myquests.css`). Update state: compare bundle store snapshot_id vs
  `listQuests().snapshot_id` — newer published version ⇒ banner «Вышла версия N…»
  (new attempts need it; current attempt continues on its version).
- Start gate (SPEC «Start gate»): when opening a quest that has an in-progress attempt,
  show cover + attempt facts + [Продолжить попытку]/[Начать заново] (＋ «монеты останутся»
  note). Classes `.sg-*` already ported.
- Player must load the snapshot from the bundles store when present (today it loads the
  golden via `lib/goldens.ts`); golden stays as the dev fallback.

### 3.5 Explicitly OUT of P4 scope
- Real media assets in bundles / media storage backend (later phase; structure code for it).
- Telegram auth, payments (P5). Keep `'demo-player'` identity.
- Web Push, Background Sync API (document as enhancements).
- Multi-quest support beyond making the code quest-id-parametric (single demo quest data is
  fine; no hardcoding NEW quest ids).

### 3.6 Conceptual tests to cover (from SPEC «Conceptual Tests»)
- Queue: enqueue offline → flush on reconnect → idempotent re-flush (no double-send
  side effects); long queue replay; reset keeps coins (reset clears attempt facts locally
  but coin facts already synced remain server-side — verify the projection flow).
- Bundle: download → kill network (simulate) → full playthrough from IndexedDB; version
  freeze (old attempt keeps old snapshot while a newer bundle exists).
- Migration: existing localStorage save hydrates into the queue exactly once.
- Vitest for `lib/queue.ts` (use `fake-indexeddb` dev-dep) + extend the replay test.
- E2E by hand at minimum: build, `npm start`, Chrome DevTools → offline, play.

---

## 4. HOW — suggested task order

1. OpenSpec change `pwa-offline` (proposal/spec/design/tasks) — capability suggestion:
   new `pwa-offline`, modify `quest-player-pwa`.
2. `lib/queue.ts` + vitest (fake-indexeddb). TDD this.
3. Player integration (hydrate, write-through, sync from queue, drop `syncedKeys`,
   localStorage migration).
4. Bundle download flow (`bundles` store + UI states) + player loads snapshot from bundle.
5. My-quests live rows + start gate.
6. Manifest + icons + SW (app shell) + registration component + offline E2E pass.
7. Gates + archive + update the memory file is the orchestrator's job — instead, END your
   final report with: what shipped, deviations from this handoff, debt created, and the
   recommended P5 cut.

Quality bar: TDD, SOLID/DRY/KISS/YAGNI, no `any`, no eslint errors, doc comments on public
Rust items, no unwrap in prod paths (backend untouched in P4 unless a real gap appears —
if one does, follow the in-memory-is-the-spec pattern and extend `pg_full_suite`).

---

## 5. Commands — run the project locally

```bash
cd platform

# One-time
npm install                                  # root + frontend workspace
podman compose up -d                         # Postgres 17 (podman, image fully qualified)
cp backend/.env.example backend/.env         # DATABASE_URL=postgres://geohod:geohod@localhost:5432/geohod

# Dev (both, concurrently; backend :8080, frontend :3000)
npm run dev
# or separately:
npm run dev:backend                          # cd backend && cargo run (reads backend/.env)
npm run dev:frontend                         # next dev on :3000
# custom ports:
#   PORT=8087 npm run dev:backend
#   NEXT_PUBLIC_API_URL=http://localhost:8087 npm run dev:frontend

# Without Postgres: just unset DATABASE_URL (no backend/.env) — in-memory, non-durable.

# Tests / gates (ALL must be green before archive)
npm test                                     # cargo test (36) + vitest (26)
cd backend && cargo fmt -- --check && cargo clippy --all-targets -- -D warnings
cd backend && DATABASE_URL=postgres://geohod:geohod@localhost:5432/geohod \
  cargo test pg_full_suite                   # live-Postgres suite (self-skips without env)
cd frontend && npm run lint                  # 0 errors required
npm run build                                # next build

# Production-mode frontend (needed to test the service worker)
cd frontend && npm run build && npm start    # :3000

# Useful URLs
# http://localhost:3000/quest?golden=mystery-fortress-v1   player
# http://localhost:3000/my-quests   /profile   /commerce   /constructor
# http://localhost:3000/review/visual-control              visual regression fixture
# http://localhost:8080/api/quests                          published list (seeded golden)
```

Smoke the API chain by hand:

```bash
curl -s -X POST localhost:8080/api/checkout -H 'content-type: application/json' \
  -d '{"player_id":"demo-player","quest_id":"mystery-fortress-v1"}'
curl -s -X POST localhost:8080/api/attempts -H 'content-type: application/json' \
  -d '{"player_id":"demo-player","quest_id":"mystery-fortress-v1"}'
curl -s "localhost:8080/api/quests/mystery-fortress-v1/bundle?player_id=demo-player" | head -c 300
```

---

## 6. After P4 — the road ahead

- **P5 — auth + commerce real**: Telegram Login Widget + server-side hash verification +
  sessions; identity-link device-UUID → tg_id (facts/grants survive); payment provider
  behind the existing stub interface (YooKassa is the candidate; redirect + webhook →
  grant); coupons become real backend entities (today: frontend demo registry
  GEO50/GEOFREE in `app/commerce/page.tsx`).
- **P6 — admin polish + migration + measurement**: per-step stats UI from
  `/api/admin/versions/*`, read-only feedback lists, one-time legacy Bubble import
  (synthesis helpers already in `backend/src/facts.rs`), real bundle-size measurement once
  media lands, YAML import/export in ctor.
- Known debt registry: media storage (local FS behind trait — decided), sqlx compile-time
  checking via `cargo sqlx prepare` once schema stabilizes, N+1 in version-stats loading,
  `eslint` warnings (no-img-element etc.) tolerated but not added to, my-quests demo
  fallback rows, ctor versions panel seeded with demo history.
