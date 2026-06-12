# Proposal: production-player

## Why

The designed paper player is fully implemented underneath, but the shipped `/quest` page is a development harness, not a product: a `?golden=` fixture switch in the URL, a "Designed player (paper) • … NEXT_PUBLIC_API_URL=…" banner, a "simulate disconnect / simulate sync" panel instead of real connectivity, an `append-only facts • LS roundtrip …` dev footer, a facts-JSON debug dump, a hardcoded «Ирония судьбы» step array inside the client component, duplicated legacy popups (WrongHintPopup next to the designed HintPopup), and a fake auto-grant that bypasses access control for the demo quest. The landing page carries a dev callout with port instructions and an inline "Load admin demo" block. Two SPEC violations hide in the harness: the hint popup fires on the FIRST wrong answer (SPEC Wrong-Answer/Hint Flow: inline error first, popup from the 2nd), and an unknown quest id silently plays the mystery golden instead of failing.

## What Changes

- **Route**: the player moves to `/quest/[questId]` (path param = published quest id). Bare `/quest` (and legacy `?golden=`) redirects. All in-app links updated (`/`, my-quests, commerce, quest-detail, cabinet, constructor, e2e).
- **Snapshot resolution becomes production-true** (BundleGate): attempt-bound local bundle → latest local bundle → `GET /api/quests/{id}/bundle` (grant-gated; success also stores the bundle for offline) → designed error screens (403 → «Нужен доступ» with marketplace CTA; offline/unknown → «Квест недоступен»). The build-time golden fallback and the client-side fake grant are removed — access is enforced by the server, full stop.
- **Real connectivity replaces simulation**: offline state comes from `navigator.onLine` + `online`/`offline` events. The sync banner shows offline (with queued count) / syncing / done-briefly, then hides. The simulate toggle, sim-sync button and all `simOffline` plumbing are deleted.
- **Player chrome is the design, nothing else**: full-bleed paper page rendering PlayerFrame + TopBar + StepView + overlays only. Debug card, CoinDisplay/step debug row, facts JSON, dev footer, legacy WrongHintPopup/FeedbackMenu/BonusAnimation/OfflineBanner/CoinDisplay components deleted. Gift/bonus awards use the designed CoinToast + WebAudio coin chime (design prototype), gated by the menu sound toggle; speechSynthesis is removed.
- **SPEC fix — hint popup threshold**: first wrong answer → inline «Неверно…» + shake; popup «Нужна подсказка?» only from the second wrong on that step, only while a hint exists and is not yet purchased.
- **«Ирония судьбы» becomes real data**: new golden `golden-ironia-sudby-v1.json` (8 steps, all 7 templates, full design copy/coords/costs) seeded and published by the backend next to the mystery quest; the hardcoded client array and `useIroniaDemo` branch are deleted. `Media` gains an optional `video` ref/duration/caption so video templates flow through the same snapshot path.
- **Landing page sweep**: dev callout block and inline admin-demo block removed (admin stats live at `/admin/stats`); dead `MarketplaceList.tsx` deleted.

## Capabilities

### Modified Capabilities

- `quest-player-pwa`: route + access enforcement + real connectivity (replacing sim-mode requirement) + wrong-answer popup threshold.
- `design-fidelity`: player page is the pure designed experience; designed coin toast + chime; no debug chrome anywhere on shipped pages.

## Impact

- `frontend/app/quest/` — page split to `[questId]/page.tsx` + redirect page; QuestPlayerClient rebuilt around the designed chrome; BundleGate rewritten; 7 dead components removed.
- `frontend/lib/shared-model.ts` — optional `Media.video`; pure `wrongAnswersAt`/`shouldOfferHint` helpers (+ vitest).
- `frontend/lib/design-step.ts` (new) — pure GameStep → DesignStep mapper (+ vitest).
- `goldens/golden-ironia-sudby-v1.json` (new), `backend/src/main.rs` seed loop, `frontend/lib/goldens.ts`.
- `frontend/app/page.tsx`, `my-quests`, `commerce`, `quest-detail`, `cabinet`, `constructor` — link updates + debug sweep.
- `platform/e2e-identity.mjs` — new player URL.
