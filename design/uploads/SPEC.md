# SPEC

> Companion to CONCEPT.md. Exact shapes, contracts, and UI specifications.
> For pixel truth, read the design files (CONCEPT.md → "Design Source of Truth").
> The design project's `player/`, `commerce/`, `ctor/`, `pwa/` code is reference
> implementation: lift tokens, copy, and component structure from it.

## GameStep Shape (Core Data Model)
One discriminated record; `template` selects the renderer, `completion` the mechanic.

```
GameStep {
  id, position,                       // reordering only on drafts
  template: 'start' | 'video' | 'task_no' | 'task_answer'
          | 'continue' | 'route_video' | 'congrats',
  name,                               // internal, never shown to player
  content: {
    kicker?, title?, text,            // RU; text supports paragraphs (pre-line)
    prompt?,                          // answer input placeholder
    place_text?,                      // "ул. Николаевска порта 2 · 400 м отсюда"
    confirm_label?,                   // custom physical confirm, e.g. "Я на месте, нашёл"
    author_notes?                     // constructor-only, never in snapshot
  },
  media: {
    images: { task?, character?, hint?, atmosphere? },  // task REQUIRED on task_* templates
    video?: { ref, poster?, duration_label }            // inline block, never fullscreen
  },
  completion?: { mode: 'physical' | 'answer',
                 acceptable?: string[],                 // answer mode only
                 allow_note?: boolean },                // physical mode only
  // completion ABSENT ⇒ advance-on-CTA step (start/video/continue/route_video/congrats);
  // terminal behaviour comes from supporting.terminal, not from completion.
  supporting: {
    gift?: { coins: number, narrative_text: string },
    hint?: { cost_coins: number, reveal_text?: string },  // + media.images.hint role
    navigator?: { lat, lng, label? },                     // system-maps handoff only
    terminal?: boolean, is_start?: boolean
  }
}
```
All amounts and lists freeze verbatim in the snapshot at publish.

### Template presets (constructor pre-fills)
| template | completion | pre-filled supporting / copy |
|---|---|---|
| start | — (advance) | CTA «начать квест»; meta from store settings |
| video | — (advance) | video block; CTA «продолжить» |
| task_no | physical | confirm «Я на месте», allow_note, navigator ON |
| task_answer | answer | prompt «Введите ответ», hint cost 5, gift 5 |
| continue | — (advance) | CTA «продолжить» |
| route_video | — (advance) | video block + navigator; CTA «в путь» |
| congrats | — (terminal) | supporting.terminal; completion bonus +5; inline rating block |

## Answer Matching (single shared implementation)
```
isAnswerCorrect(submitted, acceptable):
  norm = s => String(s).trim().toLowerCase()
  return submitted non-blank AND acceptable.some(a => norm(a) === norm(submitted))
```
Exact membership equality after trim+lowercase — no contains, no normalization beyond this (v1).
The SAME module is used by: player submit, constructor «Тест ответа» box, bundle validator,
goldens. Reference: `player/matcher.js`.

## Wrong-Answer / Hint Flow
1. Wrong submit #1 → inline error «Неверно. Попробуйте ещё раз.» + input shake.
2. Wrong submit #2+ (hint exists, not yet bought) → popup: title «Нужна подсказка?», body with
   frozen cost, buttons [Потратить N монет] / [Попробую сам]. Decline → inline error.
3. Purchase: CoinFact spend (idempotent per attempt+step), hint box (reveal_text + hint image
   role) rendered persistently above the input for the rest of the attempt.
4. **No insufficient-funds branch. No revocation. Balance may go negative.**

## Coins / Economy
- Earnings: per-step gifts (frozen) + completion bonus 5 (first completion per player+quest,
  idempotent fact). No other sources. No admin adjustments. No real-money purchase.
- Spends: hints only (v1), 1:1 with the step, recorded per attempt.
- Balance = fold of all CoinFacts (global, cross-quest). **May be negative.** Display in profile
  and quest menu as-is; personal rating displays max(balance-derived score, 0).
- Award UI: bottom toast (coin icon spin + «+N монет» + narrative subtitle), auto-dismiss ~1.9s,
  WebAudio two-note chime when sound on. Completion bonus toast fires on entering terminal step.

## Player UI Contracts
- **Top bar** (every step except `start`): progress «N / M», coin chip, burger → menu.
- **Menu** (fullscreen overlay): step/balance stat tiles, progress line, sound toggle,
  «Сообщить об ошибке», «Выйти из квеста» (pause screen: continue / reset), «Сбросить прогресс»
  (confirm: «монеты останутся»), online/offline chip.
- **FeedbackReport sheet**: textarea + auto-context line «„{quest}“, шаг N — {step name}»;
  queues offline.
- **Final (variant B — DECIDED default)**: quest kicker, «Квест пройден!», coin trio animation,
  stat tiles (монет собрано / время в пути / шагов), narrative text, inline 5-star rating +
  [Оценить квест] → sent state. Variants A (restrained) and C (confetti + comment) exist in the
  design file as alternatives.
- **Start gate** (owner opens quest with an attempt): cover, attempt facts (date, step N of M,
  version), [Продолжить попытку] / [Начать заново] + note that coins survive reset.
- **Bundle download**: progress (X из Y МБ, %), ready state («работает офлайн», size, version),
  update state (new version available: new attempts need it; current attempt continues on its
  version without download).

