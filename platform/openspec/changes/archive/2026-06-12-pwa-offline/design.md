# Design: pwa-offline

## Context

P1–P3 left a player whose offline story is simulated: localStorage persistence keyed by golden id, a `syncedKeys: string[]` in React state approximating server acknowledgement, snapshot always from a build-time golden import, fixture rows in My Quests, no manifest, no service worker. The backend already exposes everything P4 needs (`GET …/bundle`, idempotent `POST …/facts`, grant-gated `POST /api/attempts`) — this change is frontend-only. Identity stays `'demo-player'` + device UUID until P5.

## Goals / Non-Goals

**Goals:**
- Durable IndexedDB fact queue with a per-fact `pending|sent` lifecycle that is the single source of "what has the server seen".
- Attempts born offline (client `attempt_key` UUID), bound to a `server_attempt_id` on first successful registration.
- Explicit bundle download keyed by immutable `snapshot_id`; player boots from the stored bundle with zero network.
- Installable manifest + hand-written SW for the app shell; live My Quests + start gate.
- One-time localStorage migration; `cargo`/vitest/lint/build gates stay green; parity fixtures untouched.

**Non-Goals:**
- Background Sync API, Web Push (documented enhancements; flush = online event + start + manual).
- Real media in bundles (cache what exists; structure for refs later).
- Backend changes, auth, payments (P5). Multi-quest data beyond quest-id-parametric code.

## Decisions

1. **`idb` wrapper, one DB `geohod` v1, three stores.** Raw IndexedDB's event API invites bugs (transactions auto-committing under `await`); `idb` is ~1 KB, typed, and maps 1:1 to the platform API — no framework lock-in.
   - `attempts`: `{attempt_key, quest_id, snapshot_id, server_attempt_id?, created_at, last_step_idx, status: 'active'|'superseded'}`, keyPath `attempt_key`, index `by-quest` on `quest_id`. The *active* attempt for a quest = the single row with `status==='active'` (restart flips the old row to `superseded` and inserts a new one — history is kept, facts are never deleted, so «монеты останутся» holds locally as well as server-side).
   - `facts`: `{attempt_key, key (natural-key string), fact, status: 'pending'|'sent', seq, queued_at}`, keyPath `[attempt_key, key]`, index `by-attempt`. `seq` is a monotonic counter (max+1 at write) because keyPath iteration is lexicographic by natural key — wrong for display order; projections themselves are order-insensitive folds.
   - `bundles`: `{snapshot_id, quest_id, version, snapshot, size_bytes, downloaded_at}`, keyPath `snapshot_id`, index `by-quest`.

2. **Natural-key idempotency applies locally too.** `put` on keyPath `[attempt_key, key]` collapses duplicate natural keys exactly as the server's `UNIQUE(attempt_id, natural_key)` does. Consequence faced head-on: an in-memory session can hold a duplicate (same wrong answer twice) that hydration later collapses — that's *more* correct, not less: the hydrated local projection equals what the server would project, eliminating a class of phantom corrections. A `sent` row is never demoted to `pending` by a re-append of the same key.

