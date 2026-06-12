# design-fidelity Specification

## Purpose
TBD - created by archiving change design-fidelity-frontend. Update Purpose after archive.
## Requirements
### Requirement: Two distinct token systems, ported verbatim
The frontend SHALL carry two scoped design-token sets ported from the design project: the site system (blue/Inter+Jost/pill, from `commerce/site-theme.css`) and the player system («Бумага» paper, from `player/theme.css` `[data-art="paper"]` block: bg #FBF1E5 with 1px striping, ink #3E2C2C, accent #A33B2A, card #FFF9F0, line rgba(62,44,44,.28), coin #C99B3F rim #8A6A1F, Prata display/Inter body, 0px button radius). The systems SHALL never be merged; player styles apply only inside the player frame scope.

#### Scenario: Paper tokens match the design source exactly
- **WHEN** the player frame renders with the paper art direction
- **THEN** computed values for background, ink, accent, card, line, coin colors and fonts equal the design `theme.css` paper block, including the missing-in-current tokens --p-line, --p-display, --p-body, --p-radius, --p-btn-radius.

### Requirement: Entrance animations are gated and end-state is the base style
All player animations (shake, rise, fade, toast-in, coin-spin, coin-pop, confetti fall) SHALL be defined per the design keyframes, gate on an anims-enabled flag (`[data-anims="off"]` disables all animation/transition) and respect `prefers-reduced-motion`; UI visibility SHALL never depend on animation playback (static renders show full content).

#### Scenario: Reduced motion shows complete static content
- **WHEN** `[data-anims="off"]` is set or the OS requests reduced motion
- **THEN** every element renders in its end state with no animation, and nothing is invisible or clipped.

### Requirement: My Quests renders the designed collection states
The My Quests page SHALL use the site layout and render per row: cover, meta, title, download status (✓ скачан · size / «скачать для офлайна»), optional version banner («Вышла версия N+1…»), state column (Не начат · grant date | В процессе · шаг N из M + progress bar + version | Пройден ✓ + stars) and matching actions ([Начать] | [Продолжить]+[Начать заново] | [Пройти заново]); plus the designed empty state. A Profile page SHALL show user data and game tiles (coin balance, personal rating with display floor at 0, quests completed) and the completed list with own ratings.

#### Scenario: Three row states render with designed badges and actions
- **WHEN** the collection contains quests in new/progress/done states
- **THEN** each row shows its badge (.mq-badge--new/--progress/--done), the progress row shows the progress bar and version, the done row shows stars, and the action buttons match the state.

### Requirement: Checkout implements the designed states including the 0 ₽ path
The checkout page SHALL render the designed two-column structure (quest summary card with lifetime note; order card with price row), coupon flow (collapsed «Есть купон?» → input + Применить → applied green chip with −N% and remove, or error «Купон не найден или истёк»), total with struck-through original when discounted, CTA [Оплатить N ₽] or [Получить бесплатно] when the total is 0, pay marks and provider-redirect disclaimer; plus designed success («Квест ваш — навсегда», order details, [Начать квест]/[В мои квесты]) and failure (no money taken, retry/back, support email) screens. Quest detail SHALL show the entry card in paid/free/owned variants.

#### Scenario: 100% coupon flows to the free CTA without provider step
- **WHEN** a 100% coupon is applied on a paid quest
- **THEN** the total shows 0 ₽ with the original struck through, the CTA reads «Получить бесплатно», and confirming grants without any provider redirect.

### Requirement: Constructor exposes versions, publish gates checklist and modal
The constructor SHALL render: a versions panel (draft with gate count; published versions tagged live/old, immutable, old versions noting active attempts); a publish checklist screen with colored gate rows (ok/err/warn), per-error fix affordance, bundle size estimate and dry-run serialize action, publish disabled while errors exist; and a publish modal stating immutability (new attempts on N, active attempts keep theirs, no rollback). The per-step editor SHALL show 4 comic zones in the designed grid with the required badge on the task role, the gift freeze note, and the scaled live phone preview with the revealed-hint toggle.

#### Scenario: Errors block publish, warnings do not
- **WHEN** the draft has one error gate and one warning gate
- **THEN** the checklist shows a pink err row and an amber warn row, the publish button is disabled; fixing the error enables publish with the warning still visible.

### Requirement: Sync UI implements the two SPEC corrections and the queue
The player SHALL render the sync banner in its three designed states with exact RU copy (offline: «Офлайн. Прогресс сохраняется на устройстве» + «N событий ждут»; syncing: «Онлайн. Отправляем события…» + «осталось N»; done: «Прогресс синхронизирован», auto-hiding), a sync sheet listing queued facts in human language with ждёт/отправлено chips, and the two correction popups driven ONLY by `deriveSyncCorrections`: «Баланс обновлён» showing old → new, and the attempt-advance offer ([Продолжить с шага N] / [Остаться]).

#### Scenario: Balance notice renders from projection diff after merge
- **WHEN** a sync returns an authoritative projection whose balance differs from the pre-sync local one
- **THEN** the «Баланс обновлён» popup shows the old value struck through, an arrow, and the new value (negative values displayed as-is), and dismissing it leaves the authoritative balance in the top bar.

### Requirement: Visual regression fixture page exists and matches the design fixture
A `/review/visual-control` page SHALL recreate `review/Визуальный контроль.html`: logo block (composite + mark ×3 + text ×3 + admin brand), avatar composition (head+body parts centered, 48px/36px/×2), meta icons and pay marks at design sizes, telegram-on-dark cell, and assembled site + admin headers at 1240px with single-line nav items. SVG assets are the design files copied AS-IS.

#### Scenario: Fixture renders every block
- **WHEN** the fixture page is opened
- **THEN** all sections render with the design assets and class structure, providing the visual regression baseline for iconography and headers.

### Requirement: Lint is a green quality gate
`npm run lint` SHALL pass with zero errors across the frontend (no-explicit-any, no-html-link-for-pages, set-state-in-effect and other pre-existing violations fixed), and stays in the root quality-gate chain.

#### Scenario: Lint gate enforced
- **WHEN** `npm run lint` runs at the frontend root
- **THEN** it exits zero.