## Player Visual Tokens («Бумага», global)
| token | value |
|---|---|
| background | #FBF1E5 + subtle 1px horizontal paper striping |
| ink / text | #3E2C2C |
| muted | rgba(62,44,44,.62) |
| accent (errors, accents) | #A33B2A |
| card | #FFF9F0 |
| coin | #C99B3F (rim #8A6A1F) |
| display font | Prata (uppercase titles, lowercase buttons) |
| body font | Inter 15/1.45 |
| buttons | 2px solid ink, square corners, h56 primary / h46 ghost |
| divider | flourish: line — diamond+dots SVG — line |
Layout default: image-first (media ~252px, shrinkable, min 132px). Copy tone default: «classic»
(reserved alternative «playful» exists in `player/quest-data.js` UI_COPY).
Frame: 360×740 design canvas; media block uses `flex: 0 1 auto` so CTAs never clip.

## Offline / Sync (facts model)
- AttemptFact (step completions with submitted value + local_is_correct claim), CoinFact,
  FeedbackReport — immutable, idempotency-keyed, queued locally offline.
- Banners under top bar: offline («события ждут» + count) → syncing («осталось N») → done
  (auto-hides). Sync sheet lists queued facts in human language with wait/sent chips.
- **Corrections (only two kinds, v1):**
  1. Balance re-projection after multi-device merge → popup «Баланс обновлён» with old → new.
  2. Attempt advanced on another device → popup offering to continue from the farther step
     (steps never lost; union of facts).
  No overdraft compensation, no hint revocation (negative balance is legal).
- Client fold == server fold, exactly (goldens enforce).

## Commerce
- Entry states on quest page: paid (price + [Купить]), free ([Получить бесплатно]),
  owned (✓ «Квест в вашей коллекции» + [Открыть квест] + grant date).
- Auth gate: Telegram login page with context chip explaining the grant binding and return path.
- Checkout page: left — quest summary card + lifetime note; right — order card: price row,
  collapsed «Есть купон?» → input + [Применить]; applied state (green chip, −N%, removable);
  error state «Купон не найден или истёк»; divider; total (struck-through original when
  discounted); CTA [Оплатить N ₽] or [Получить бесплатно] when total is 0; pay marks
  Visa/MC/PayPal; provider-redirect disclaimer. Mobile 360 variant exists.
- Results: success (check, «Квест ваш — навсегда», order details, [Начать квест] /
  [В мои квесты]); failure (no money taken, retry/back, support email).
- Coupons: percentage only; 100% ⇒ total 0 ⇒ no provider step; grant identical, source audited.

## My Quests / Profile
- Row: cover, meta, title, download status (✓ скачан · size / link «скачать для офлайна»),
  optional version banner («Вышла версия N+1…»), attempt state column
  (Не начат · grant date | В процессе · шаг N из M + progress bar + version | Пройден ✓ + stars),
  actions ([Начать] | [Продолжить]+[Начать заново] | [Пройти заново]).
- Empty state with CTA to marketplace.
- Profile: user data; game tiles — coin balance, personal rating, quests completed;
  completed list with own ratings.

## Constructor
- **Picker**: default — grid of 7 cards, each preview rendered by REAL player components
  (scaled live frames, never screenshots); alternative list variant with preset descriptions.
- **Pages screen**: sortable rows (grip, №, name, template chip, per-page gate status ✓/✗),
  [Открыть как тест-игрок], versions panel: draft (gate count) / published versions
  (immutable; live one marked; old versions note active attempts). No mutable status select.
- **Per-step editor** (blocks): template chip + internal name; content (text, prompt);
  4 comic upload zones (task marked required); AnswerListEditor (rows + add + «Вставить
  строками» replace + live «Тест ответа» via shared matcher with «зачтено/не зачтено» verdict);
  gift subform with freeze note; hint subform (cost + text); navigator toggle revealing
  lat/lng/label; live phone preview (real player components) + «показать с купленной
  подсказкой» toggle; save note: changes reach players only via next published version.
- **Publish gates** (errors block, warnings don't): structure (start first, terminal exists);
  task image present on all task templates; non-empty acceptable lists; navigator enabled ⇒
  coordinates set; bundle size estimate vs 5 MB target (warning); dry-run serialize passes.
- **Publish modal**: creates immutable version N; freezes texts/images/answers/amounts; new
  attempts start on N, active attempts keep theirs; no rollback — fix forward.

## Bundle Contents
Ordered GameSteps with all content + comic role images + plain acceptable lists + frozen
supporting values (gift coins, hint costs, navigator lat/lng/label) + inline video/audio refs +
version/snapshot id + integrity info. No routing data (system maps handoff). Target ~5 MB.

## Asset Hygiene (learned, enforced)
- Figma-extracted SVGs may carry geometry outside the declared viewBox (stroke→fill ±overshoot).
  Audit every imported SVG (detect path coordinates < 0 or > viewBox) and pad the viewBox;
  never "fix" by CSS transforms. Bake orientation fixes into the file.
- Visual regression fixture (`review/Визуальный контроль.html`) must stay green: logo, avatar
  composition (24×24 grid centered in 48px circle, percentage-based), meta icons, pay marks,
  assembled site/admin headers, single-line nav items.
- Entrance animations: end-state is the base style; animation gates on anims flag +
  prefers-reduced-motion; static renders (screenshots, exports) must show full content.

## Conceptual Tests / Goldens (Required)
- Full playthroughs exercising all 7 templates, navigator handoff, 1st-wrong inline → 2nd-wrong
  popup → purchase → persistent reveal, gift toasts, completion bonus idempotency, mid-quest
  FeedbackReport, reset (coins survive), pause/resume.
- Negative balance: spend below zero, projections stay consistent client==server, rating floors
  at 0 for display.
- Idempotency: duplicate uploads of completions/gifts/bonus → single fact.
- Races: two devices (union merge + advance-offer), reset during play, publish during active
  attempt, long offline queue.
- Version freeze: v1-attempt uses v1 amounts after live quest changes.
- Matcher parity: ctor test box verdicts == player verdicts for identical inputs (same module).
- Publish gates: each error gate rejects; warnings pass with notice.
