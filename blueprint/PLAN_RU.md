ПЛАН

Фаза 1 - Lock модели
- propagate latest в 01 03 04 00 06 07 (GameStep shape, факты, клиент visuals, FeedbackReport, spec бандла)
- re-est 5mb с реальными комиксами/nav/audio
- export реальных квестов (556 шагов + 2-3 полных) для goldens + валидации

Фаза 2 - Типы + Goldens
- shared types (GameStep expanded, AttemptFact, CoinFact, FeedbackReport)
- pure fns: isAnswerCorrect, validateForPublish, projectState, serializeSnapshot
- goldens из реальных квестов (прохождения, гонки, клиент flows)

Фаза 3 - Impl срезы
- build: ctor (4 пикер, зоны ролей, гейты, test player)
- play: PWA оффлайн (кэш бандла, локальный лог+проекция, рендер 4 шаблонов, попап, кнопка нав)
- sync: append фактов, проекторы, коррекции
- коммерция: гранты + market peer

Фаза 4 - Полировка
- импорт YAML в ctor power
- аналитика per version
- админ stats (гранты, попытки, репорты по шагу)
- миграционный job (synthetic legacy + факты)

Cuts:
- нет real$ монет v1
- нет внешних авторов
- нет magic auth legacy
- нет ветвления
- нет data retention GDPR

Риски для проработки:
- размер бандла
- скорость ctor с новыми полями
- frozen плохие visuals (гейты + аналитика)
- гонки sync новых flows (факты обязательно)
- abuse рейтинга

Следующее немедленное:
- обновить primary business docs из этого blueprint
- прогулка по реальным данным
- старт shared types

Все старые business/analysis/docs = только исторические. Это = текущая правда.