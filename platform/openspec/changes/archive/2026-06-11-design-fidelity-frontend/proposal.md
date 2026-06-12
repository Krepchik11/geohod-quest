# Proposal: design-fidelity-frontend

## Why

The design project (`design/` — HTML canvases + reference CSS/JSX) is the primary UX/UI source of truth (CONCEPT precedence rule), and PLAN Phase 0 mandates lifting its tokens, copy, and component structure verbatim. The current frontend diverges badly: an audit against the design files measured ~25% fidelity for My Quests (admin layout instead of site layout, no row states/badges/progress/version banner), ~40% for commerce (no coupon states, no 0 ₽ path styling, no result screens structure, no entry-card variants), ~55% for the constructor (no versions panel, no publish checklist/modal, wrong comic-zone grid), and the player paper theme is missing 5 design tokens, all 10+ animation keyframes, the reduced-motion/anims gating, and exact dimensions. The two SPEC sync corrections have backend + pure-helper support since P1 but **no UI at all** (no «Баланс обновлён» popup, no advance offer, no sync sheet). The visual regression fixture (`review/Визуальный контроль.html`) has no frontend counterpart. ~55 pre-existing eslint errors were deferred to this phase.

## What Changes

- Port design CSS verbatim-adapted into scoped frontend stylesheets: player paper theme (tokens, all `.p-*` classes, keyframes, `[data-anims]` + `prefers-reduced-motion` gating), site commerce additions (`.co-*`, `.res-*`, `.auth-ctx`, `.entry-*`), my-quests (`.mq-*`, `.pf-*`, mobile `.sg-*`/`.dl-*`/`.mqm-*`), admin constructor additions (`.tpick-*`, `.pg-row`, `.ver-row`, `.gate-*`, `.adm-modal`, `.comic-zone`, `.freeze-note`, `.adm-toggle`), pwa sync (`.p-syncbar` variants, `.sync-row`, `.sync-chip`, `.fix-balance`). Site and player systems stay intentionally distinct — never merged.
- Copy the 10 SVG assets from `design/assets/icons/` AS-IS into `frontend/public/assets/icons/`.
- Rebuild **My Quests** on the site layout: row states (Не начат / В процессе / Пройден), download states, version banner, empty state; new **Profile** page (tiles: balance, rating, completed).
- Rebuild **checkout** to the designed structure: `.co-wrap`/`.co-cols`, coupon collapsed → input → applied/error states, 0 ₽ «Получить бесплатно» path, success/failure result screens, lifetime note.
- **Quest detail** entry card: paid / free / owned variants.
- **Constructor**: versions panel (draft/live/old tags), publish checklist (colored gate rows, bundle estimate, dry-run) + publish modal, 4-column comic zones with required badge, freeze note, designed toggle, scaled live phone preview.
- **Player**: exact paper theme classes; sync banner 3 states with RU copy + count; sync sheet (queued facts list); the two SPEC correction popups wired to `deriveSyncCorrections` («Баланс обновлён» old→new, attempt-advance offer).
- New **visual fixture page** (`/review/visual-control`) recreating `review/Визуальный контроль.html` — logo, avatar composition, meta icons, pay marks, assembled site/admin headers.
- Eliminate the pre-existing eslint errors (no-explicit-any, no-html-link-for-pages, set-state-in-effect) — `npm run lint` becomes a green gate.

## Capabilities

### New Capabilities

- `design-fidelity`: the frontend's visual contract with the design project — token parity, screen-state coverage, fixture page, animation gating, and the sync-correction UI.

### Modified Capabilities

(None — behavior/invariants unchanged; this change implements already-specified UI surfaces.)

## Impact

- `frontend/app/globals.css` → split/extended with ported design CSS (player paper, commerce, myquests, admin, pwa families).
- `frontend/public/assets/icons/` — 10 SVGs from design.
- Rebuilt/extended pages: `my-quests`, new `profile`, `commerce`, `quest-detail`, `constructor`, new `review/visual-control`.
- `app/player/PlayerComponents.tsx` + `app/quest/QuestPlayerClient.tsx` — sync banner fidelity, sync sheet, correction popups.
- Lint fixes across `app/` (typed handlers, `next/link`).
