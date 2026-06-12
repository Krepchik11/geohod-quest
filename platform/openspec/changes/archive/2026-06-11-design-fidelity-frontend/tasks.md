# Tasks: design-fidelity-frontend

## 1. Tokens, CSS port, assets

- [x] 1.1 Copy `design/assets/icons/*.svg` AS-IS to `frontend/public/assets/icons/`
- [x] 1.2 Port `design/player/theme.css` (paper + shared `.p-*` + all keyframes + `[data-anims]`/reduced-motion gating) to `app/styles/player-paper.css`; delete superseded `.p-*` rules from globals.css
- [x] 1.3 Port commerce additions (`.co-*`, `.res-*`, `.auth-ctx`, `.entry-*`, pay row) to `app/styles/commerce.css`; myquests (`.mq-*`, `.pf-*`, `.sg-*`, `.dl-*`, `.mqm-*`, empty state) to `app/styles/myquests.css`
- [x] 1.4 Port ctor additions (`.tpick-*`, `.pg-row`, `.ver-row`, `.gate-*`, `.adm-modal`, `.comic-zone`, `.freeze-note`, `.adm-toggle`, sm/wide control variants) to `app/styles/admin-ctor.css`; pwa (`.p-syncbar` variants + `.cnt`, `.sync-row`, `.sync-chip`, `.fix-balance`) to `app/styles/pwa-sync.css`; import all from layout

## 2. Player fidelity + sync UI

- [x] 2.1 `PlayerComponents.tsx`: exact paper structure/classes (top bar 52px, stepbody padding, media 252px, btn 56px lowercase display font, hintbox coin-mix, flourish, finals, rate stars #D9A024); SyncBanner 3 designed states with RU copy + dot + count
- [x] 2.2 Correction popups: «Баланс обновлён» (old → new with `.fix-balance`) + advance offer ([Продолжить с шага N]/[Остаться]) rendered from `deriveSyncCorrections` output in player state; accept advances position
- [x] 2.3 Sync sheet in menu: queued facts in human RU labels with ждёт/отправлено chips + offline chip footer

## 3. Pages restructure

- [x] 3.1 My Quests rebuild on site layout: mq-row states (badges/progress bar/stars), download states, version banner, empty state; new `/profile` page (user rows, game tiles with rating floor 0, completed list)
- [x] 3.2 Checkout rebuild: `.co-wrap`/`.co-cols`, quest summary + lifetime note, coupon collapsed/open/applied/error, struck-through total, 0 ₽ «Получить бесплатно», pay marks + disclaimer; success/failure `.res-*` screens
- [x] 3.3 Quest detail entry card: paid/free/owned variants (owned from grants list)
- [x] 3.4 Constructor: versions panel (draft/live/old), publish checklist (colored gate rows, bundle est, dry-run, errors block) + publish modal; comic zones 4-col grid + req badge; freeze note; adm-toggle; scaled `.ed-phone` preview
- [x] 3.5 Visual fixture page `/review/visual-control` recreating the design fixture (logo, avatar 48/36/×2, meta icons, pay marks, telegram dark, site + admin headers 1240)

## 4. Lint + gates

- [x] 4.1 Fix all eslint errors across app/ (typed wire shapes, next/link, effect patterns); `npm run lint` zero errors
- [ ] 4.2 All gates green: vitest, lint, next build, cargo suite untouched, root npm test; archive change
