СПЕК

GameStep:
  completion: { mode: physical|answer, acceptable?: string[], allow_note?: bool }
  supporting: {
    gift?: {coins, narrative},
    hint?: {cost, reveal},
    navigator?: {lat,lng,label, hint_only?},
    bonus_animation?: {asset, voice?},
    physical_action?: {desc, confirm_label?}
  }
  media: { task?, character?, hint?, atmosphere? }  // роли комикса на страницу

Шаблоны (основные):
  first, task_no (физ), task_with (ответ), continue

Ответы:
  список строк из multiline
  клиент membership match

Физ:
  uniform confirm "I did it"
  optional note + метаданные действия
  без proof v1

Подсказки:
  только попап неправильного ответа на задание с ответом
  без отдельной кнопки

Монеты:
  earn: подарки + бонусы заданий (заморожены в снапшоте)
  spend: подсказки (только попап)
  рейтинг: derived net + optional post spend

Фидбек:
  FeedbackReport: меню на любой странице "Оставить отзыв" (ошибка, контекст шага)
  Review: после прохождения оценка+коммент
  оба synced

Бандл:
  полные GameSteps + plain acceptable + замороженная поддержка + роли комиксов + nav + anim refs

Locked (08 + клиент):
- клиент полный локальный val без reval
- физ uniform confirm
- ответы simple multiline
- ctor save+test player
- монеты только от игры
- single buy
- ~5mb
- нет ветвления v1
- event факты прогресс
- 3 компонента market/quest/build
- 4 шаблона основные
- комикс на страницу 4 роли
- кнопка нав optional
- аним voiced бонусы + рейтинг
- подсказки только попап
- фидбек на любой странице

Коммерция:
  грант пожизненный (pay|coupon|free|admin)
  source audit
  optional per-dl ticket

Версия:
  publish = новый снапшот
  retain historical для активных попыток
  synthetic legacy при импорте