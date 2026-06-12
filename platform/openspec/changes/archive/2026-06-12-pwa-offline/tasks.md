# Tasks: pwa-offline

## 1. Queue library (TDD)

- [x] 1.1 Add `idb` dep + `fake-indexeddb` devDep; write failing `lib/__tests__/queue.test.ts` covering: appendFact write-through + natural-key collapse, hydrate (seq order + last_step_idx), markSent batch, sent-never-demoted, active attempt per quest, restartAttempt (supersede, facts kept), bundles put/get/latest-by-quest, one-time localStorage migration (legacy real attemptId preserved, key deleted, idempotent re-run)
- [x] 1.2 Implement `lib/queue.ts` (DB `geohod` v1: attempts/facts/bundles per design Decisions 1–2, 12) until green; verify `cd frontend && npm test`

## 2. Sync controller (TDD)

- [x] 2.1 Failing tests for `lib/sync.ts`: flushPending happy path (pending→POST→sent + authoritative returned), ensureRegistered reuses server_attempt_id / registers once with checkout-on-403 fallback, single-flight mutex (concurrent calls → one attempt, one POST), failed POST leaves pending, empty queue no-ops
- [x] 2.2 Implement `lib/sync.ts` until green (api injected for stubbing)

## 3. Player integration

- [x] 3.1 `QuestPlayerClient`: hydrate from queue on mount (one restore dispatch), write-through on append/advance, remove `syncedKeys` + LS persist/load effects, run LS migration before hydration
- [x] 3.2 Wire flush triggers (`online` listener via simOffline ref, app start, manual button) through `lib/sync.ts`; corrections still via `deriveSyncCorrections` diff; SyncSheet/Menu pending counts read queue status
- [x] 3.3 Start gate overlay (`.sg-*`): show on hydrated in-progress attempt; «Продолжить» dismisses, «Начать заново» → `restartAttempt` + reducer reset (no fact deletion); extend `lib/__tests__/player-replay.test.ts` for queue-backed replay + reset-keeps-coins
- [x] 3.4 `BundleGate` client wrapper + `page.tsx`: snapshot resolution attempt-bound bundle → latest bundle → golden fallback (loading state, no post-mount swap)

## 4. Bundle download + live My Quests

- [x] 4.1 Download flow: `api.getBundle` → `bundles.put` → media pre-cache into `quest-bundle-{snapshot_id}`; staged `.dl-bar` progress, ready/update states from stored vs published snapshot_id
- [x] 4.2 `app/my-quests/page.tsx`: live rows (listQuests × listGrants × queue × bundles per spec), labeled demo fallback on backend unreachable; verify manually against seeded backend

## 5. Manifest + service worker

- [x] 5.1 `app/manifest.ts` («GEOHOD QUEST», standalone, #3B71FE/#fff) + committed 192/512 PNG icons from logo-mark--navy.svg
- [x] 5.2 Hand-written `public/sw.js` (shell SWR versioned cache, /quest ignoreSearch nav fallback, /api network-only, non-GET untouched, activate cleanup sparing quest-bundle-*) + `SwRegister` prod-only component in layout
- [x] 5.3 Offline E2E by hand: `npm run build && npm start`, download bundle, DevTools offline, install + full playthrough, reconnect flush; record results in change notes

## 6. Gates + archive

- [x] 6.1 Self-critique pass (edge cases from spec scenarios: idempotent re-flush, version freeze, migration once); all gates green: `npm test` (root), `cargo fmt --check && cargo clippy -- -D warnings` (untouched but verified), `npm run lint` (0 errors), `npm run build`
- [x] 6.2 `openspec archive pwa-offline --yes`; final report (shipped / deviations / debt / P5 cut)

## E2E results (5.3, run 2026-06-12, Playwright Chromium headless against `next start` + in-memory backend)

11/11 checks passed: live my-quests row (no demo label) → bundle download («✓ Скачан») →
SW active (prod) → **offline** navigation boots player from SW shell + IndexedDB bundle →
offline play (start → synonym «МИХАЙЛО ПУПИН» → gift step) → offline reload shows start
gate with «монеты останутся» → «Продолжить попытку» resumes exact step → play to terminal →
reconnect (`online` event) auto-flushes: server attempt bound, 5 facts, balance 10 (gift +5,
bonus +5) → re-flush idempotent (fact_count unchanged). Fresh browser profile shows «Не начат»
(per-device IndexedDB, as designed). Backend gates: cargo test 36 ok, fmt, clippy -D warnings,
pg_full_suite ok against live Postgres 17.
