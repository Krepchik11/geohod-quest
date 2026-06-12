# pwa-offline (new)

## ADDED Requirements

### Requirement: Facts persist in a durable IndexedDB queue with a pending/sent lifecycle
The player SHALL persist every appended fact to an IndexedDB queue (`geohod` DB, `facts` store) keyed by `(attempt_key, natural_key)` — the same device-agnostic natural key the backend dedups on — with status `pending`, in a write-through on append. A fact's status SHALL flip to `sent` when, and only when, a `POST /api/attempts/{id}/facts` containing it succeeds (a successful response means every fact in the batch is on the server, whether newly accepted or already known). Sent/pending chips in the sync sheet and the pending count in the menu SHALL read queue status; no in-memory approximation of server acknowledgement remains.

#### Scenario: Enqueue offline, flush on reconnect, re-flush is idempotent
- **WHEN** a player plays steps offline (facts queued `pending`), connectivity returns, a flush succeeds, and a second flush is triggered immediately after
- **THEN** after the first flush all queued facts are `sent` and the server projection matches the local one; the second flush sends no `pending` facts (or re-sends harmlessly — the server dedups by natural key) and produces no duplicate facts, no balance change, and no spurious correction popups.

#### Scenario: Long queue replay survives reload
- **WHEN** a player accumulates a long offline session (many steps, hints, gifts) and the page is killed and reopened with no network
- **THEN** the player hydrates facts and resume position from the queue, `projectBalance`/`projectState` over the hydrated facts equal the pre-kill values, and every fact still shows `pending` (ждёт) in the sync sheet.

### Requirement: Attempts can start fully offline and bind a server identity later
Attempt identity SHALL originate client-side: an `attempts` store row `{attempt_key (client UUID), quest_id, snapshot_id, server_attempt_id?, created_at}` created when play begins, with no network required. On the first successful online sync, the client SHALL register the attempt (grant + `POST /api/attempts`, with the existing checkout-then-retry fallback) and fill `server_attempt_id`; all subsequent flushes reuse it. The `demo-` placeholder attempt-id convention is removed.

#### Scenario: Offline-born attempt syncs once online
- **WHEN** a player starts and plays a quest entirely offline, then regains connectivity and a flush runs
- **THEN** exactly one server attempt is created, its id is stored as `server_attempt_id` for the local `attempt_key`, all pending facts post to it, and a later flush reuses the same `server_attempt_id` without creating a second attempt.

### Requirement: Existing localStorage saves migrate into the queue exactly once
On player mount, an existing `localStorage['quest-player-{questId}']` save SHALL be imported into the IndexedDB queue (facts as `pending`, resume position preserved) and the legacy key deleted, following the versioned-migration pattern. The migration SHALL be idempotent: it runs at most once per save and a reload after migration finds no legacy key and changes nothing.

#### Scenario: Legacy save hydrates once, then disappears
- **WHEN** a player with a pre-P4 localStorage save opens the player twice in a row
- **THEN** after the first open the facts/position appear in the queue, projections match the legacy save, and the legacy key is gone; the second open hydrates purely from the queue with identical state and no duplicate facts.

### Requirement: Quest bundles download explicitly and are stored frozen by snapshot_id
Bundle download SHALL be user-triggered («скачать для офлайна»): fetch `GET /api/quests/{id}/bundle?player_id=…`, store the frozen snapshot JSON in the `bundles` store keyed by immutable `snapshot_id`, and pre-cache referenced media into a named Cache (`quest-bundle-{snapshot_id}`). The UI SHALL show the three designed states: progress (`.dl-bar`), ready («✓ скачан · работает офлайн», size), and update available («Вышла версия N…» when the published `snapshot_id` differs from the stored one). A newer published version never mutates or evicts the bundle an in-progress attempt is bound to.

#### Scenario: Download, kill network, full playthrough
- **WHEN** a player downloads a bundle, the network is disabled, and the player opens and completes the quest
- **THEN** the snapshot loads from the `bundles` store with zero network requests for quest data, all steps render and validate locally (`isAnswerCorrect`), and all facts queue `pending` for a later flush.

#### Scenario: Version freeze across a newer published version
- **WHEN** an attempt is in progress on snapshot S1 and the quest publishes S2, which the player downloads
- **THEN** the in-progress attempt continues to load and validate against S1; only a newly started attempt binds S2; My Quests shows the «Вышла версия N» banner with the «завершённые остаются на своих версиях» note.

