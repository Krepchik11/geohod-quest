# My Quests v2.dc.html — extracted notes

## Desktop row (white r18 card-shadow, pad 18 24 18 18, gap 20)
- Cover 124×92 r10 (fallback navy + Prata «?»). Badges on cover top-left 8,8: «⭳ офлайн» h22 r11 bg rgba(18,41,71,.85) white 10.5/700; completed: «Пройден» bg #1F8A5B.
- Body: h3 16/600 + optional update chip «Доступно обновление · обновить» h26 r13 bg rgba(59,113,254,.1) #2E5FE3 11.5/600.
- Meta 12px opacity .55: «Белград · 2–3 часа · попытка от 28.06.2026» / «не начат» / «пройден 15.06.2026».
- In-progress: progress bar h6 r3 track #E7EAF0 fill blue + «шаг 3 из 12» 12.5/600 blue (max-w 440).
- Downloading: spinner 15px + «Скачиваем для офлайна · 7 из 14 МБ» 12/600 blue + 4px bar (max-w 340).
- Not downloaded: quiet pill h34 r17 1px #DEDEDE 12.5/600 «⭳ Скачать для офлайна · 18 МБ» (hover blue).
- Completed: «Ваша оценка ★★★★★» (13px, label #83858C, stars #E7A934).
- Right col w200: ONE CTA h52 r26 («Продолжить» / «Начать» primary; «Пройти заново» secondary inset-ring) + text button «⊕ На экран „Домой"» h36 r18 blue 12.5/600 (hover #EFF4FF).

## Collection states
- Load error: centered card: «Не удалось загрузить коллекцию. / Проверьте подключение — и попробуем снова.» + primary h44 «Повторить».
- Empty: «Пока пусто. Выберите первый квест — и город станет игрой.» + «В магазин квестов» h44.
- Toast (instead of alert): pill h48 r24 bg #122947 white 13px shadow, inline action «Повторить» #8FB0FF 700.

## Mobile (bg #F7F8FA; header h64 white: «мои квесты» display 17px + avatar 40)
Card = shop-card anatomy: cover h150 with status badge top-left («В процессе» blue / «Не начат» white bg rgba(255,255,255,.92) / «Пройден» green), «⭳ офлайн» top-right, progress 5px bar along cover bottom (track rgba(255,255,255,.4)); body: h3 16/600, meta 12px «Белград · шаг 3 из 12 · попытка от 28.06.2026», CTA h48 r26, utility button h40 («⊕ На экран „Домой"» text-style / «⭳ Скачать для офлайна · 14 МБ» quiet 1px border).

## Notes
- 2.1 one button per row; restart only in player start gate.
- 2.2 offline button → progress in same slot → cover badge; auto-download post-purchase; error toast w/ Повторить.
- 2.3 error state with button; dates with year.
- 2.4 install banner deleted; global install → Profile; per-quest «На экран „Домой"» (manifest id/scope/start_url=/quest/[id], icon from cover).
- Keep: status model, update chip without version numbers, real player rating instead of 5 constant stars.
