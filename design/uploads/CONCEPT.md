# CONCEPT

> **Status: supersedes all prior concept documents.**
> The interactive design artifacts in this project are the primary source of truth for UX/UI
> (see "Design Source of Truth" below). This document defines product boundaries and the model;
> SPEC.md defines exact shapes and contracts; PLAN.md defines implementation sequence.

## Product Structure
The site has three main components:
- Marketplace of quests (discovery, purchase, collection) — a peer top-level component.
- Quest player (the offline-capable PWA game experience).
- Quest Constructor (for internal administrators only).

## Quest as Sequence of Steps
A quest is a linear sequence of GameSteps (no branching in v1).
There is **one clean GameStep shape** with a `template` discriminator (render layer)
and exactly **two completion mechanics** (data layer):
1. `physical` — move to a location, optionally perform an action; uniform explicit confirmation, honesty trusted.
2. `answer` — enter a value; client validates against the embedded acceptable list.

## Seven Page Templates (DECIDED — supersedes the earlier "four templates" model)
The player renders GameSteps through seven templates, matching the legacy Figma vocabulary
(client decision, 2026-06; the data model stays a single discriminated GameStep):

| # | RU name (canonical) | key | completion | notes |
|---|---|---|---|---|
| 1 | Первый экран | `start` | advance | cover: kicker, title, flourish, meta (city/duration), CTA |
| 2 | Приветственное видео | `video` | advance | inline video block (poster + play + duration chip) |
| 3 | Задание без ответа | `task_no` | physical | confirm with custom label, optional note, navigator button |
| 4 | Задание с ответом | `task_answer` | answer | input + submit; wrong-answer flow → hint popup |
| 5 | Продолжить | `continue` | advance | narrative bridge |
| 6 | Видео маршрута | `route_video` | advance | video + navigator button |
| 7 | Поздравление | `congrats` | terminal | celebratory final: totals, completion bonus, inline rating |

Only the two task templates carry a `completion` record (physical | answer); the other five are
advance-on-CTA steps (`congrats` is marked terminal via supporting). Video is always an inline
block inside the step (poster + play), never a separate fullscreen page.

## Graphic Content
Every game page carries comic-style imagery with up to four roles per step:
`task` (required on task templates), `character`, `hint` (revealed only after coin spend),
`atmosphere`. Rich content is the primary differentiator; the mechanism stays uniform.

## Player Visual System (global)
One global player art direction for all quests (client decision): **«Бумага» (paper)** —
cream paper background, brown ink, Prata display + Inter body, outlined rectangular buttons,
flourish dividers. Exact tokens in SPEC.md. The marketplace/site keeps its own blue system
(Inter + Jost, pill buttons); the two systems are intentionally distinct.

## Navigator Button
On steps with a navigator point (`task_no`, `route_video`), a secondary button hands off to the
**system maps app** (geo/maps URL with bundled lat/lng/label). No in-app map, no routing data
in the bundle (v1). The navigator is an optional aid, never mandatory.

## Bonuses (Coins)
- Earned exclusively from play: per-step gifts (frozen amounts) + a canonical completion bonus
  (5 coins, first completion per player+quest, idempotent).
- Award presentation: **compact animated toast with sound** (does not interrupt reading), not a
  fullscreen takeover.
- Spent only on hints (v1).
- **Negative balance is allowed (DECIDED).** Hint purchase is never blocked by balance and is
  never revoked. Overdraft is a legal state resolved by simple summation; no compensation facts,
  no "insufficient funds" UI, no hint revocation flows.
- Coins accumulate into the player's personal rating (displayed in profile; floor at 0 for display).

## Hints
- No standalone hint button.
- First wrong answer → inline "Неверно. Попробуйте ещё раз."
- **Second and subsequent wrong answers** → popup offering to exchange coins for the hint
  (per-step frozen cost). After purchase the hint (text and/or `hint` image role) stays revealed
  for the rest of the attempt on that step.

## Feedback
Two distinct entities, never mixed in UI:
- **FeedbackReport** («Сообщить об ошибке»): available from the in-quest menu on every page;
  auto-attaches quest, step position, attempt context; queues offline like any fact.
- **Review**: at the terminal step — inline star rating + optional comment (final variant B).
  Rating boost via coin spend (RATING_SPEND) is **cut from v1**.

## In-Quest Menu (global, every page)
Progress (step N of M), coin balance, sound on/off, «Сообщить об ошибке», exit with save
(pause screen: continue/reset), reset progress (coins always survive reset), online/offline +
sync status indicator.

## Access Model & Commerce
- Lifetime AccessGrant per player+quest; sources: payment, coupon redemption (% incl. 100%),
  free quest, admin. Grant required before attempt creation or bundle download.
- Checkout (DECIDED): dedicated page (not modal); payment via **redirect to provider** (no card
  fields on our side); Telegram login is **required before purchase**; coupon entry is a
  collapsed «Есть купон?» link; free quests and 100% coupons go through the same checkout with a
  0 ₽ total and a «Получить бесплатно» CTA — one grant mechanic, source audited.
- Single-quest checkout only (no cart).

## Core Constraints
- Full offline PWA: downloadable bundle (~5 MB) contains everything needed to play; progress
  recorded as local facts and synced when online. Offline never blocks play.
- Client fully validates answers against its snapshot; server records submissions + the client's
  local outcome claim, never re-validates.
- Published versions are immutable snapshots. New attempts use the latest version; active
  attempts stay on theirs. Reset keeps coins.
- Russian only in v1. Internal authors only. Linear quests only.

## Key Invariants
- Quest = ordered GameStep sequence; ≥1 step; stable order per version.
- All amounts (acceptable answers, gift coins, hint costs) frozen at publish.
- Grant before attempt/bundle. Facts are immutable and idempotent; balance is a deterministic
  fold of facts and **may be negative**.
- The same `isAnswerCorrect` implementation runs in the constructor's test box and the player.
- UI visibility must never depend on animation playback (entrance animations gate on an
  anims-enabled flag and reduced-motion; end-state is the base style).

## What We Explicitly Cut (v1)
Everything from the prior cut list (events/tours domain, external authors, multi-language,
magic links, branching, real-money coins, manual balance adjustments, cart, GDPR flows), plus:
- Rating boost via coin spend (RATING_SPEND).
- Hint revocation / overdraft compensation flows.
- "Insufficient coins" UI states.
- In-app map / bundled routing data (system maps handoff instead).

## Design Source of Truth (this project)
| File | Covers |
|---|---|
| `Квест-флоу.html` (+ `player/`) | 7 templates, all player states/overlays, finals, playable prototype, tweaks |
| `Коммерция.html` (+ `commerce/`) | checkout, coupons, results, auth gate, entry states, mobile, prototype |
| `Мои квесты.html` (+ `myquests/`) | collection states, start gate, bundle download, profile |
| `Конструктор.html` (+ `ctor/`) | template picker (A grid / B list), pages+versions, per-step editor, publish gates |
| `PWA-синк.html` (+ `pwa/`) | connection states, fact queue, corrections, sync simulation |
| `review/Визуальный контроль.html` | iconography/header visual regression fixture |
| `Gap Analysis.html` | original coverage audit (historical) |

**Precedence rule:** for UX/UI — design files > SPEC > CONCEPT; for data shapes and invariants —
SPEC > design files. Conflicts must be resolved by updating the loser, never silently.
