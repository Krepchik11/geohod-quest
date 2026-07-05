# Editor v2.dc.html — extracted notes

## Dashboard header (h72, white, border-bottom #E9EBEF)
Logo mark + «Конструктор квестов» (15px uppercase .06em #122947). Right: «maria@gmail.com · редактор» 13px #5B6373 + quiet pill «Выйти» h44 r22 1px #DEDEDE.

## Dashboard body (bg #F7F8FA, pad 28 32 40)
- h2 «Ваши квесты» 24/600 #122947 + primary «+ Новый квест» h48 r24.
- Controls row: search input h44 r10 1px #DEDEDE «Поиск по названию…» (max-w 420) + filter select h44 r10 «Все статусы».
- Quest row card: white r18 card-shadow, pad 16 22 16 16, gap 18: cover 96×68 r10 (fallback navy + Prata «?»); name 15.5 bold + meta 12.5 #83858C «12 страниц · версия 4 · обновлён 28.06.2026» (draft: «ещё не опубликован»); STATUS CHIP h36 r18 pad 0 14 12.5/700 with 7px dot + ▾ (published: bg rgba(31,138,91,.1) #1F8A5B; draft: bg #EDEFF3 #6E7079 dot #9AA0AC); actions: «Редактор» h44 r22 inset 2px blue; «Запустить»/«Тест» h44 r22 quiet 1px #DEDEDE.

## Status menu (dropdown, w300 r14 border #E3E6EC shadow 0 18px 44px rgba(18,41,71,.18), p8)
- Header «СМЕНИТЬ СТАТУС» 11px uppercase .08em #83858C.
- Item: title 13.5 bold + subtitle 12 #83858C, r10, hover #F4F6FA. From published: «Перевести в „Тест"» / «скроется из магазина, останется тестерам»; «Снять с публикации…» (red #C0395C) / «с подтверждением последствий» (hover rgba(231,90,124,.06)).
- Footnote box bg #F7F8FA r8 11.5px: «Публикация новой версии — только через панель публикации в редакторе (гейты).»

## Confirm dialog (unpublish)
Card r16 p20 shadow: bold 16 «Снять «{название}» с публикации?»; consequences 13px #5B6373: «✕(red) Квест исчезнет из магазина» / «✓(green) У {N} купивших доступ и прогресс сохранятся» / «✓ Версии не удаляются — можно опубликовать снова»; buttons: destructive h48 r24 bg #C0395C «Снять с публикации» (flex1) + quiet h48 «Отмена».

## Publish errors list (5.2)
Panel: «Панель публикации» + chip «2 ошибки» h26 r13 bg rgba(180,83,9,.1) #B45309 12/700.
Error row btn: 1px rgba(231,90,124,.35) r10 bg rgba(231,90,124,.05), pad 10 12: «**Стр. 4**(red) · не задан правильный ответ» 13px + right «Исправить →» blue 12.5/600. OK rows: «✓(green) Обложка и название» 13px #5B6373. Disabled publish btn h48 r24 bg #E9EBEF color #B9BDC7 «Опубликовать версию 5».
Click error → navigates to page and highlights field. Same list from «Опубликовать · N ошибок» chip in builder header.

## Builder fields (5.4)
Label 12.5/600 #5B6373; input h44 r10 1px #DEDEDE; focus 1.5px blue + 3px ring. Offline notice: r10 bg rgba(180,83,9,.08) #7A4A0B 12.5px «Нет сети — правки не сохранены. Повторим автоматически.» Header save state «Сохранено · только что».

## Notes
- 5.1: raw select → status chip + named action menu; destructive with consequences (grants model keeps buyers' access). Publish only via gated panel. + backend fix.
- 5.3/S1: dashboard+builder on Jost, pills h44–52, cards r18, fields r10; Prata 42px greeting removed (Prata stays storefront + paper).
- Keep: live preview, state toggles, «Тест с этой страницы», status colors, skeletons, empty states.
