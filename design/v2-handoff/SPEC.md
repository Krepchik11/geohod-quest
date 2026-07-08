# GEOHOD QUEST — UX/UI v2 Implementation Spec

Target: the Next.js frontend (`frontend/`). Language of UI strings: Russian (quoted verbatim — use them exactly).
Visual reference: hi-fi mockups in `screens/` — `Landing v2.dc.html`, `Quest Page.dc.html`, `My Quests v2.dc.html`, `Auth v2.dc.html`, `Profile v2.dc.html`, `Player v2.dc.html`, `Editor v2.dc.html`, `Admin v2.dc.html`. The audit that motivated every item is `screens/UX Review.dc.html` (issue numbers below match it).

Rules of engagement (owner's constraints): TDD — every behavior below lands with tests first; fix root causes, not symptoms; no dead code left behind; honest UI only — never promise what the backend doesn't do.

---

## 0. Design tokens (S1) — do this first, everything else consumes it

Create one token layer (CSS custom properties in `globals.css`) + shared `Button` / `Input` components. Migrate editor and admin to them. The storefront look is the reference; the paper player keeps its own art direction (do NOT migrate it).

Tokens:
- Colors: `--navy:#122947`, `--text:#1A2B48`, `--blue:#3B71FE`, `--blue-hover:#2E5FE3`, `--muted:#83858C`, `--muted-2:#5B6373`, `--border:#DEDEDE`, `--border-2:#E9EBEF`, `--bg-subtle:#F7F8FA`, `--green:#1F8A5B`, `--red:#C0395C`, `--amber:#B45309`, star gold `#E7A934`.
- Radii: `--r-pill:26px` (buttons), `--r-card:18px`, `--r-ctl:10px` (inputs, selects).
- Control heights: 52 (primary CTA), 48 (secondary), 44 (compact / inputs / admin & editor controls). Touch targets never < 44px.
- One card shadow: `0 12px 12px rgba(0,0,0,.05), 1px 2px 15px rgba(0,0,0,.08)`.
- Fonts: Jost (UI, uppercase letterspaced headings), Prata (display — storefront hero, paper player). Editor/admin drop their extra font families; Prata greeting in the editor dashboard is removed.
- Button variants: primary (blue pill), secondary (white pill, `inset 0 0 0 2px var(--blue)`), quiet (1px `--border` pill), destructive (red pill). Input: 1px `--border`, r10, focus `1.5px --blue + 0 0 0 3px rgba(59,113,254,.15)`.

Acceptance: no component in editor/admin defines its own radius/height/shadow literal; grep for the old inset-ring input style returns nothing; the deprecation guard in `layout.tsx` can be retired.

## 1. Layout system (S3 + mobile nav)

1. Remove `body.site min-width:1240px`. Container becomes fluid: `max-width:1240px; margin-inline:auto; padding-inline:clamp(20px, 4vw, 42px)`. Delete the "bolted-on" `responsive.css` layer by folding its rules into components; media queries remain only to restack grids (features 2→1 col at ~900px, shop cards 3→2→1, profile 2-col → 1 at <1024).
2. Bottom tab bar on mobile (<768px) for the three top-level pages: «Магазин» / «Мои квесты» / «Профиль». Fixed to viewport bottom + safe-area inset; active tab blue; hidden on the quest player (`/quest/[id]`), on `/quest/[id]/about` (detail page uses «← Магазин» back header + sticky purchase bar), and in editor/admin.
3. Footer renders on ALL storefront pages (1.6); nav item «контакты» links to `/#contacts` so it works off the homepage.

## 2. Storefront (Landing v2 — 1.1–1.6, S4)

### 2.1 Card → product page (1.1)
Cover, title, and a new link «О квесте и отзывы →» on every shop card route to `/quest/[id]/about` (see §3). Nothing on the card routes to the player anymore.

### 2.2 Buy fast-path + in-card status (1.2)
- Card button «Купить» opens the purchase confirmation sheet (§3.3) directly.
- Free quests (`price === 0`): button «Получить» grants instantly (existing `checkout` call), **no sheet**. In-card success state: price slot shows «✓ Квест в „Моих квестах"», button flips to «Пройти».
- All purchase status lives in the card (or sheet), never under the grid: pending = button «Оформляем…» with spinner; error = red line under the price row: «Не получилось оформить покупку — попробуйте ещё раз.» Remove the page-bottom status paragraph.

### 2.3 Hero sells (1.4)
Add a facts row under the subtitle, computed from the live catalog response: `{N} квестов · {M} городов · ★ {avg} — средняя оценка игроков` (N = published quests, M = distinct non-null cities, avg = weighted mean of `rating_avg`; hide the star segment while `rating_count` totals 0). Keep headline «авторские квесты» and CTA «Выбрать квест» (scrolls to catalog).

### 2.4 Features (1.4)
Four cards, full-phrase headlines, four DISTINCT photos (assets pending — ship with labeled placeholders):
1. «Все задания — в смартфоне» / «Начать и продолжить можно в любое время, число попыток не ограничено.»
2. «Любое число участников» / «Проходите в одиночку или дружной компанией — вместе веселее.»
3. «Игра со смыслом» / «Квест знакомит с городскими легендами и историческими персонажами.»
4. «Маршруты к необычным местам» / «Ведём туда, мимо чего проходят даже местные.»

### 2.5 Header auth state (1.5)
Anonymous: text pill button «Войти» (h44, secondary style) → `/auth`. Signed-in: avatar circle with green presence dot → profile dropdown. The bare icon button never shows for anonymous users.

### 2.6 Removals & honesty (1.3, S4)
- Delete the `.to-top` button and its CSS — dead code.
- Footer: remove Visa/MC/PayPal icons until a real PSP exists. «Политика конфиденциальности» → `/privacy`, «Пользовательское соглашение» → `/terms` — real static pages (plain readable Russian from a standard template), also linked from the registration consent checkbox. No `href="#"` anywhere.

## 3. Quest product page + purchase (S2 — new)

### 3.1 Route
`/quest/[id]/about` (new RSC page; the player stays at `/quest/[id]`). Breadcrumb «Магазин квестов / {название}». Shows ONLY model data: cover, title, `city`, `duration`, `price`, `rating_avg`/`rating_count`, the constructor's store `description`, author display name + count of their published quests, content chips derived from the published snapshot («{N} страниц», «{M} заданий», «подсказки за монеты», «работает офлайн»).

### 3.2 Order card (desktop right sticky column / mobile sticky bottom bar)
Not-owned: price + benefits (`✓ Доступ навсегда, попытки не ограничены`, `✓ … страниц · … заданий · подсказки за монеты`, `✓ Скачивается и работает офлайн`) + «Купить за {price} ₽» + caption «Дальше — шаг подтверждения. Покупка привяжется к этому устройству; войдите, чтобы сохранить её в аккаунте.» (link → `/auth`).
Owned: «✓ Квест куплен» + primary «Пройти квест» (→ player) + offline download progress row (§4.2) + «⊕ Установить на телефон» (§5).
Free not-owned: button «Получить» — instant grant, card flips to owned state in place.

### 3.3 Confirmation sheet (1.2)
Bottom sheet on mobile, centered 440px modal on desktop. Contents in order: grabber/title «Подтвердите покупку»; quest row (thumb, «{название}», «{город} · {длительность} · доступ навсегда»); price row «К оплате — {price} ₽»; collapsed link «Есть промокод?» revealing input + «Применить» (calls `checkout` with `coupon_percent`; discount row «Промокод −{n}%» with old price struck through); FOR ANONYMOUS ONLY a warning box: «Вы не вошли: покупка привяжется к этому устройству и потеряется при смене браузера. Войти»; primary «Подтвердить — {price} ₽»; text button «Отмена».
States inside the sheet: pending «Оформляем покупку…» (spinner, controls disabled); error box «Не получилось оформить покупку — проверьте связь и попробуйте ещё раз.» + button «Повторить — {price} ₽». No real PSP yet: confirm calls the existing `api.checkout`; the sheet is the seam where a PSP step will slot in later.

### 3.4 Post-purchase
Stay where the user is: sheet closes → owned state renders in place (product page order card, or shop card success state). Offline bundle auto-download starts silently (§4.2). No redirect.

### 3.5 Reviews block
Header «Отзывы игроков» + «{N} оценок · {M} с отзывом». Until the reviews backend (§11) ships: show only «★ {avg} · {N} оценок»; empty state «Пока без отзывов — станьте первым». With reviews: newest-first list — first name, month («июнь 2026»), stars, text.

## 4. My Quests v2 (2.1–2.4)

### 4.1 One honest button per row (2.1)
Row CTA: «Продолжить» (in progress) / «Начать» (not started) / «Пройти заново» (completed → keeps `?restart=1`). DELETE the list's «Начать заново» button — restart lives only in the player start gate (§8.2). Progress bar + «шаг {n} из {m}» stay in the row; attempt dates include the year («попытка от 28.06.2026») (2.3).

### 4.2 Offline download (2.2)
- Replace the 11.5px underlined link with a visible quiet-pill button: «⭳ Скачать для офлайна · {size} МБ».
- Downloading: same slot shows spinner + «Скачиваем для офлайна · {a} из {b} МБ» + thin progress bar.
- Done: cover gets badge «⭳ офлайн» (navy pill, top-left).
- Auto-download: immediately and silently after any successful purchase/grant and after «Доступно обновление · обновить».
- Errors: toast «Не удалось скачать квест — проверьте связь» with inline «Повторить» action. `alert()` is banned; add a small shared toast component (also used by editor/admin flows).

### 4.3 Collection states (2.3)
Load error gets a button: «Не удалось загрузить коллекцию. Проверьте подключение — и попробуем снова.» + «Повторить». Empty state: «Пока пусто. Выберите первый квест — и город станет игрой.» + «В магазин квестов».

### 4.4 PWA banner removed (2.4)
Delete the layout-shifting install banner from this page. Global app install becomes a Profile row (§7.4); per-quest install lives in each row: text button «⊕ На экран „Домой"» (§5).

### 4.5 Mobile
Rows restack as cover cards (same anatomy as shop cards): status badge on the cover («В процессе» blue / «Пройден» green / «Не начат» white), progress as a 5px bar along the cover bottom, one CTA + utility buttons below.

## 5. Per-quest PWA install (new feature)

Each OWNED quest is installable as its own home-screen app that opens straight into that quest.

- Manifest: route handler `/quest/[id]/manifest.webmanifest` returning `{ id: "/quest/<id>", start_url: "/quest/<id>", scope: "/quest/<id>", name: "<Название квеста>", short_name: truncated title, display: "standalone", background_color: "#FBF1E5", theme_color: "#3E2C2C", icons: [192, 512 maskable] }`. The quest page and player page link this manifest via `<link rel="manifest">`; all other pages keep the global manifest.
- Icons: server-generated from the quest cover — center-crop to square, 192/512 PNG, maskable-safe padding; fallback (no cover): logo mark on navy. Backend/build task; cache per published version.
- Entry points: product page owned-state button «⊕ Установить на телефон»; My Quests row button «⊕ На экран „Домой"». Chromium: capture `beforeinstallprompt` per scope and `prompt()`. iOS Safari: open an instruction sheet — title «Квест — на экран „Домой"», steps: «1. Нажмите Поделиться в панели Safari 2. Выберите На экран „Домой" 3. Иконка квеста откроет игру сразу — даже офлайн», button «Понятно». Hide install buttons when already running standalone in that quest's scope.
- Global app install: keep the root manifest as is; the trigger moves to Profile → «⊕ Установить приложение» (Chromium prompt / iOS instruction sheet). Existing `lib/install.ts` logic is reused, parameterized by manifest scope.
- Note: navigating outside `/quest/<id>` inside an installed quest app shows browser chrome — acceptable; the post-final catalog links may open the full site.

## 6. Auth v2 (3.1, 3.3)

### 6.1 Email-first single form (3.3)
Replace the two blue pill toggles with one flow:
1. Step 1: title «Вход или регистрация», subtitle «Аккаунт сохранит покупки, монеты и прогресс при смене устройства.», email field, button «Продолжить», caption «Играть можно и без аккаунта — вернитесь к этому позже.»
2. Backend: new endpoint `POST /api/auth/identify { email } → { exists: boolean }` (rate-limited).
3. exists → Step 2a «С возвращением!»: email chip with «изменить», password field with «Показать» toggle, right-aligned link «Забыли пароль?», button «Войти». Wrong password: field turns red + inline «Неверный пароль. Восстановить?» (error at the field, not a generic banner).
4. not exists → Step 2b «Создадим аккаунт»: password field («Придумайте пароль», hint «Минимум 8 символов», «Показать»), consent checkbox «Принимаю пользовательское соглашение и политику конфиденциальности» (real links), button «Зарегистрироваться», green note «Монеты и покупки этого устройства привяжутся к аккаунту.» (register still passes `anonymousPlayerId()` — existing behavior, now stated).
5. The card's ✕ navigates to `/` (never `history.back()`).
6. The 409 «email or device already registered» error class disappears by construction; keep a defensive message just in case.

### 6.2 Password recovery — R1 link + R2 code (3.1)
- «Забыли пароль?» → «Восстановление пароля»: «Пришлём ссылку для смены пароля.», prefilled email, «Отправить ссылку», «← Назад ко входу».
- ONE mail carries both credentials: a 6-digit code (first line, so it shows in mail notification previews) and the `/auth/reset?token=…` link. Both die in 30 minutes; a resend invalidates both prior credentials (latest mail wins).
- Sent state (same response whether or not the email exists — no user enumeration): «Письмо ушло» / «Отправили код и ссылку на {masked} — действуют 30 минут. Не пришло — проверьте „Спам".» + inline code entry («Код из письма», 6 digits) + new password (min 8, «Показать») + «Сменить пароль и войти» — the mobile user types the code off the notification and never leaves the app/PWA context. Resend keeps the cooldown timer «Отправить ещё раз · 0:42».
- Link opens `/auth/reset?token=…`: new password (min 8, «Показать») → success → signed in.
- Backend: token issue/verify + transactional email sending (first email infrastructure — also used by §6.3). `POST /api/auth/reset` accepts `{token, password}` OR `{email, code, password}`; the code is email-scoped, stored hashed alongside the token in one single-use row, and dies after 5 verify attempts (low-entropy codes must not be brute-forceable). R3 (magic link) stays rejected — do not build it.

### 6.3 Soft email confirmation
On registration send a confirmation email; account works immediately. Unconfirmed accounts see a dismissable amber banner in Profile: «Подтвердите почту — отправили письмо» + «Ещё раз». Password recovery is only offered for confirmed emails (unconfirmed → explain and offer resend of confirmation). Store `email_confirmed_at`.

## 7. Profile v2 (3.2, 3.4)

1. **Honest tiles (3.2):** delete «личный рейтинг» (it was `max(balance,0)`). Two tiles: «{N} монеты на балансе» + «{M} квеста пройдено».
2. **Completed quests list:** each row shows completion date with year + the player's own rating from `latestRating(facts)` as stars, or «без оценки». The hardcoded 5 gold stars are deleted.
3. **Account block («Аккаунт»):** rows «Изменить имя», «Сменить пароль» (sheet: current + new password, «Показать» on both, link «Не помню текущий — восстановить по почте»; backend: change-password endpoint), «⊕ Установить приложение» (global PWA, §5), «Выйти» (also stays in header dropdown), red «Удалить аккаунт».
4. **Delete account:** dialog «Удалить аккаунт навсегда?» with concrete consequences («✕ {N} купленных квеста станут недоступны», «✕ {M} монеты и весь прогресс исчезнут», «✕ Отменить удаление нельзя»), confirmation checkbox «Я понимаю, что данные будут удалены безвозвратно» gating the red button «Удалить навсегда». Editors with published quests are blocked: «Сначала снимите с публикации {N} квеста». Backend: delete endpoint honoring the block.
5. **Anonymous nudge (3.4/1.5):** when anonymous AND (coins > 0 OR purchases > 0): card «Вы играете без аккаунта — всё хранится только на этом устройстве» + «У вас {N} монеты и {M} купленный квест. Смените браузер или телефон — они потеряются. Привяжите почту, и всё сохранится.» + «Создать аккаунт» / «У меня уже есть аккаунт».
6. Keep: offline-first local data display and the honest server-degradation line.

## 8. Player v2 (4.1–4.5) — paper system only, no site controls inside

1. **Always-available hint (4.1):** on steps that have a hint and it isn't bought: paper chip button (1px ink border, r2, Prata lowercase) «подсказка · {cost} монет» sitting above the answer form in the sticky action cluster. Tap → existing hint purchase flow. The proactive popup after the 2nd wrong answer stays. After purchase the chip disappears (hint shown inline, as today). Cost comes from the step data — never hardcode 5.
2. **Paper start gate (4.2, closes 2.1):** rebuild `StartGate` in the paper language (see mock frame B): «городской квест» + Prata title + ornament divider; «У вас есть незаконченная попытка»; two stat cards «шаг {n} из {m} / от {дата с годом}» and «{coins} монет заработано»; ink button «продолжить попытку», outline «начать заново», caption «„Начать заново" сбросит прогресс попытки. Заработанные монеты останутся при вас.» No blue pills inside the player.
3. **Progress bar (4.3):** 2px bar under the 52px top bar: track `rgba(62,44,44,.15)`, fill `#3E2C2C`, width = completed/total.
4. **Reset confirm (4.4):** menu item «Сбросить прогресс» opens a paper popup: «Начать заново?» / «Прогресс попытки исчезнет — вернётесь к шагу 1. Заработанные монеты останутся при вас.» / ink «начать заново» + outline «отмена».
5. **Contrast (4.5):** muted ink `rgba(62,44,44,.62)` → `rgba(62,44,44,.72)` everywhere in the player (≥4.5:1 on `#FBF1E5`).

## 9. Editor v2 (5.1–5.4)

1. **Status control (5.1):** replace the raw `<select>` with a status chip + dropdown of named actions: from «Опубликован» → «Перевести в „Тест"» (subtitle «скроется из магазина, останется тестерам») and «Снять с публикации…»; footnote «Публикация новой версии — только через панель публикации в редакторе (гейты).» Destructive transitions confirm with consequences: «Снять „{название}" с публикации?» — «✕ Квест исчезнет из магазина» / «✓ У {N} купивших доступ и прогресс сохранятся» / «✓ Версии не удаляются — можно опубликовать снова», buttons «Снять с публикации» (red) / «Отмена». Draft→Тест/Опубликован from the dashboard still routes into the publish panel (existing 400-guard becomes unreachable by design).
   **Backend fix (root cause):** owner reports the status PATCH fails on every transition (toast + optimistic rollback). Write an integration test against `setConstructorStatus`, find and fix the server fault. The UI above must not ship wrapped around a broken endpoint.
2. **Publish errors list (5.2):** the publish panel lists each gate failure as a clickable row: «Стр. 4 · не задан правильный ответ — Исправить →» (navigates to the page and focuses/highlights the field). The «Опубликовать · N ошибок» chip in the builder header opens the same list. Rail dots stay as secondary signal.
3. **Token migration (5.3/S1):** dashboard + builder on the shared controls; remove the Prata 42px greeting; heights 44–52, cards r18, one shadow.
4. **Inputs (5.4):** kill the 2px inner ring; 1px `--border` + blue focus ring. Replace «Не сохранено — хранилище переполнено» with network-honest states: header shows «Сохранено · только что» / amber «Нет сети — правки не сохранены. Повторим автоматически.» (auto-retry on reconnect).

## 10. Admin v2 (6.1–6.3)

1. Search placeholder: «Почта или имя…» (6.1). Query-type detection logic stays.
2. List: label «{N} пользователя · новые сверху»; classic pagination, 25 per page, «1–25 из {N}» + page buttons (6.2).
3. ≥1024px: master-detail — list (460px) left with selected row highlighted (blue left bar), profile panel right: identity header (name, email, «зарегистрирована {дата}»), role block (pill segmented «Игрок/Редактор/Админ» + existing draft → confirm sheet → toast flow; self-role change stays blocked/409), summary counts (покупки / монеты / пройдено) if cheaply available (6.3). Below 1024: current single-column stack.
4. Controls on shared tokens (S1).

## 11. Reviews backend feature (v1 — minimal)

- Data: optional `review_text` (≤ 500 chars) attached to the existing finale `quest_rated` fact; author first name derived from account display name (anonymous → «Игрок»); timestamp month shown.
- Finale screen: after the star tap, reveal optional textarea «Пара слов для будущих игроков?» + «Отправить» (skippable, never blocks «что дальше» — same principle as the rating itself).
- API: reviews included in the product-page payload (newest first, paginated by 10). No moderation in v1; no author replies.
- Product page consumes it per §3.5.

## 12. Backend task summary (new/changed endpoints)

1. `POST /api/auth/identify { email } → { exists }` (rate-limited) — §6.1
2. Password reset: token + 6-digit code issue, `POST /api/auth/reset` accepting either credential — §6.2; transactional email infra
3. Email confirmation: send on register; the mailed link opens `/auth/confirm?token=…` which calls `POST /api/auth/confirm { token }`; sets `email_confirmed_at` — §6.3
4. Change password endpoint — §7.3
5. Delete account endpoint with editor-published-quests block — §7.4
6. FIX `PATCH` constructor status (currently always fails) — §9.1
7. Per-quest manifest route + cover→icon generation (192/512 maskable) — §5
8. Reviews: store text with `quest_rated`, expose on product payload — §11
9. Product page payload: description, author name + published-quest count, snapshot-derived chips, aggregates for the hero facts row — §3.1, §2.3
10. Admin users pagination (`?page=`, 25/page, newest first) — §10.2

## 13. Suggested order (dependencies, not ROI)

1. §0 tokens + §1 layout (everything renders on them)
2. §12.6 status-PATCH fix (broken today) + §9 editor UI
3. §3 product page + confirmation sheet + §2 storefront changes (needs §12.9)
4. §4 My Quests + §5 per-quest PWA (§5 depends on §12.7)
5. §6 auth (needs §12.1–3) + §7 profile (needs §12.4–5)
6. §8 player + §10 admin + §11 reviews
7. `/privacy`, `/terms` static pages close S4 at any point

Every item ships with: unit tests for pure logic (projectors, label plurals, gating), component tests for state flows (sheet states, download states, status confirm), and no `href="#"`, no `alert()`, no dead controls left in the tree.
