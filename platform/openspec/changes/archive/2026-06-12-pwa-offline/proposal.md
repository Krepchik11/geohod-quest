# Proposal: pwa-offline

## Why

The player is offline-capable only by simulation: progress lives in `localStorage` (synchronous, size-limited, string-only), "synced" status is approximated by a `syncedKeys` array inside React state, the snapshot always comes from a build-time golden import, and My Quests shows design fixture rows. Nothing survives a real network loss on a real street: there is no installable manifest, no service worker, no offline-stored bundle, and no durable fact queue. SPEC promises "Full offline PWA: downloadable bundle contains everything needed to play; progress recorded as local facts and synced when online. Offline never blocks play" — P4 makes that promise real.

## What Changes

- **IndexedDB fact queue** (`frontend/lib/queue.ts`, new): one `geohod` DB with `attempts` / `facts` / `bundles` stores. Facts are queued with `pending|sent` status keyed by the device-agnostic natural key; attempts get a client-generated `attempt_key` UUID so play can start fully offline, with `server_attempt_id` filled on first successful online registration. Replaces `localStorage['quest-player-*']` persistence and the `syncedKeys` reducer approximation (one-time versioned migration, then the legacy key is deleted).
- **Player integration**: reducer stays UI truth; queue becomes the persistence layer (write-through on append, hydrate on mount). Sync flow collects `pending` facts from the queue, resolves attempt identity from the `attempts` store (drops the `demo-` prefix hack), marks the batch `sent` on success, and derives corrections via the existing untouched `deriveSyncCorrections` path. Flush triggers: `window 'online'` event, app start, manual button — all gated by the existing `simOffline` toggle so design sim screens stay reproducible.
- **Offline bundle**: explicit user-triggered download stores the frozen snapshot JSON in the `bundles` store (keyed by immutable `snapshot_id`); referenced media pre-cached into a named SW Cache. The player loads the snapshot from the bundle store when present; goldens remain the dev fallback.
- **Live My Quests + start gate**: real rows composed from `listQuests()` × `listGrants()` × local queue (attempt state, step N of M) × `bundles` store (download state), with the designed download states (progress / ready / update-available) and the SPEC start gate (continue / restart with «монеты останутся»). Design demo rows only as a clearly-labeled fallback when the backend is unreachable.
- **Installability**: `app/manifest.ts` (name «GEOHOD QUEST», standalone, 192/512 icons from the navy logo mark) + hand-written `public/sw.js` (app shell stale-while-revalidate; `POST`s never cached) registered only in production builds.
- Out of scope (unchanged decisions): real media assets, Telegram auth/payments (P5), Web Push and Background Sync API (documented enhancements), multi-quest data beyond quest-id-parametric code.

## Capabilities

### New Capabilities

- `pwa-offline`: real offline operation — installable manifest + service worker app shell, IndexedDB fact queue with pending/sent lifecycle and offline-born attempts, bundle download/storage keyed by immutable snapshot_id, offline boot from the stored bundle, flush triggers, one-time localStorage migration, live My Quests collection with download states and the start gate.

### Modified Capabilities

- `quest-player-pwa`: the persistence requirement changes — local facts and resume position SHALL persist in the IndexedDB queue (not localStorage), sync-sheet sent/pending chips SHALL read queue status (not an in-memory key list), the player SHALL load its snapshot from the stored bundle when present, and attempt identity SHALL come from the local attempts store. Projection fidelity, corrections derivation, hint/popup/eligibility behavior are unchanged.

## Impact

- Frontend only (backend untouched; the bundle endpoint already exists): new `lib/queue.ts`, `app/manifest.ts`, `public/sw.js`, SW registration component, icon assets; modified `app/quest/QuestPlayerClient.tsx`, `app/quest/page.tsx` (bundle-aware snapshot source), `app/my-quests/page.tsx` (live rows + start gate + download flow), `lib/api.ts` (no change expected — `getBundle` exists).
- Dependencies: + `idb` (tiny typed IndexedDB wrapper), + `fake-indexeddb` (dev, vitest).
- Tests: new `lib/__tests__/queue.test.ts` (TDD), extended player replay test, manual offline E2E (production build, DevTools offline).