3. **Reducer stays UI truth; queue is write-through persistence.** On `append`, fire-and-forget `queue.appendFact(...)` with a caught/logged failure — offline play must never block on storage (quota errors degrade to in-memory play, same as today's localStorage catch). `last_step_idx` is written the same way on advance. Hydration on mount: active attempt → its facts (sorted by `seq`) + `last_step_idx` → one `restore` dispatch.

4. **Sync moves out of the component into `lib/sync.ts`.** `flushPending({questId, api, queue})`: collect `pending` for the active attempt → `ensureRegistered` (reuse `server_attempt_id`; else `POST /api/attempts` with the existing checkout-on-403 fallback, persist id) → `POST` facts → mark batch `sent` → return `{authoritative, localBefore}` for the component to run `deriveSyncCorrections` (which stays untouched in shared-model). Why extract: the flush has real concurrency/identity logic now and must be unit-tested with `fake-indexeddb` + a stubbed api — impossible to do honestly while buried in a 700-line client component.

5. **Single-flight flush mutex.** `'online'` event, app start, and the manual button can fire concurrently; two concurrent `ensureRegistered` calls would create **two server attempts** (POST /api/attempts is not idempotent) and double-register the queue. A module-scoped in-flight promise serializes flushes: callers `await` the existing flush instead of starting a second. Re-flush after completion is safe (server dedups; `sent` rows are skipped).

6. **All flush triggers gate on `simOffline`.** Including the `online` listener and start-flush — otherwise the PWA sim screens (`design/PWA-синк.html`) become unreproducible the moment a real network exists. The toggle's reducer state is the single gate; the listener reads it via a ref to avoid stale closures.

7. **Snapshot resolution is client-side, ordered, suspense-gated.** `page.tsx` stays an RSC shell passing the golden as fallback; a thin client `BundleGate` resolves before first paint of the player: attempt-bound `snapshot_id` from `bundles` → latest bundle for the quest → golden fallback. Rationale: IndexedDB does not exist on the server; swapping snapshots after mount would flash and could re-validate answers against a different version mid-attempt (version-freeze violation). A short loading state is the honest cost.

8. **Hand-written `public/sw.js`, ~100 lines, no serwist.** The only non-trivial policy is domain-specific (immutable bundle media caches named `quest-bundle-{snapshot_id}`); generic precache manifests solve the wrong problem and fight `next dev`. Policy:
   - Navigations + same-origin static assets (`/_next/static`, styles, fonts, `/assets/…`): stale-while-revalidate into a versioned `shell-v{N}` cache; navigation fallback to the cached shell when fetch rejects (offline), `ignoreSearch` for `/quest` so `?golden=`/`?quest=` variants hit the cached shell.
   - Non-GET: never intercepted (queue owns sync). `/api/`: network-only — API data lives in IndexedDB, an SW cache of it would create a second, stale source of truth.
   - `activate` deletes caches not in the current allowlist, *except* `quest-bundle-*` (evicted only by explicit bundle deletion).
   - Registered by a `SwRegister` client component, production-only (`process.env.NODE_ENV`), `next dev` untouched.

9. **Manifest via `app/manifest.ts`** (typed Next metadata route). Icons: 192/512 PNGs rendered once from `logo-mark--navy.svg` and committed (no runtime/image dep added); maskable purpose on the 512.

10. **My Quests stays a client page.** The row model needs `listQuests` × `listGrants` × IndexedDB — the latter is client-only, so RSC-first yields to reality here (KISS; no half-server split that fetches twice). Single `useEffect` orchestration with `Promise.all`, explicit `source: 'live' | 'demo-fallback'` in state; the fallback rows reuse the existing fixtures behind a visible «демо-данные (сервер недоступен)» label. Download flow: `api.getBundle` → `bundles.put` → media pre-cache via `caches.open('quest-bundle-…')` (what exists today: the card image), `.dl-bar` progress is staged (fetch/store/cache) since fetch of one JSON has no meaningful byte progress; size shown from `JSON.stringify(snapshot).length` (honest local measure; real measurement is the P6 item).

11. **Start gate lives in the player as a pre-play overlay.** On hydration, if the active attempt has facts and is not terminal-complete, render the `.sg-*` gate (cover, date, шаг N из M, монеты) over the frame; «Продолжить» dismisses; «Начать заново» calls `queue.restartAttempt(questId)` (supersede + fresh `attempt_key`) and resets the reducer. The legacy `handleReplay` (LS wipe) is replaced — facts are never deleted.

12. **Migration is one mount-time pass, key-deletion as the marker.** If `localStorage['quest-player-{id}']` exists: create/reuse an attempt (preserving a legacy real `attemptId` as `server_attempt_id` when it isn't the `demo-` placeholder), import facts as `pending`, write `last_step_idx`, then `localStorage.removeItem` — IDB writes commit before removal, so a crash mid-migration re-runs it idempotently (puts collapse by natural key). The `syncedKeys` knowledge is deliberately dropped to `pending`: worst case is one redundant idempotent re-send, vs. wrongly trusting stale "sent" state.

## Adversarial review of this design (resolved)

- *Two tabs / installed-app + tab both open?* Both write the same IDB stores; puts are key-idempotent and the flush mutex is per-context, so the worst case is duplicate POSTs — absorbed by server dedup and attempt reuse via `server_attempt_id` persisted before facts post. Cross-context attempt-creation race remains theoretically possible (two contexts, both unregistered, flushing simultaneously) — accepted: 'demo-player' single-user dev reality, and the loser's facts still land on its own valid attempt; revisit with Web Locks if it ever bites.
- *Flush marks `sent` then crashes before corrections show?* Corrections are derived per-flush from projections, not stored — next flush recomputes against the authoritative response. Nothing lost.
- *`online` event fires with captive-portal "connectivity"?* The POST fails, the catch leaves rows `pending`, banner shows retry state. No data loss path.
- *Bundle store grows unboundedly?* v1 has one real quest; eviction UI is YAGNI, but `bundles` rows carry `quest_id` + `downloaded_at` so deletion is a one-liner later, and SW bundle caches are named for targeted `caches.delete`.
- *SWR shell serves stale code after deploy?* Versioned cache name + revalidation on each online visit; acceptable staleness window for v1, documented.

## Risks / Trade-offs

- [IndexedDB quirks across browsers] → `idb` + fake-indexeddb-backed unit tests for all queue paths; manual E2E on Chrome (the install target).
- [Client component grows] → sync/queue logic extracted to `lib/sync.ts`/`lib/queue.ts`; the component only dispatches and renders.
- [Staged (not byte-true) download progress] → honest: three real stages; real sizes arrive with media (P6 measurement item).
- [No RTL component tests] → logic lives in libs and is unit-tested; component wiring covered by replay test + manual offline E2E (build + DevTools offline) per handoff.

## Migration Plan

Additive files + player/my-quests rewiring. User data: localStorage saves import once (Decision 12), then the legacy code path is deleted (`syncedKeys`, LS persist effect). Rollback = revert frontend; server state unaffected.

## Open Questions

(none blocking — media refs and real size measurement are explicitly deferred per handoff §3.5)