### Requirement: The player loads its snapshot from the bundle store when present
When opening a quest, the player SHALL resolve its snapshot in order: the snapshot_id bound to the active attempt from the `bundles` store → the latest stored bundle for the quest → the build-time golden as dev fallback. Resolution from the bundle store SHALL work with no network.

#### Scenario: Bundle beats golden
- **WHEN** a bundle for the quest exists in the store and the player opens it
- **THEN** the rendered steps come from the stored snapshot (not the golden import), and removing network connectivity does not change what renders.

### Requirement: Pending facts flush on reconnect, on app start, and manually — all gated by the sim toggle
The queue SHALL flush (collect `pending` → ensure attempt → POST → mark `sent` → derive the two SPEC corrections via the existing `deriveSyncCorrections`) on: the `window 'online'` event, player start, and the existing manual sync button. When `simOffline` is enabled, ALL flush triggers SHALL be suppressed (not only the manual one), so the design sim screens remain reproducible. A failed flush leaves every fact `pending` and is safe to retry. POSTs are never cached or replayed by the service worker; sync is owned by the queue alone.

#### Scenario: Reconnect flush with sim toggle off vs on
- **WHEN** a player with pending facts receives a `window 'online'` event with `simOffline` disabled, and the same event arrives with `simOffline` enabled
- **THEN** in the first case a flush runs (facts become `sent`, corrections derived from the projection diff); in the second case no network call happens and facts stay `pending`.

### Requirement: My Quests shows the live collection composed from server and local state
`/my-quests` SHALL compose real rows: published quests (`listQuests`) × the player's grants (`listGrants`) × local attempts/facts (state «Не начат / В процессе шаг N из M / Пройден», positions from projecting queued facts against the bundle's step count) × the `bundles` store (download state). When the backend is unreachable, the page SHALL fall back to the design demo rows, clearly labeled as demo data.

#### Scenario: Owned quest with an in-progress attempt renders live
- **WHEN** a player owns a published quest, has a local attempt with facts through step 3 of 8, and has downloaded the bundle
- **THEN** the row shows «В процессе · шаг 4 из 8» with a proportional progress line, «✓ Скачан · работает офлайн», and the attempt's version — all derived from live data, not fixtures.

#### Scenario: Backend down falls back, labeled
- **WHEN** the backend is unreachable at render time
- **THEN** the page renders the design demo rows with an explicit demo-data label instead of failing or showing an empty collection.

### Requirement: Start gate for quests with an existing attempt
Opening a quest that has an in-progress local attempt SHALL show the start gate: cover, attempt summary (date, шаг N из M, coins), and the two actions [Продолжить попытку] / [Начать заново] with the «монеты останутся» note. «Начать заново» SHALL start a fresh local attempt (new `attempt_key`) without deleting already-queued or synced coin facts — coins earned remain (server-side facts are immutable; the completion bonus stays once-ever per player+quest regardless).

#### Scenario: Restart keeps coins
- **WHEN** a player with a synced attempt (coins earned, some facts `sent`) chooses «Начать заново», plays again, and syncs
- **THEN** a new attempt is created locally (and registered server-side on flush), prior facts remain untouched in the queue history and on the server, the earned coins still count in the authoritative balance, and no second completion bonus is granted.

### Requirement: The app is installable and its shell works offline
The frontend SHALL serve a web app manifest (name «GEOHOD QUEST», `display: standalone`, theme `#3B71FE`, background `#fff`, 192/512 icons) and register a hand-written service worker in production builds only. The SW SHALL serve the app shell (player route assets, styles, fonts) stale-while-revalidate, SHALL never cache or replay non-GET requests, and SHALL not intercept API data fetches (bundle data lives in IndexedDB, not the SW cache).

#### Scenario: Installed app boots the player offline
- **WHEN** the app is installed (or the SW is active after one online visit), a bundle is downloaded, and the device goes fully offline
- **THEN** navigating to the player renders the app shell from the SW cache and the quest from IndexedDB; play is not blocked by the absence of network.

#### Scenario: Dev mode unaffected
- **WHEN** running `next dev`
- **THEN** no service worker registers, and no stale-shell behavior interferes with development.
