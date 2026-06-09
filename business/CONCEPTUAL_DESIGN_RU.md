# КОНЦЕПТУАЛЬНЫЙ ДИЗАЙН ПРОЕКТА GeoQuest (Полная концептуальная модель, v1)

**Статус:** Комплексный standalone-документ. Синтезирован на основе всех завершённых ANALYZE-отчётов (GameStep / Coins / Constructor / Offline / Progress/Sync), бизнес-документов (00, 01, 03, 04, 06, 08, 02, 07, 09), FINAL-BEST-PRACTICE-BLUEPRINT.md, SYNTHESIS-NOTE-GAMESTEP-COINS-CONSTRUCTOR.md, review-*.md, вариантов (gamestep-completion-variants, coins-economy-variants, constructor-authoring-variants, offline-model-variants, progress-attempt-sync-variants, sync-recording-variants, migration-import-variants, versioning-publishing-variants и др.), client requirements (06_V1_REQUIREMENTS..., 00_PRODUCT_VISION..., 08_DECISIONS_LOG + locked решений), mismatch-анализов и разрешений (07, analyses, blueprint). 

**Методология:** Параллельный adversarial процесс (deconstruct/expose/rebuild/self-critique + cross-slice synthesis + main-thread review). Конвергенция на best-practice под жёсткими ограничениями (TDD/SOLID/DRY/KISS/YAGNI + extreme skepticism). Всё grounded исключительно в бизнес/ + discovery/ (старое Bubble — cautionary tale, не spec). 

**Цель:** Максимальная документация того, **что проект будет собой представлять** и **почему** (business/domain/architecture concepts, invariants, why vs old mess и альтернатив). Нет кода. Фокус на концепциях, инвариантах, процессах, рисках, разрешениях mismatches к client req.

**Ключевые принципы (синтез из всех срезов):**
- Контент и семантика — versioned immutable snapshots на момент публикации (frozen для попыток, стартовавших против них).
- Клиент авторитетен для lifetime своего snapshot (полная локальная валидация, без re-val correctness на sync) — но с tamper-evident receipts/hashes + сервер записывает факты для аудита/аналитики.
- Прогресс/заработки — append-only facts/events (idempotent, replayable, conflict-free merge на multi-device/offline).
- Rich content — главный дифференциатор опыта/атмосферы; completion rules + supporting — маленькие данные.
- Один чистый GameStep shape (без 14 Page_types, без 36-field multilingual explosion, без answer_card flag bag).
- Конструктор — маленький, typed, data-first (lean form+list baseline + strengthened gates + план импорта); публикация — «жёсткий» явный шаг, производящий bundle shape.
- Экономика — лёгкая, но robust (event facts, не mutable scalars; snapshot-frozen amounts; per-attempt tracking + global projection).
- Коммерция — простые lifetime grants (idempotent, source-audited, single checkout v1).
- Все срезы сходятся на: explicit publish для версии, сервер хранит historical snapshots/manifests (indefinite для active attempts), клиентский bundle — контракт для offline.
- Событийно-ориентированный для прогресса/монет (иммутабельные факты, проекции); снапшоты версий для оффлайн/заморозки; PWA offline-first; события для синхронизации и аудита; clean aggregates без legacy bag-of-flags; robustness к расам multi-device/offline/version drift; maintainability (маленькие компоненты, shared с player); elegant design.

---

## 1. Введение и видение продукта

Проект GeoQuest — это платформа для создания, распространения и прохождения **локационных приключений с шагами** (geo-quests) в формате последовательных реальных или нарративных игровых опытов. 

**Три ключевых компонента продукта (интегрированная система):**
- **Маркетплейс / Каталог** — витрина для игроков: поиск/просмотр квестов, покупка (или бесплатное/по купону добавление), управление коллекцией, доступ к скачиванию и запуску.
- **Квест (игровой плеер)** — PWA-приложение для смартфона (installable), обеспечивающее полное прохождение линейной последовательности шагов **в полностью оффлайн-режиме** (скачивание self-contained bundle ~5 МБ). Поддержка физических подтверждений на локации, ввода ответов с локальной валидацией, трат монет на подсказки (навигатор/гео/контент), наград, синхронизации фактов по возвращении в сеть.
- **Конструктор (Quest Constructor)** — внутренний инструмент для администраторов/авторов (MVP): создание/редактирование/публикация линейных квестов на основе 4 шаблонов страниц + rich content (текст + графика в комикс-стиле + навигатор). Явная публикация версий с заморозкой снапшота.

**PWA для смартфона как основа доставки:** Полноценная Progressive Web App с offline-first архитектурой (Service Worker, Cache API, IndexedDB). Игрок скачивает bundle квеста (контент + правила + медиа) один раз и проходит большую часть (или весь) опыт без сети. Синхронизация прогресса, монет и фактов — при reconnect (idempotent, с явными коррекциями). Локационные приключения: шаги привязаны к реальным местам (geo display-only для v1, без geofencing enforcement); игрок физически перемещается, выполняет действие/наблюдение и подтверждает в приложении.

**Видение (из 00 + 06 + blueprint):** Внутренняя команда эффективно производит контент (21+ квестов сегодня, линейные последовательности ~26 шагов в среднем из 556 page_constructor). Игроки покупают lifetime-доступ (или получают бесплатно/по купону), скачивают, проходят оффлайн с атмосферой (rich comic-style графика, нарратив, физические задачи), тратят/зарабатывают монеты, replay'ят с reset/continue. Система robust к реальным условиям (offline дни/недели, multi-device, version drift, импорт legacy). Всё проще, чище и maintainable, чем старый Bubble (47 типов, 1163 imperative workflows, mutable без версий, scattered mutations, zero offline design).

**Ключевой trade-off (принятый, из 08 + 03 + analyses):** Offline + client-as-judge (полная локальная валидация против snapshot) vs server re-val. Принято: client authoritative для своего snapshot lifetime (no re-val на sync); старые попытки frozen к своей версии (buggy content живёт вечно для тех, кто стартовал на ней). Mitigation: strengthened gates в конструкторе, per-version analytics, editor live tests, event facts для аудита/коррекций.

---

## 2. Целевая аудитория и роли

**Игроки (Players):**
- Основная аудитория: пользователи смартфонов (Android/iOS via PWA), интересующиеся локационными приключениями, квестами в реальном мире, нарративными историями с элементами исследования/пазлов.
- Поведение: просматривают каталог, покупают (или добавляют free/по coupon), скачивают bundle, проходят линейную последовательность шагов оффлайн (перемещение + действие/подтверждение или ввод ответа), тратят монеты на подсказки (навигатор/гео/доп. контент), зарабатывают монеты за подарки/завершение, replay'ят (multiple attempts independent, reset/continue), оставляют отзывы/оценки/репорты багов после.
- Ограничения v1: email+pass auth (MVP; legacy Telegram — post); lifetime grants; single-quest checkout; Russian-only контент; лёгкая экономика монет (только hints, no real$ purchase v1).
- Ожидания: seamless offline (даже long-play), честный баланс монет (no lost/double), атмосфера (rich content дифференцирует даже "одинаковые" physical steps), replay без потери banked rewards.

**Администраторы / Авторы квестов (Administrators, internal team only):**
- Роль: полные права на контент (Quest Content context), просмотр stats (grants, attempts per version, reviews, coin totals), управление купонами/free quests, базовый мониторинг.
- Используют Конструктор: создают/редактируют/публикуют линейные квесты (metadata + ordered GameSteps в 4 шаблонах), загружают comic-style изображения/видео, настраивают ответы/подсказки/навигатор/монеты за gifts, явная Publish (снапшот + bundle), превью ("save + switch to real player as test user" — acceptable MVP).
- Нет external authors v1 (cut per 06/00/08); только internal.
- Ожидания: velocity для small team (шаблоны + structured editors + gates снижают ошибки); "hard to publish bad" (механические ошибки — blanks/dups/mismatches/geo/media — ловятся до Publish, т.к. frozen snapshots amplify cost); maintainable сам конструктор (small focused components, shared с player, no god).
- Базовые stats read-only для принятия решений (популярность, completion rates, wrong answers per version для улучшения vN+1).

