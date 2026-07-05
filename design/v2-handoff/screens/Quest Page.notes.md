# Quest Page.dc.html — extracted implementation notes (source: design project)

Route: `/quest/[id]/about`. Desktop: grid `1fr 380px`, right column sticky top:24px. Mobile 390: back header «← Магазин», sticky bottom purchase bar (replaces tab bar).

## Desktop left column
- Cover: h360, r18.
- Meta row (13px, navy, opacity .6): 📍 «Белград, Дорчол» · 🕐 «2–3 часа пешком» · ★ «4.8 · 24 оценки».
- Title: uppercase, letterspacing .12em, 30px, #122947.
- Description: 15px/1.7 (store description from constructor).
- Chips (h32, r16, 1px #DEDEDE, 13px): «12 страниц» «4 задания» «подсказки за монеты» «работает офлайн».
- Author card: dashed 1px #DEDEDE r14, avatar 48 round, «**Мария К.** — автор квеста / 3 квеста в магазине».
- Reviews: h3 «Отзывы игроков» + «24 оценки · 9 с отзывом»; review cards bg #F7F8FA r14: bold first name, gold stars (#E7A934, off #D9DDE4), muted month «июнь 2026», text 14px/1.6.

## Order card — not owned
White r18, card shadow, p24, gap16:
- Row: «Квест целиком» (14px muted) / **890 ₽** (26px).
- Benefits (13.5px, green ✓ #1F8A5B): «Доступ навсегда, попытки не ограничены» / «12 страниц · 4 задания · подсказки за монеты» / «Скачивается и работает офлайн».
- Button h52 r26 blue: «Купить за 890 ₽».
- Caption 12px muted: «Дальше — шаг подтверждения. Покупка привяжется к этому устройству; [войдите], чтобы сохранить её в аккаунте.»

## Order card — owned
- «✓ Квест куплен» green 14.5 bold.
- Primary h52 «Пройти квест» → player.
- Download row: 1px #E9EBEF r12, spinner (2px #C9D6F8 / top #3B71FE), «Скачиваем для офлайна · 12 из 18 МБ» 12.5 bold + 4px progress bar (#E7EAF0 track, #3B71FE fill).
- Secondary h48 r24 inset ring blue: «⊕ Установить на телефон».
- Caption 11.5px: «Появится на экране «Домой» с названием и обложкой квеста и откроется сразу в игру.»

## Mobile
- Header 56px «← Магазин»; cover 240px; meta condensed («2–3 часа», «4.8 · 24»); chips condensed («офлайн»).
- Sticky bar: bg rgba(255,255,255,.96), border-top #E9EBEF, pad 12/20/24: col («навсегда» 11px muted / **890 ₽** 20px) + flex button h52 «Купить».

## Confirm sheet (mobile bottom sheet / desktop centered 440px modal)
Order: grabber 40×4 #D9DDE4; h3 18px «Подтвердите покупку»; quest row (thumb 64×48 r8, bold name 14.5, «Белград · 2–3 часа · доступ навсегда» 12px muted); price row bg #F7F8FA r12 «К оплате» / **890 ₽**; link «Есть промокод?» (blue 13px);
ANON warning box bg rgba(180,83,9,.08) r12 text #7A4A0B 12.5: «⚠ Вы не вошли: покупка привяжется к этому устройству и потеряется при смене браузера. [Войти]»;
primary h52 «Подтвердить — 890 ₽»; text btn h44 muted «Отмена».

### Promo expanded
Input h48 r12 1px #DEDEDE + secondary btn h48 «Применить». Discount row bg rgba(31,138,91,.07) r12: «Промокод −20%» green / `<s>890 ₽</s>` **712 ₽**.

### Pending / error
Pending: button disabled bg #9DB6F8 with white spinner «Оформляем покупку…».
Error: box bg rgba(231,90,124,.08) r12 color #C0395C «Не получилось оформить покупку — проверьте связь и попробуйте ещё раз.» + primary «Повторить — 890 ₽».

## iOS install instruction sheet
Card 1px #E9EBEF r16: quest thumb 44 r10 + bold «Квест — на экран «Домой»»; steps 13px: «1. Нажмите **Поделиться** в панели Safari / 2. Выберите **На экран «Домой»** / 3. Иконка квеста откроет игру сразу — даже офлайн»; button h44 r22 bg #F1F3F7 «Понятно».

## Notes panel (from design)
- Card in shop (cover, title, «О квесте») → this page. Player only via «Пройти квест» after purchase.
- «Купить» (card fast-path AND here) opens confirm sheet: sum, promo collapsed (checkout already accepts coupon_percent), anon warning. Charge only on «Подтвердить».
- Post-purchase: stay on page; order card flips to owned; bundle auto-downloads (progress visible); «Установить на телефон» appears (per-quest PWA).
- Reviews: backend v1 — optional text with final rating; newest first, name + month, no moderation. Before it ships block shows only «★ 4.8 · 24 оценки».
- Free quest: «Получить» without sheet — instant grant, order card straight to owned.
- Desktop sheet = centered 440px modal, same anatomy.
