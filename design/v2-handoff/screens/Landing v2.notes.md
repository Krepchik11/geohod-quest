# Landing v2.dc.html — extracted implementation notes

## Desktop header (h96, was 120)
Container fluid: max-width 1240, padding-inline clamp(20px,4vw,42px). Logo + nav (главная / магазин квестов / мои квесты / контакты; active = border-bottom currentColor) + auth slot:
- Anonymous: pill link «Войти» h44 pad 0 26, r22, inset ring 2px blue, blue text, hover #EFF4FF.
- Signed: avatar circle 44px, 1px #DEDEDE border, user icon, green presence dot 12px #1F8A5B at top-right (2px white border).

## Mobile header (h64, pad 0 20)
Logo (26/46) left + auth slot right (Войти pill h40 pad 0 20 r20 / avatar 40 with 11px dot). NO hamburger, NO inline nav — navigation via bottom tab bar.

## Hero
Overlay rgba(255,255,255,.28) (mobile .3). Title 40px (mobile 24) uppercase #122947; subtitle 15px «откройте город с новой стороны»; facts row 14.5px/500 #122947: «12 квестов · 4 города · ★ 4.8 — средняя оценка игроков» (mobile 12.5px, «4.8 средняя оценка»); CTA h52 r26 w272 «Выбрать квест» (mobile full-width). Hero heights: 480 desktop / 350 mobile.

## Features
Grid repeat(2, minmax(0,360px)) gap 24×48; mobile single column gap 14. Card: white r18 card-shadow, flex gap16 pad16. Photo slot 80×80 r8 (mobile 64) — PLACEHOLDER: repeating-linear-gradient(45deg,#E9EDF4 0 10px,#F4F6FA 10px 20px) + mono label («фото: экран квеста в руке» / «фото: компания на прогулке» / «фото: деталь старого города» / «фото: скрытый двор / место»). h3 16px/600; p 14px.
Copy per SPEC §2.4.

## Shop cards (303px, r18)
- Cover (a → /quest/[id]/about) h220 (mobile 200).
- Meta: pin city + clock duration (12px, opacity .5).
- Title 18/600 min-h 44, link → about.
- Rating: star 17×16 gold, b avg, «(24 оценки)» opacity .5; none → «Нет оценок».
- NEW link: «О квесте и отзывы →» 13px/500 blue, mt10, hover underline.
- hr, footer: price 20/700 (or «Бесплатно»; owned: «Куплен» 16/700 green) + btn w160 h52 «Купить»/«Получить»/«Пройти» (a).
- Owned cover badge: top-left 12,12: h24 pad 0 10 r12 bg rgba(255,255,255,.92) green «✓ Куплен» 11/700.

## In-card purchase status fragments (1.2)
- Pending: button h44 r22 bg #9DB6F8 spinner + «Оформляем…».
- Success: price slot «✓ Квест в „Моих квестах"» green 12.5/600; button «Пройти».
- Error: red line 12px #C0395C below price row: «Не получилось оформить покупку — попробуйте ещё раз.»

## Footer (bg #232323)
Row: logo white + «авторские квесты» uppercase 13px .14em opacity .85.
Grid 1fr 1fr 1fr: col1 mail + phone (tile 40 r8 blue, label 13px opacity .85 «geoquest@gmail.com», «+381 (062) 888 88 88 · мессенджеры»); col2 geohod.ru + t.me/serbia_progulki; col3 justify-end: «Политика конфиденциальности» /privacy, «Пользовательское соглашение» /terms, «© 2026 GEOHOD QUEST» 12px opacity .55. NO payment icons.
Mobile: stacked, links 13px.

## Bottom tab bar (mobile <768)
Fixed bottom + safe-area, h64, grid 3 cols, shadow 0 -4px 20px rgba(26,43,72,.08). Tabs: Магазин (grid-of-4-squares icon) / Мои квесты (3 bars) / Профиль (person dots). Active: blue #3B71FE, 11px/600; inactive #83858C 11px/500. Hidden on player, /quest/[id]/about, editor/admin.