**Другие (минимально):**
- Нет "Author" роли (внешние — future).
- Identity минимальна (email+pass для Player/Admin).
- Нет сложных permissions (crisp: Admin vs Player).

---

## 3. Основные доменные концепции и агрегаты

**Ограниченные контексты (crisp boundaries, ~5 вместо old 47-type sprawl):**
1. **Quest Content** — authoring, GameSteps, версии/снапшоты. Owned by Admins.
2. **Player Access & Commerce** — grants, покупки, купоны, free. Производит право на игру.
3. **Play & Progress** — QuestAttempt, события прогресса, оффлайн bundles, траты монет, отзывы. Поддерживает disconnected.
4. **Catalog & Discovery** (thin) — публичный вид опубликованных квестов.
5. **Identity** (minimal) — игроки и админы.

**Ключевые агрегаты и сущности (концептуальные, из 01 + refinements из analyses + blueprint):**

- **Quest (Aggregate Root, Quest Content context):**
  - Метаданные (название, summary, preview image, base price RUB nullable/0, difficulty, age guidance, city/tags, geo start, stats denorm).
  - Статус (Draft/Published/Archived).
  - Содержит ordered sequence of GameSteps.
  - Published versions / snapshots (immutable на publish).
  - Инварианты: >=1 step для published; stable order per version; изменения не ломают retroactively старые attempts.

- **GameStep (Entity внутри Quest aggregate; сердце продукта, refined lean из ANALYZE-03 + SYNTHESIS + reviews + GAMSTEP blueprint §1):**
  - Position (integer/sortable; reorder в ctor affects draft only).
  - **Rich content primary (носитель атмосферы/дифференциации, RU v1):** title/internal name, main_text/task desc, place_text, button_text (custom per step для "I felt the cold metal" vs "observe view"), question prompt, durations, gift narrative, hint reveal text, author notes (ctor-only, excluded from snapshot/player).
  - Media: primary image(s) (comic-style графика), hint_image (coin-gated), video_ref (10-30s typical).
  - Optional geo {lat, lng} — **display-only** v1 (map pin; "show on map" после hint spend; no geofencing/proof).
  - **Completion semantics (маленькие version-frozen данные, не 14 типов/flag bag):** 
    `completion: { mode: 'physical' | 'answer'; acceptable?: string[]; allow_note?: boolean }`
    - 'physical': uniform explicit confirmation ("I did it / Found it / Completed the action" + optional short player note). Нет acceptable. Trust honesty. (Locked "no difference"; rich content + custom buttons/place/media дифференцируют.)
    - 'answer': submit value; client membership match vs `acceptable` list (из multiline ctor "one per line"; basic membership/contains MVP, normalization deferred).
  - **Supporting / additive (composable object, authoring-validated, attach to any; snapshot-frozen amounts):**
    - `gift?: { coins: number; narrative_text: string }` (award на completion этого step или terminal; frozen из ctor).
    - `hint?: { cost_coins: number; reveal_text?: string; reveal_geo?: boolean }` (per-step Buy_hint equiv; variable cost OK).
    - `media_video?: { ref }`, `terminal?: { show_review_prompt: boolean }`, `narrative_advance?: boolean` (pure continue), `is_start?: boolean`.
  - Инварианты (hardened из analyses): Exactly one primary mode per step; supporting additive + validated (no physical+answers nonsense); **all data (acceptable list, gift coins, hint cost) frozen verbatim в quest snapshot at publish**; old attempts use rules/amounts from *their* version; rich content — variable/atmosphere carrier; linear only v1.
  - Migration: old Page_type (questionnoanswer→physical, question*→answer + Answers list, gift/lead/congrats→supporting + appropriate mode) + Gift_Coins → supporting.gift + completion data. 556 steps → uniform instances.

- **Шаблоны страниц (из client req 06 + 01/04 + ctor analyses; 4 основных для линейного потока):**
  - **Первый экран / Start / Greeting:** narrative_advance или is_start; rich intro + "начать".
  - **Задание без ответа (Physical / No-answer task):** completion.mode='physical'; confirm button + optional note; supporting (gift/hint/media/geo/terminal).
  - **Задание с ответом (Answer-required task):** completion.mode='answer' + acceptable list; input + submit (local match feedback); supporting.
  - **Продолжить / Narrative / Terminal / Congratulations:** narrative_advance или terminal (show_review_prompt); gift award; end-of-quest review prompt. "Continue" для advance.
  - (Дополнительно: Media/Video scene, Error/Guidance, Hint reveal — как supporting или dedicated steps.)
  - Шаблоны в ctor: pre-fill sensible button_text, confirmation copy, etc. (Physical Observation Task, Answer/Knowledge Question, Narrative Bridge, Gift/Reward Step, Terminal/End).

- **Контент (носитель опыта):**
  - Текст (RU; rich per-step для immersion).
  - Графика в комикс-стиле (primary/hint images; comic panels для atmosphere).
  - Навигатор (geo display + map pin; reveal via hint spend — optional подсказка; display-only, no enforcement).
  - Видео (short 10-30s), narrative advance.

- **QuestAttempt (Aggregate Root — per Player + Quest + bound snapshot/version; Play & Progress):**
  - Links: Player, Quest, snapshot_id (immutable bind at start/download).
  - Status: InProgress / Completed / Abandoned.
  - Started_at, last_activity, completed_at.
  - Per-attempt aggregates: total_coins_spent_on_hints (projection of its spends), wrong_answers count.
  - Multiple independent attempts per player/quest allowed (replay); grants не consumed.
  - Инвариант: bound to specific snapshot at creation; all validation/earnings use *that* frozen data.

- **Прогресс (события / факты; append-only, не mutable state):**
  - StepCompletionFact / AttemptEvent (per (attempt, snapshot, step)): step_pos, type (answer_submitted | physical_confirmed | hint_spent | gift_claimed | terminal_reached | reset), submitted (string|null), player_confirmed (bool), claimed_is_correct (local vs snapshot.completion), coins_spent_on_hint, player_note?, client_ts, event_id (idempotency), device_id?.
  - Для физических: player_confirmed + optional note (always "correct" beyond confirm).
  - Для answer: submitted + claimed_is_correct (client membership vs snapshot.acceptable list).
  - Hint spend: 1:1 с completion; marks revealed.
  - Reset: clear completions/facts for *that* attempt only (epoch/tombstone в projection; history preserved для replay/audit).
  - Инварианты: facts immutable/append-only; client claims recorded as-is (no server override of is_correct for player outcome); versioned (carry snapshot_id); deterministic per-(attempt,snapshot,step) merge (union by key; first or policy tiebreak).

