# Design: production-player

## Route and resolution

`/quest/[questId]/page.tsx` is a thin RSC shell (full-bleed paper background, no site chrome) rendering the client `BundleGate`. Resolution order inside BundleGate (client-only, IndexedDB + network):

1. active attempt's bound bundle (`attempts.snapshot_id` → `bundles`) — version freeze;
2. latest downloaded bundle for the quest — offline play;
3. `GET /api/quests/{id}/bundle?player_id=…` — grant-gated; on success the bundle is stored (write-through) so the next open is offline-capable;
4. terminal designed states: HTTP 403 → access screen (cover, «Нужен доступ», CTA to `/#shop`); 404/network-fail → unavailable screen (offline note when `!navigator.onLine`).

No golden fallback in the runtime path: goldens stay test fixtures + backend seed source. The old behavior (unknown id silently plays mystery) was a correctness bug, and a client-side fallback snapshot is an access-control bypass.

Bare `/quest` redirects: `?golden=x` → `/quest/x` (bookmark compat), otherwise → `/my-quests`.

## Connectivity

`useOnline()` hook: `navigator.onLine` initial + `online`/`offline` listeners. Flush triggers (mount, `online` event, manual «Синхронизация» action) gate on real online state. Banner state machine: `offline` (count = pending) → shown; `syncing` → shown; flush success → `done` for 2.4 s → hidden; idle/online/no-pending → hidden. The SPEC PWA-sim screens remain reproducible in the design canvases — the production app does not ship a network simulator.

## Wrong-answer / hint flow (SPEC §Wrong-Answer)

Pure helpers in shared-model (unit-tested, reused by future ctor test box):

- `wrongAnswersAt(facts, pos)` — count of `answer_submitted` with `local_is_correct === false` at `pos`;
- `shouldOfferHint(facts, pos, step)` — wrongs ≥ 2 ∧ `step.supporting.hint` ∧ `pos ∉ projectState(facts).revealedHints`.

The component computes the popup decision from the fact log AFTER appending the wrong fact — no parallel wrong-counter state to drift.

## Ирония судьбы as data

`golden-ironia-sudby-v1.json` carries the full 8-step design content (design/player/quest-data.js): video templates use the new optional `media.video = { ref, duration_label, caption }` (snapshots are opaque JSONB server-side — Fact parity is untouched). Backend `seed_demo_quest` becomes a loop over two embedded (id, meta, golden) tuples. The player maps GameStep → DesignStep through one pure `toDesignStep` (lib/design-step.ts) for every quest — the special-cased demo array dies.

## Deletions

`AnswerForm`, `NavigatorButton`, `PhysicalConfirmButton` (already unreferenced), `OfflineBanner`, `CoinDisplay`, `BonusAnimation`, `WrongHintPopup`, `FeedbackMenu`, `app/MarketplaceList.tsx`. StartGate, PlayerComponents, queue/sync/identity libs are unchanged in contract.