- **Монеты / Рейтинг (Coins + derived):**
  - **CoinFact / RewardEvent / SpendFact (append-only ledger; narrow facts, не full events domain per 06 cut):** player_id, attempt_id (attribution), quest_id, snapshot_id (frozen), step_pos, fact_kind ('GIFT' | 'COMPLETION_BONUS' | 'HINT_SPEND' | 'LEGACY_CREDIT' | 'CORRECTION'), amount (signed), cost_or_gift_value (frozen copy/ref), idempotency_key (attempt+step+kind+snapshot), source (sync|import|correction), created_at.
  - Earnings: exclusively from GameStep gifts (supporting.gift.coins frozen at publish) + canonical completion bonus (e.g. 5-coin; first-only per (player,quest) via unique/existence).
  - Spends: per-attempt, per-step (on StepCompletion; 1:1 fact); affect global.
  - Projection: Player.master_coin_balance = SUM(all CoinFact.amount for player) (materialized view or deterministic fold + checksum; client/server must match exactly, golden fixtures from real quests).
  - Per-attempt: total_spent (projection of its HINT_SPEND facts) — informational ("this play cost X").
  - First-only bonus/gifts: per (player,quest) ever (global, not per-attempt/per-version; completing v1 claims; v2 new gifts can award).
  - Replay re-earn: NO for same snapshot (conservative; prevents farm; new version gifts = new facts). Bonus never re-awarded.
  - Hint cost: variable per-step (from snapshot supporting); client local "can buy?" = local_projected >= cost.
  - No admin manual adjust, no real$ purchase v1.
  - **Рейтинг (Player rating):** derived/accumulated (возможно из net coins earned across quests + reviews/grades post-completion; или отдельный score из completed + avg rating). Не primary economy; lightweight. (Open detail: accumulation exact policy — per analyses, coins drive hints; rating secondary from progress/reviews.)

- **Доступ (AccessGrant, Commerce context):**
  - Player + Quest (lifetime, no expiry v1).
  - Source: Payment (YooKassa webhook, idempotent), CouponRedemption (% discount; 100%=free), FreeQuest (price=0 or is_free flag; auto-grant "add to collection"), Admin.
  - Required before create Attempt or download bundle/snapshot.
  - Grants lifetime; content changes (new versions) не revoke existing.
  - Idempotent (webhook retries, double-clicks safe).

- **Отзывы / Баги / Feedback:**
  - Post-completion: simple grade (rating) + optional text review (per attempt/quest/version?).
  - Report error/bug (in-app или post; per-version для авторов).
  - Admin visibility (stats + reviews per quest/version) для улучшения (analytics on submitted wrong answers per version mandatory для notice/correct в vN+1).
  - Не core для gameplay, но critical для quality под frozen model.

- **Другие:** QuestVersion/Snapshot (immutable full GameStep seq + plain acceptable lists + frozen supporting + integrity hash + optional audit salt/hashes metadata); MediaRef (stable для packer/cache); Player (grants list + coin ledger projection + rating).

---

## 4. Игровой процесс

**Последовательность (инициируется квестом, завершается игроком):**
1. **Browse & Acquire (Marketplace):** Просмотр каталога (search/filter by level/city/tags/price), детали квеста, purchase (single quest + optional coupon %; или free "add to collection" / 100% coupon). → Idempotent AccessGrant created (Payment/Coupon/Free/Admin recorded).
2. **Download bundle:** При наличии grant — скачать ~5MB self-contained snapshot (latest published version для new; historical для continue old attempt). Bundle = full ordered GameSteps (rich content + completion data + supporting frozen + plain acceptable lists exactly as authored + media refs + version id + integrity hash). Verify on load.
3. **Play offline (full sequence per templates; local everything):**
   - Start / Первый экран: narrative intro → advance.
   - Задание без ответа (physical): Переместиться на локацию (map pin display; optional hint spend для reveal geo/content). Выполнить реальное действие (наблюдение/прикосновение). Tap "I did it / Found it" (uniform confirm mechanism; optional short note). Local record: player_confirmed=true, claimed_is_correct (always beyond confirm), coins_spent (if hint).
   - Задание с ответом: Ввод (text/number/phrase). Client local membership match vs snapshot.completion.acceptable (basic; immediate correct/wrong + wrong counter). Record submitted + claimed_is_correct.
   - Supporting: Gift (award locally from snapshot amount на completion; narrative "prize"). Hint (spend if local_projected >= cost; reveal geo + content; 1:1 per step). Narrative advance / video / terminal (continue; terminal → congrats + review prompt).
   - Navigator: опциональная подсказка (geo reveal via hint; display-only map pin).
   - Coins: local projection from snapshot gifts + local completions (award on gift/terminal steps); deduct on hint buy. "Pending until synced" visible. Per-attempt total spent tracked.
   - Linear only: advance по позиции; no branching v1.
   - Full offline: включая multiple hints, gifts, answers, physical confirms, terminal. Long-play (days/weeks) supported (local state + bundle).
4. **Sync / reconnect:** Upload enriched facts (StepCompletions + coins_spent + revealed + local earned claims + optional audit receipts). Server: append immutable facts (idempotent by key including snapshot/step/kind), emit rewards/spends using *bound snapshot's* GameStep amounts (never live), record spends, project authoritative master balance, apply corrections (e.g. "step 7 hint overdraft/not applied; balance +1; hint unrevealed if strict"), return true projection + deltas + accepted. Client applies corrections (banner "syncing... balance corrected"; re-render). Versioned: old bundle's frozen values used locally and by server. Multi-device: facts union by key (converge; corrections on next load).
5. **Reset / Continue / Replay:** Reset = clear StepCompletions/facts for *that* attempt only (grant + banked global rewards survive; new facts start fresh; no re-earn gifts/bonus on same snapshot). Continue = resume latest/selected in-progress (using its original snapshot + authoritative facts from server; re-dl exact bundle if needed via retention). Replay = new independent attempt (pulls latest version if published since; or historical for old). Multiple attempts independent.
6. **Complete & Feedback:** Terminal + review prompt (grade + text). Post: review/rate/report error (per-version analytics for authors). Attempt → Completed. View in collection (in-progress/completed).
7. **Edge recovery:** Offline mid-quota (degraded: core text/structure; media on-demand if cached); clear client (re-dl historical snapshot by id + replay facts); version drift (facts carry v; reject mismatch; re-dl bound); corrections explicit (never silent).

**Монеты за выполнение, трата на подсказки:** Earns via gifts (per GameStep snapshot) + completions (bonus first-only). Spend only on hints (per-step cost from snapshot; geo + content reveal). Navigator как опциональная подсказка (via hint). Бонусы/рейтинг: coins + post-reviews.

**Оффлайн с локальной валидацией; синхронизация фактов:** Client sole judge vs its snapshot (no server re-val correctness). Facts for audit/replay/merge/coins.

---

## 5. Конструктор (MVP для внутренних)

**Возможности (из 04/06/08 + ctor analyses + blueprint §3 + reviews):**
- Metadata form (title, price, difficulty, tags, start geo, etc.).
- Ordered step list (summary cards: pos, mode badge, truncated text, flags media/geo/hint/gift/answers-count; drag reorder — draft only; edit/delete with warnings for published).
- Per-step structured form: completion mode picker (physical confirm vs answer list); rich content textareas; media uploaders (roles: primary/hint/video; thumbnails post-upload); geo lat/lon + sanity (mini map pin or city bounds warn); supporting toggles/subforms (gift: narrative + coins number + explicit "this freezes in snapshot for earnings"; hint: cost + reveal; video; terminal/review; narrative_advance).
- **Strengthened data entry (day-1, non-negotiable для frozen risk):** 
  - Answers: Structured AnswerListEditor (rows/chips/inputs + /X/reorder; "Paste from lines" helper splitting multiline — preserves "one per line" spirit); trim/filter blanks/empties on change/serialize; warn dups/whitespace; visual count + current values always shown; **live "Test a submission" box** using *exact* client isAnswerCorrect(submitted, currentList) fn (that ships in bundle/player for this version). " '42 ' would fail today" instantly visible.
  - Gifts: Dedicated subform (narrative + coins input + presets 0/5/10 from old patterns; UI language: "Coins + narrative snapshotted here and used for earnings on completions against *this version*").
- **Templates (palette, 4-5):** Physical Observation Task (prefill confirm UI, optional geo), Answer/Knowledge Question, Narrative Bridge, Gift/Reward Step, Terminal/End. Prefill sensible defaults (button_text, copy) from domain. Reduces "what fields?" decision.
- **Mini-previews per step / list (lightweight, shared components):** Thin wrapper over player StepView against *current draft values* (data-only; no real attempt state leak). "Continue" noop; answer input + "submit test" runs match; "buy hint (sim)" reveals; gift shows award; physical big "I did it". Catches render/layout/media per step without full play. Optional full-sequence simulator modal (fake per-attempt coin state from this quest's gifts only).
- Explicit **Publish** (big button): runs validateForPublish(draft) + warnings; creates new immutable QuestVersion/snapshot (full serializable GameStep shape with plain acceptable[] + frozen supporting amounts + integrity); triggers bundle materialization; old attempts unaffected. "Editing current draft; publish creates immutable snapshot for future players" language everywhere.
- **Pre-publish gates / checklist (strengthened "hard to publish bad"):** Pure fn validate (errors/warnings/estBundleMB). Required: >=1 step; every answer-mode >=1 trimmed non-empty; no physical+acceptable or answer+0; all required content; media for declared roles (soft). Warnings: mismatches, geo sanity fail, dups across steps, est>5MB, no terminal, gift without narrative. "Run checklist" human report; "Dry-run serialize" (exercises exact bundle path, shows JSON or "would produce valid vN"). Soft-gate (warn + "publish anyway") or hard for MVP velocity.
- Preview: "Save Draft + Test in real player" (persists draft, creates/finds test grant for admin, opens real /quest flow or ?test=1; fulfills locked acceptable; exercises full stack: PWA, real attempt, real coins from *this* snapshot gifts, real sync, real offline). No embedded high-fid live preview required at launch (per 08).
- Import tab (power path, V3): paste YAML/JSON (or Markdown frontmatter; or file drop) → strict parse/validate (errors with line nums) → load/merge into composer list. "Export current as YAML" for roundtrip/audit/source control. Preferred for migration (old page_constructor transform → YAML → import → validate → publish as v0 legacy snapshots).
- Basic stats read-only (per quest: grants, attempts with version, reviews, coin totals).
- Version awareness: edits affect *next* version only; published retain historical steps for active attempts (no cascade).

**MVP success (06):** Internal admin can create complete quest with mix physical/answer steps, publish, preview end-to-end (via real player).

**Maintainability of ctor code itself (explicit mandate):** Small focused components (StepTemplateLibrary, SequenceComposer/list, StepEditorPanel per-kind or config-driven, AnswerListEditor self-contained with matcher, GeoMediaEditors reusable, MiniPlayerPreview thin over shared <PlayerStep isPreview/>, PrePublishValidator pure fn, useDraft hook). Heavily typed (discriminated on mode + supporting keys; no impossible states). Shared renderers with player (DRY, consistency). No god components (no 55/63 WF reusables equiv). Testable in isolation (validator unit tests; matcher tests). Readable: dev reads StepEditorPanel → understands whole model.

**"Hard to publish bad" (amplified by frozen snapshots):** Raw multiline + no gates = too easy (blanks → empty matches; dups; punct; bad geo 0,0 or wrong city; missing media silent; kind/answers mismatch; gift coins nonsense). Strengthened (structured + live test + previews + gates + checklist) makes mechanical errors harder/impossible than in old (no enforced gates; relied on author + scattered logic). Semantic still possible (bad puzzle), but tools better (mini, test matcher, analytics per-version mandatory).

**Staged path (lean base + immediate high-ROI correctness; hit success fast):** 1. Shared types/serializer/validator/matcher first (GameStep, serializeToSnapshot, validateForPublish, isAnswerCorrect — pure, testable; used by ctor/player/bundler/tests). 2. Lean surface (form + list + structured answers editor + gift subform + Save + Publish calling validate+serialize). 3. "Test in real player". 4. 3-5 templates. 5. Per-step minis + sanity (map/media thumbs/parsed list preview). 6. Pre-publish checklist + dry-run. 7. Import tab. 8. Later: richer if metrics demand (respect no high-fid lock). Evolutionary; components additive.

**Trade-off accepted (from ctor reviews + blueprint):** Deliberately exceed "minimal form + raw multiline" in data entry/gates because cost of *not* (frozen bad for real paid players under offline snapshot) > added (still maintainable) code. "Acceptable" preview + pure lean creates UX debt/quality tax (iteration minutes per tweak; authors skip tests on 5MB media quests → subtle bugs frozen permanently). Mitigate with authoring-time surfaces + measure real velocity/defect rate post-MVP; evolve if needed.

---

## 6. Маркетплейс / Каталог

- **Browse/Discovery:** Public view of published quests (thin Catalog context). List/detail: metadata, price (or free flag), difficulty, preview, summary, stats (completed count, avg rating). Search/filter (by level/city/tags/price — should-have). Russian-only v1.
- **Acquire:** View details → initiate purchase (single quest v1; no cart) + optional coupon code (% discount; different % supported; 100% = free via coupon). Free quests: "add to collection" or auto-grant on view/play (price=0 or is_free). 
- **Grant creation:** Idempotent (webhook retries safe; double-click no dup). Sources audited (Payment external ref, CouponRedemption, Free, Admin). Lifetime AccessGrant (player+quest; no expiry v1). Content updates (new versions) не revoke.
- **Post-grant:** Immediately downloadable (bundle for latest version) or start attempt. Visible in personal collection (in-progress/completed).
- **No multi-item v1; no recurring; single checkout.**
- **Admin surface (ctor or separate):** Create/manage coupons (quest-specific or platform; limited uses); mark free quests; view grants/purchases per quest.

**Инвариант:** Grant required before any download/attempt/earn (coins from quest only if access).

---

## 7. Технические и архитектурные принципы

**Событийно-ориентированный для прогресса/монет (из ANALYZE-04/05/01/10 + blueprint + sync variants + coins review):**
- Immutable append-only facts/events (StepCompletionFact / AttemptEvent / CoinFact) как source-of-truth. Idempotency keys first-class (attempt+step+kind+snapshot+client_uuid). Unique constraints + tx/checks где numeric.
- Projection (deterministic fold): QuestAttempt current state (completions map, pos, totals); Player master balance (sum earns - spends); per-attempt spent. Materialized view + checksum job (perf); client/server fold *must match exactly* (golden tests with real quest fixtures).
- Почему: Robustness (no lost/double — natural from immutability + keys; multi-device union facts cleanly; offline provisional + server authoritative converge via corrections; versioned amounts frozen at emit from bound snapshot; replay for audit/TDD/"what was balance at D?"/import synthesis). Audit self-documenting ("this snapshot step awarded X because this completion recorded"). Vs old scattered mutations (82+9 WFs + scheduled 666 + custom states + mutable Balance_coin + flag bag on answer_card — races, no versioning, no offline, opaque timing). Maintainable: centralized logic, no accidental complexity. Fits offline (client projects from snapshot + local facts; uploads on sync); coins (earns on StepCompletion using snapshot GameStep; spends 1:1 on completions); attempts (facts per attempt+snapshot).

**Снапшоты версий для оффлайн/заморозки (из ANALYZE-01/02 + offline review + blueprint + versioning variants):**
- Explicit Publish → immutable QuestSnapshot / Manifest (full serializable GameSteps + plain acceptable[] exactly as authored + frozen supporting amounts/gifts + rich content + integrity hash + version id + optional audit metadata). 
- New attempts/downloads = latest at that instant; old bound frozen to theirs (re-dl exact via retention for cleared clients with in-progress).
- Retention: indefinite for any snapshot referenced by >=1 QuestAttempt (or was latest at grant); media refs kept while referenced. Dedup at storage (content-hash steps/answers) без изменения клиентских байт (fat/monolithic materialize on dl для простоты; normalized long-term OK).
- Почему: Client full local val against stable data (GAMSTEP/OFFLINE); frozen earnings (COINS); frozen content for started attempts (intentional trade-off). Explicit button делает versioning deliberate (vs old mutable Publish_on_the_site). Retention — cost of "old frozen + recoverability". Vs old: zero versions/snapshots/offline.

**PWA с offline-first:**
- Bundle ~5MB (text+structure+key images; videos progressive). Full play (steps per templates, local match/confirm, coins projection, hints, gifts, terminal+review) на downloaded snapshot. Service Worker cache; storage manager (list/purge cached); graceful low-end (text fallback?).
- Local state: per-attempt (completions, spent, revealed, projected balance from snapshot gifts + local facts). Pure client decisions provisional.
- Sync: facts upload (enriched); corrections returned/applied (visible UX: "syncing...", banners, re-render). Re-dl path for historical.

**События для синхронизации и аудита:**
- Facts union on merge (deterministic per (attempt,snapshot,step)); corrections explicit (CompensationEvent: spend_rejected, balance_adjust, hint_unreveal, earn_revoked, legacy_correction). Payload: StepCompletions + local claims + optional receipts. Idempotent by event_id/key. Version drift: facts carry v; reject mismatch.
- Analytics per-version (submitted answers, wrong counts, completion rates) для authors (mitigate freeze).

**Clean aggregates без legacy bag-of-flags; robustness к расам:**
- Crisp: Quest (draft + published versions); QuestAttempt (bound snapshot + events log); Player (grants + coin ledger projection); StepCompletionFact as atom; CoinFact ledger. No mutable scalars for money/progress (projection never lies; drift = projector bug). No 14 types/36-field bags/answer_card flags/47 types.
- Races (multi-device concurrent spend/earn, reset-after-earn, versioned gift drift, concurrent bonus, import reconciliation, overdraft, partial syncs, long-offline clock skew): mitigated by facts (no read-modify-write), keys/uniques, tx where needed, corrections protocol, client/server projection contract, version binding (all rewards from attempt's snapshot GameStep, never live).
- Multi-device/offline/version drift: facts carry snapshot; union + replay; re-dl exact old bundle + authoritative log.
- Maintainability: маленькие компоненты (ctor/player shared); typed discriminated (one GameStep shape + small data); DRY (serializer/validator/matcher pure fns across); KISS (data shapes over heavy objects for v1; no premature taxonomy); YAGNI (lean baseline + explicit evolution plan).

**Elegant design:** Content primary (rich per-step для atmosphere); rules minimal data (completion + supporting); events как accounting primitive; publish как deliberate versioning point; client как capable peer для своего snapshot; facts как consequence of recorded completions.

---

## 8. Ключевые инварианты

(Из всех analyses + 01/03/04/08 + blueprint + reviews; enforceable в types/tests/projection.)

- Привязка попытки к версии снапшота: QuestAttempt immutable bind к snapshot_id at start; all validation/earnings/amounts use *only* data from bound snapshot (frozen at its publish). New attempts = latest; old frozen forever (even if author fixes later).
- Клиентская валидация локальная без re-val на sync: Client sole judge vs its snapshot (physical: confirm records player_confirmed; answer: membership vs acceptable[] → claimed_is_correct). Server records submitted + claimed + local outcome as facts; *never* overrides is_correct for player/attempt outcome using post-snapshot or live data. (Record the "lie" if client bug; mitigate via editor tests + per-version analytics + audit facts.)
- Multiple attempts independent: Grants lifetime (not consumed); reset clears *only that attempt's* completions/facts (banked global rewards + grant survive); replay = new attempt (or reset of existing).
- Per-attempt coins + global reconciliation: Spends tracked per-attempt (StepCompletion.coins_spent + QuestAttempt.total_spent = projection of its facts); earnings global (projected to Player master = sum all facts for player); facts additive; no direct mutation.
- Гранты для доступа: AccessGrant (or free) required before create Attempt or download any snapshot/bundle. Grant check before earn/spend activity.
- Snapshot freeze всего: acceptable lists, gift_coins amounts, hint costs, completion rules, rich content — verbatim в snapshot; old attempts use their version's forever.
- Facts immutable/append-only: Progress/coins as facts (idempotent keys); projection deterministic (client/server match via golden); corrections explicit (CompensationEvents); no lost/double structurally.
- Idempotency & merge: Every potential earn/spend/completion carries natural key; server "if exists, return it; else append". Multi-device: facts union by (attempt,snapshot,step,key); convergent; conflicting reveals: once revealed stays.
- Version binding everywhere: Rewards/completions use snapshot GameStep data at emit/record time (never current live quest).
- Retention for recoverability: Server retains manifests + content + enough for projection/replay for any referenced snapshot (indefinite while attempts active); re-dl exact old for cleared in-progress.
- No admin money magic v1: No API/UI to create/adjust/delete facts/balances (role + no endpoints).
- No real$ coins v1; earnings only gifts/completions from snapshots.
- Constructor never mutates published: Edits = next version only; publish snapshots exact current draft shape (direct/validated path to bundle).
- Import: Historical → synthetic legacy snapshots (v0 from export-time) + facts (idempotent job; legacy_credit only for balance start; no backfill earnings from opaque old WFs; audit deltas/quarantine; post-import new system clean).
- Projection fidelity: Client local (from bundle snapshot + local facts) == server authoritative fold (test with real quest exports as fixtures; adversarial sequences for long offline + multi-dev + reset + version change).
- Grant before coin activity; facts survive reset (banked); negative only via import bugs/corrections (normal path prevents).
- Exactly one primary mode per GameStep; supporting validated no invalid combos.

**Conceptual tests (TDD enablers from reports + blueprint):** Golden fixtures (2-3 real quests: export GameSteps + simulate playthroughs with gifts/hints/answers/terminal → assert projection, no dups, frozen amounts used, client match == recorded). Property-based: random sequences offline play + sync + reset + multi-dev → never negative final, total earned == sum gifts from completed (mod first-only), versioned correct, no dup facts, convergent. Idempotent: duplicate sync/upload/completion → one fact. Version freeze: same completion on v1 emits 10 even if live changed to 0. Offline full: play entire (hints/gifts/answers/confirms) no net → sync → server facts + returned balance matches (or corrects predictably); re-load sees correct reveals/balance; bundle re-dl works. Constructor: publish emits exact shape; gates catch mismatches; test matcher == real client. Admin denied; replay no re-earn same snapshot; etc. Run in CI against sync/completion + client projection. Adversarial long-offline + races.

---

## 9. Модели данных (концептуальные ER, ключевые entities с атрибутами)

(Концептуально; из 01 + refinements 04/03 + blueprint + all slices. No legacy 36-field/14-type/flag-bag.)

- **Quest** 1—* **QuestVersion/Snapshot** (immutable on publish; full GameStep[] serialized + plain acceptable lists + frozen supporting + integrity).
- **Quest** 1—* **GameStep** (draft current; position, rich_content {title, main_text, place_text, button_text, ...}, media_refs[], geo?, completion {mode, acceptable?: string[], allow_note?}, supporting {gift?: {coins, narrative}, hint?: {cost_coins, reveal_geo, ...}, ...}, author_notes ctor-only).
- **Player** 1—* **AccessGrant** (quest_id, granted_at, source: Payment|Coupon|Free|Admin).
- **Player** 1—* **QuestAttempt** (quest_id, snapshot_id (bound), status, started_at, ... , total_coins_spent (projection)).
- **QuestAttempt** 1—* **StepCompletionFact / AttemptEvent** (snapshot_id, step_pos, type, submitted?, player_confirmed?, claimed_is_correct, coins_spent_on_hint, player_note?, client_ts, event_id, device_id?).
- **Player** 1—* **CoinFact** (ledger: attempt_id, quest_id, snapshot_id, step_pos, kind ('GIFT'|'COMPLETION_BONUS'|'HINT_SPEND'|...), amount signed, frozen_value, idempotency_key, source).
- **QuestAttempt** → **Review/Feedback** (post-complete: grade, text, version?).
- **Payment / CouponRedemption** → **AccessGrant** (audit source).
- **QuestVersion** (historical) referenced by attempts/snapshots for retention.
- **LegacyImportAudit** (quarantine, deltas vs old Balance/Getting_5/answer_cards; one-time).

ER relationships crisp per contexts. Player has projection fields (master_balance, rating?) derived from facts/grants/attempts. All versioned data self-describing (snapshot carries rules/amounts).

---

## 10. Процессы и use cases (основные)

**Игрок:**
- Browse marketplace → view details (price/grant status) → buy (coupon?) / free add → grant created → download bundle (latest snapshot) → play offline (steps per 4 templates: physical confirm after move/action, answer submit local match, hint spend popup for navigator/geo/content, gift award, terminal+review) → sync (facts + corrections) → reset/continue/replay (independent attempt or same with cleared state) → post rate/review/report.
- Collection: list grants/attempts (in-progress with pos, completed); re-dl historical if cleared.

**Админ/Автор (ctor):**
- Auth admin → list/create quest (metadata) → add steps (choose template or form: mode physical/answer + rich content + media/geo + supporting gift/hint/...) → structured answers (list editor + paste + live test match exact client fn) + gift subform (narrative+coins with "freezes" note) → reorder/draft save → mini-preview per step (shared renderer) + sanity (parsed list, map, thumbs) → pre-publish checklist/gates/dry-run (errors: mismatches/0 answers; warnings: geo/est size) → explicit Publish (validate + snapshot exact shape + bundle) → "Test in real player" (test grant + real flow) → view stats (attempts per version, reviews, wrong answers analytics per vN для fix в vN+1).

**Sync/Progress (core offline):**
- Local play → facts tail (local projection for UI/balance/hints). Reconnect → upload batch (enriched with spent/revealed/local earned) → server append facts idempotent (using bound snapshot GameStep for earns), emit CoinFacts, reconcile, corrections (overdraft → unreveal + adjust; version mismatch → reject) → return authoritative + deltas → client apply + re-project.

**Commerce:**
- Player buy → payment init (coupon validate) → complete (YooKassa) → webhook (idempotent) → create grant + record payment/redemption → player can dl/play immediately.
- Free/coupon 100% → auto grant on action.
- Admin: create coupon (limits), mark free quest.

**Import/Migration (one-time):**
- Historical buy_a_qest + payment + coupon + user (Balance_coin + Getting_5 list) + answer_card (flags only, no submitted, no v) + page_constructor (Gift_Coins + Answers + Page_type 14) + quest (countCoinMadeIt) → synthetic legacy v0 snapshots (from export-time content) + AccessGrant facts + QuestAttempt + StepCompletionFacts (best-effort from flags) + CoinFacts (legacy_credit for starting balance; no backfill earnings from opaque WFs) + audit report (deltas, anomalies, quarantine legacy_metadata). Idempotent job; manual sign-off; post-import new system clean; legacy "imported" with notes. Reconcile old Balance vs new events (log diffs, no auto-adjust).

**Admin stats/feedback:**
- Per quest/version: grants, attempts (completion rates, wrong answers submitted per vN), reviews, coin economy summary. Use для улучшения контента (frozen vN не фиксится для early players; analytics помогает vN+1).

**Error/Recovery:**
- Client bug match → recorded as client claimed (analytics flag for author); correction only for coins/overdraft (explicit).
- Version drift → re-dl bound snapshot + replay facts.
- Quota mid-play → degraded or re-dl.
- Clear client → re-dl + authoritative log replay.
- Concurrent publish during dl → consistent snapshot at bind time (tx).

---

## 11. Риски и mitigations (из всех analyses: frozen buggy content, client bugs in match, coin races, version drift, retention for old snapshots, etc.)

- **Frozen buggy/suboptimal content (answers/geo/media/kind-mismatch) for early attempters (03/01/08/07/ctor analyses):** Intentional (offline client val + no re-val). Amplified by snapshots. Mitigation: strengthened ctor (structured answers + live exact match test + parsed preview + map sanity + media thumbs + pre-publish gates/checklist/dry-run + templates); per-version analytics (submitted wrongs для authors notice/correct в vN+1); editor live test catches 80% before publish; "hard to publish bad" stronger than old (no gates). Remaining: semantic errors possible; measure preview friction (if "save+test" kills quality → evolve post-MVP).
- **Client match bugs permanently record wrong is_correct (03/08/offline review):** No re-val = client is judge. Mitigation: editor "test submit" uses *exact* client fn; property replay tests (for any list+input, match == recorded); optional audit receipts/hashes (background flag "claimed correct but hash not in set" — never overrides outcome); per-version submitted analytics; strong client tests + golden. Tamper (devtools patch) deprioritized v1 (plain strings + integrity bundle hash); future hashed/receipts if cheating rises.
- **Coin races (lost/double/negative/overdraft/multi-dev/concurrent/ reset double/ versioned drift/import inconsistency) (06/04/03/coins review/sync variants):** Old scattered mutations = debt. Mitigation: immutable CoinFacts + natural keys (attempt+step+kind+snapshot) + uniques/tx; earns emitted on authoritative StepCompletion record using *bound snapshot* GameStep (never live); spends 1:1 on completions; projection (never mutate scalar); corrections explicit (CompensationEvents; client applies "balance corrected"); client local projection contract (match server fold); import: legacy_credit only + audit (no backfill); first-only via unique (player,quest,bonus); no re-earn same snapshot; long-offline partial syncs handled by idempotency. Negative only import/correction. Monitor correction rate.
- **Version drift / multi-device / long-offline (03/01/07/sync/coins/offline):** Attempt bound + facts carry v; re-dl exact historical snapshot (retention); facts union deterministic; clock skew: server append order + device+seq primary (client_ts metadata); partial syncs: resend un-acked (idempotent); corrections on reconnect. "Continue" uses original snapshot + synced facts (not silent upgrade).
- **Retention / re-dl cost for old snapshots (03/07/01/offline/ versioning):** Required for "old frozen + recover after clear/reinstall". Mitigation: indefinite for referenced attempts (cheap: structured KB + shared media refs via dedup); policy "keep while active/recent; admin-sealable for unreferenced completed (with warning re-dl impossible)"; fat materialize on dl (simple, no assembly bug for historical); dedup server-side. For 21 quests: manageable (100s snapshots over years).
- **Import lossiness (old no versions, flags-only answer_card, no submitted text, scattered WFs, inconsistent states, content drift) (09/07/04/coins/sync/migration variants):** "Full per-step where feasible" = best-effort. Mitigation: synthetic v0 snapshots from export-time (plain lists); best-effort StepCompletions from flags + heuristics (time/countCard); legacy_credit for balance (no backfill earnings); quarantine legacy_metadata + is_legacy flag + audit report (anomalies, % mapped, deltas vs old Balance/Getting_5); one-time idempotent job + manual sign-off; post-import new clean; "imported" visible with version notes. Volumes unknown (many 404 in probes); adversarial validation.
- **Preview friction + "acceptable" lock under frozen model (ctor analyses/04/07/08/06 success):** Iteration = save + context switch + full play (minutes per tweak for 20-30 step 5MB quests) → authors batch/skip tests → quality tax → subtle bugs frozen permanently. Mitigation: authoring-time surfaces (minis + parsed previews + live tests + sanity + gates) for fast inner loop + real outer validation; measure real usage/defect (preview friction, publish reverts, wrong answers per v); evolve if kills quality (post-MVP, respect lock).
- **Bundle size / media / quota / PWA edge (03/04/08/nonfunc):** ~5MB target (images + 10-30s video); low-end pressure (multiple quests + historical attempts); eviction mid-play; 404 refs in pack. Mitigation: ctor estBundleMB in gates + dry-run; stable media refs (packer resolves without 404); progressive cache (core text/structure guaranteed; media on-demand); storage manager (purge); graceful degraded (text-only?); test on real devices; video bloat monitored. Constructor media handling must produce cacheable refs.
- **"Lightweight" economy vs robustness machinery (04/coins review):** Events add concepts/tables (but necessary for no lost/double + versioning + audit + import + multi-dev + replay); if tiny scale + no complaints, scalar + heavy tx "could work" — but design for 5+ years + import + races (old Bubble warning). Fidelity to "coins" language preserved (numeric balance UX); V4 capability rejected (product change vs 929 users/21 quests + docs).
- **Maintainability backslide / over-engineering (ctor/analyses):** Ctor StepEditor grow conditionals (enforce per-kind/config + pure validator); events "overkill" for tiny (pragmatic hybrid: facts + materialized); named rules YAGNI (refined lean data shape chosen); preview "easy to say hard to build" (respect lock, stage). Constructor code poster child for small/readable (vs old 55/63 WFs god).
- **Legacy auth migration / user friction (06/07/00):** Email+pass MVP (clean; legacy Telegram post); may lose 929 users if friction high. Mitigation: simple surface; link if supported later.
- **Scale unknown (21 quests today; design clean but not over for small-medium).**
- **Open tensions (skepticism noted):** Exact navigator integration (geo reveal via hint spend? display-only?); rating accumulation details (coins-derived? separate from reviews? per-attempt or global?); comic image per step enforcement in ctor (not strict gate yet; "primary present for declared" soft); first-only scope for gifts (per quest ever vs per snapshot? conservative no re-earn same); retention policy details (prune criteria, admin UI); exact client match rules (exact/contains/trim? — ctor test must match); bundle format (plain + integrity; optional audit salt/receipts post-MVP); sync correction policy (un-reveal on overdraft? allow temp debt?); import exact timing (gifts on step vs terminal? bonus on Complited vs You_made_it?); real quest data walk (556 steps export for validate physical/answer distrib, gift freq, 5MB composition — repeated rec across reports); "per-attempt vs global" edge cases in long replay.

**Accepted risks (deliberate, with mitigation):** Frozen content (trade-off for offline); client judge permanence (mitigated but not perfect); import best-effort (lossy by old construction); preview friction (measure/evolve); events machinery (robustness > minimal for scale/races).

---

## 12. Почему выбранные подходы (ссылки на analyses)

- **Event-sourced facts для progress/sync/coins (из ANALYZE-05 progress-attempt-sync + ANALYZE-10 sync-recording + ANALYZE-04 coins + ANALYZE-01 offline + blueprint §2/6/10 + SYNTHESIS + reviews):** Для robustness (no lost/double — immutability + keys structurally; replay/audit/import synthesis; versioned frozen amounts; multi-dev/offline convergent merge via union + corrections; "sum earns - spends" never lies (projection bug, not data)). Vs old Bubble (scattered ChangeThing in 82+9 WFs + scheduled 666 + mutable Balance_coin + flag bag + zero versioning/offline/audit = races, opaque, debt). Vs lean scalar (too easy regress to imperative mutation + optional log = recreate debt; races handwaved). Vs per-attempt wallet (UX damage cross-quest hints + conversion races + mismatch old global data). Vs capability (max robust but radical product change vs "coins"/Balance_coin language everywhere + 929 users + migration lossy + less flexible future real$). Hybrid (facts + materialized projection + narrow unique for bonus) pragmatic winner. Cross: ties GAMSTEP (earns on StepCompletion using snapshot GameStep); CONSTRUCTOR (gift_coins entry → frozen); OFFLINE (local projection + facts upload); attempts (per-attempt spends facts). Explicit policies (first-only per (player,quest); no re-earn same snapshot; variable per-step cost; legacy_credit only) lock ambiguities.

- **Hybrid refined lean GameStep (rich content primary + small discriminated completion data + composable supporting; no named "Rule" types v1) (из ANALYZE-03 gamestep-completion + SYNTHESIS-NOTE §2 + blueprint §1 + review-gamestep + ctor/coins cross):** Respects *all* locked (uniform physical confirm + optional note "no difference"; list strings answers from multiline; client offline match vs snapshot; linear; snapshot freeze; coins via gifts/completions). Content carries atmosphere (addresses "trivial confirm reduces magic" — rich per-step text/buttons/images/place differentiate physicals without model subtypes). Maintainability win vs old (one GameStep shape + tiny attached data vs 14 overloaded Page_type driving 14 specialized Slide_* reusables + 3-21 WFs each + 444 SetCustomState + answer_card flag bag + scattered coin in "steps_for_accruing_coins_" + "666"). 556 steps → uniform; migration straightforward (Page_type + Answers presence + Gift_Coins → mode + acceptable + supporting.gift). Vs pure locked lean: semantics explicit/versionable per step (better analytics); extensible (add fields to completion obj or new supporting keys for numeric_range/photo later — no mutating core or taxonomy bloat). Vs richer kinds (V2): avoids recreating taxonomy immediately (YAGNI; validate real usage from 556 first). Vs full V3/V4 objects (named rules/strategies): captures benefits (explicit per-step/version semantics, prepare future) with less ceremony (pure data shape, no indirection/premature classification; old 14 accidental, don't recreate). KISS/YAGNI/SOLID/DRY (small data, one shape, composable supporting, testable handlers). Offline/bundle fit: serializes cleanly (plain lists + frozen amounts). Constructor: direct data entry (mode picker + conditional + multiline→list + supporting fields). Cross: COINS (gift amounts in snapshot GameStep, emit on StepCompletion); CONSTRUCTOR (publish snapshots exact shape; gates for combos); OFFLINE (client val against data in bundle). Risks accepted: mild extra shape vs "two modes only" (far simpler old); rigorous validate combos in ctor. "Rich content sufficient?" unproven without export (repeated rec); model не exacerbates. Chosen post-review synthesis (leaner than subagent hybrid for KISS).

- **Strengthened ctor (lean form+list+explicit Publish + "save+test" acceptable + immediate V4 data/gates/templates/minis + V3 import plan) (из ANALYZE-07 constructor-authoring + review-constructor + SYNTHESIS + blueprint §3 + ctor cross):** Respects locked (multiline representation via paste helper; explicit Publish for version; "save+switch test player" acceptable MVP; no high-fid embedded v1; linear; internal only; produce exact bundle shape with plain answers[] for client offline val). Maintainability of *ctor code itself* (small focused/typed/shared components vs old 55/63 WF god-reusables + 36-field bags + 14-type dispatch + 1163 WFs total; order of magnitude better). Author productivity for small internal team (templates reduce setup; structured answers + live test fix #1 error hotspot fast; minis/visual check per step without full play; real player for final; batch changes + less iteration friction than pure lean). "Hard to publish bad" (highest in strengthened: mechanical errors hard past gates/structured/visualizers; vs lean lowest (relies author vigilance + minimal checks) or old (no enforced gates)). Bundle/versioning direct (draft → publish → serialize exact shape; no transform loss; ctor never mutates published). Vs pure lean: exceeds minimal in data entry (but justified; frozen risk cost > added code; staged to hit 06 success fast). Vs V2 rich preview: avoids sync complexity/divergence/state mgmt/responsive pain + respects "no high-fid at launch" + "easy to say hard to build". Vs V3 import primary: forms/templates more discoverable for non-text team (V3 power/shelfware risk); import as secondary (avoids dual source like old page vs page_constructor dupe). Mapping to old: direct attack (eliminates duplication + per-type conditionals + self-refs + manual wiring). Trade-off: staged evolution; "UX debt from acceptable+lean under frozen" accepted risk (mitigate gates + measure). "Maintainability" proven in code (not just principles).

- **Offline hybrid (plain strings + integrity + optional audit receipts + event-sourced local progress + manifest retention; client local val no re-val) (из ANALYZE-01 offline + review-offline + blueprint §4 + sync/coins cross):** 100% locked (client full local val vs snapshot; no server re-val correctness; new=latest; old frozen; sync = record client claims + coin reconcile + per-version analytics; ~5MB; physical confirm only; retention implied for re-dl). Improves robustness (tamper hints via audit layer background-only; events superior merge/conflict-free/replay/TDD/audit vs last-write/union (fatal per ANALYZE-05); explicit manifest retention for recoverability; normalized long-term dedup; compensation explicit). Vs locked thin (underspec merge/idempotency/retention; "last-write or union" bug invitation; plain naive for tamper even deprioritized; no receipts/events). Vs full hashed mandatory + on-path receipts (goes too far vs explicit 08 "plain strings... basic membership... cheating deprioritized"; adds v1 complexity/tax without critical re-val; audit-only/background better). Retention explicit policy (YAGNI machinery for 21q but must for locked recover). Bundle: plain acceptable (exact authored) + integrity; optional salt/audit hashes metadata (background analytics only; never overrides). Events must-have (for races already in locked problem). Cross: ctor emits exact shape (GAMSTEP refined + frozen gifts + plain lists); sync payload enriched (facts + coins_spent); coins (facts on completions); attempts (bound snapshot). Vs old: zero offline/bundles/versions.

- **Overall vs old Bubble mess и альтернативы (09_WHY + all analyses + blueprint cross):** Night and day (47 types → ~12-15 concepts; 1163 imperative UI WFs + 444 SetCustomState → focused aggregates + small handlers + pure fns; mutable no versioning → deliberate snapshots + facts; no offline → first-class PWA offline-first; scattered coin/answer logic in 82+9 WFs + scheduled + custom states → explicit facts + rules + projection; UI state pollution + dupe constructors (page vs page_constructor, quest vs quest_name_constructor identical 556) → clean per-attempt/snapshot + shared types; no audit/replay/import/version → self-documenting facts + replay + synthetic v0 + audit). Alternatives (richer taxonomies, full CRDT, per-attempt wallets, capability hints, heavy WYSIWYG ctor, re-val on sync, mutable scalars) attacked and rejected for violating locked/KISS/YAGNI/robustness/fidelity/product model/old data match. Converged best-practice: event-sourced where money-like or progress (robustness first); content-first GameStep (atmosphere + small rules); lean ctor with correctness gates (maintainable code + author velocity + hard-to-bad); snapshot + client peer for offline (satisfies hard req with mitigations). Enables long-term highest readability/maintainability + evolution (add rule subtypes to completion obj; richer preview/import; real$ via new fact kinds; branching) without recreating spaghetti.

- **Mismatches to client req resolved (06/00/07/08 + analyses):** Offline validation tension (client authoritative + no re-val locked per 08/03; server records only; mitigations gates/analytics/audit; 07 open on "locally correct but server incorrect" → explicit corrections for coins, analytics for content). Sync races (06 risk "lost progress or coin overspend" → facts + keys + corrections + projection; not "union will work"). Frozen content (08 accepted trade-off + 03/07 risk → ctor gates + per-v analytics). Constructor preview (08 "save+test acceptable" + 04 self-crit "easy to say hard" → lean + authoring surfaces + measure; not full V2 day1). Coins "lightweight" vs robust (04/08 locked earnings only gifts/completions per snapshot + per-attempt spends + master reconcile → events hybrid; no admin/real$ v1). Import "where feasible" (08 "yes" → best-effort synthetic + facts + audit/quarantine; not 100% fidelity). "No events domain" (06 cut → narrow CoinFact/AttemptFact ledger, not full BC). Linear only (08/06 → enforced in ctor/GameStep; branching future). Email+pass MVP (08 → clean; legacy post). All resolved in converged design with explicit why/mitigations; remaining opens noted with skepticism.

---

## 13. Будущие расширения (YAGNI for v1)

- Branching / optional steps / conditional (if real content from 556 shows frequent; old Next_page hints at some; force linear now hurts expressiveness if present).
- External authors / revenue share / public API (ctor/permissions/granular access change; internal only v1).
- More task types (add fields to completion obj e.g. numeric_tolerance/range, partial match, photo proof, count; or new supporting; no new primary modes or taxonomy now; revisit after real usage data).
- Real $ coins / top-ups / tradable (add 'PURCHASE' fact kinds; v1 forbids; economy lightweight now).
- Team play / shared attempts (multi-player progress merge; beyond single player lifetime grants).
- Richer preview / import primacy / side-by-side WYSIWYG in ctor (post-MVP if velocity metrics show "acceptable" friction kills quality; stage evolution).
- Advanced anti-cheat (hashed acceptable + mandatory receipts; geo proof; photo; server re-val opt-in; deprioritized v1 per 08).
- Full version history / rollback / time-travel content (beyond retention for attempts).
- Multi-lang (EN/SRB fields; design not painful to add, but not implement v1).
- Events/calendar revival (dead domain fully excluded v1; separate product if revives).
- Public stats / embeds / A/B / heatmaps wrong answers (advanced analytics).
- Subscription / recurring / gift purchases / cart (single quest v1 assumption).
- Advanced PWA (better quota mgmt, background sync, install prompts; low-end graceful).

**YAGNI principle:** Lean baseline + explicit plan for evolution. Add only on real data/usage/ stakeholder (e.g. walk 2-3 real quests for branching/gift timing/5-coin exact; measure ctor velocity post-v1). Do not recreate old accidental complexity under "future-proof".

---

**Статус:** COMPLETE (синтез всех указанных источников + converged best practices + resolutions mismatches; comprehensive standalone в RU; professional conceptual style; max documentation; skepticism на remaining tensions/opens; grounded в client req + prior analyses). 

**Путь к файлу:** `/home/nabor/_projects/geohod/quests/business/CONCEPTUAL_DESIGN_RU.md` (создан write tool после exhaustive reads/greps/list_dir/cross-analysis всех mandated artifacts; никаких файлов кроме этого не создано; абсолютные пути везде).

**Рекомендации (не scope этой задачи, для main-thread/stakeholder):**
- Обновить 01/03/04/08/07 с любыми финальными locks из этого синтеза (инварианты, политики coins, ctor gates, bundle shape, sync payload, retention).
- Реальный экспорт 2-3 квестов (page_constructor + answer_card где возможно) + walk-through против модели (validate GameStep shape, gift timing, physical/answer distrib, 5MB composition, ctor velocity assumptions) — repeated rec across *все* reports.
- TDD: property tests + golden fixtures + adversarial sequences в CI до кода.
- Stakeholder review + lock (preview friction, exact match rules, navigator details, rating, first-only gifts, correction policy, import fidelity).
- Tech stack evaluation *после* стабилизации conceptual (типобезопасность для domain, offline/PWA story).
- Дальнейшие reviewer passes на этот doc + updates до "survives scrutiny".

Это ключевой deliverable. Проект будет лучшим возможным под constraints, потому что мы отказались принимать что-либо (старое или новое) без полного цикла. 

(Конец документа.)