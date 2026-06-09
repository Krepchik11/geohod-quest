# SPEC

## GameStep Shape (Core Data Model)
A GameStep has:
- Position (order within the quest; supports reordering only on drafts).
- Rich content (Russian for v1): title / internal name, main_text (task description), place_text, button variants, question prompt (when applicable), durations, gift narrative, hint reveal text, author notes (constructor-only, never in snapshot).
- Media:
  - images: { task?, character?, hint?, atmosphere? } — comic-style per page. Hint role is the coin-gated one. Task role is required for Task templates.
- Completion rule (small discriminated data, frozen in snapshot):
  ```
  completion: {
    mode: 'physical' | 'answer',
    acceptable?: string[],   // only for answer mode; plain list from constructor
    allow_note?: boolean
  }
  ```
  - 'physical': player performs explicit confirmation ("I did it / Found it / Completed the action") + optional short note. No acceptable list. Honesty is trusted. "No difference" across physical steps in mechanism (rich surrounding content + custom button text + images provide differentiation).
  - 'answer': player submits a value; client does membership match against the acceptable list (simple version; advanced normalization deferred).
- Supporting / additive behaviors (validated at authoring, frozen amounts):
  - gift?: { coins: number, narrative_text: string }
  - hint?: { cost_coins: number, reveal_text?: string, reveal_geo?: boolean }
  - navigator?: { lat: number, lng: number, label?: string, hint_only?: boolean, shortest_route_hint?: boolean }
  - bonus_animation?: { asset_ref: string, voice_ref?: string }
  - physical_action?: { description: string, confirm_label?: string }  // optional for "move + action" distinction
  - media_video?, terminal?, narrative_advance?, is_start?

All of the above (acceptable list, gift coins, hint cost, etc.) is frozen verbatim in the quest snapshot at publish time. Old attempts use exactly the data from their bound version.

## Four Templates (Primary UI Mapping)
- First screen: start / greeting (usually narrative_advance or is_start).
- Task no answer: physical / move + optional action (completion mode = physical).
- Task with answer: question / input (completion mode = answer).
- Continue: narrative bridge / terminal (narrative_advance or terminal with review prompt).

Constructor must support a picker for these four (with sensible pre-fills for button text, confirmation copy, etc.). Richer supporting (gift, navigator, animation, etc.) is allowed on top of them.

## Answers
- Constructor provides a list of acceptable strings (synonyms, numbers, phrases) via simple multiline input (one per line) or structured editor.
- Client performs basic membership / contains match against the list from the local snapshot.
- The exact matching function used in the live player must be the same one used for the live "Test match" box in the constructor for that version.

## Physical Steps
- Uniform explicit confirmation mechanism for all physical steps ("no difference" in v1).
- Optional short player note.
- Optional action metadata (description + confirm label) to capture "move + sometimes perform specific action".
- Geo is display-only (map pin). "Show on map" can be revealed via hint spend.
- No digital proof required in v1. Honesty is trusted.

## Hints
- Primary (and in v1 the only) trigger is the wrong-answer popup on answer-type tasks.
- After wrong submit → immediate popup: "Spend X coins for hint?"
- Uses the per-step supporting.hint.cost.
- On exchange: deduct coins, reveal (hint image/role, text, geo, or navigator data depending on the step).
- No separate always-visible hint button in the player UI for any of the four templates (popup is the mechanism).

## Coins / Economy
- Earnings come exclusively from:
  - Gifts defined inside GameSteps (amount frozen from the bound snapshot at publish).
  - Canonical completion bonuses (e.g. 5 coins on terminal; first-only per player+quest via idempotency).
- Snapshot-frozen amounts: an attempt that started on v1 still uses v1's gift values even if the live quest later changed them.
- Spends: per-step, 1:1 with a StepCompletion (mainly hints via the popup).
- Per-attempt tracking of spent coins.
- Master player balance = sum of all earnings facts minus all spend facts (global projection).
- Animated and voiced on award (supporting.bonus_animation with asset and optional voice reference).
- Coins can also be spent (optional post-quest flow) or accumulated for the player's personal rating.
- No admin manual adjustments of balances in v1.
- No real-money coin purchases in v1.

Facts for coins are unified with progress facts (or emitted linked on StepCompletion record). Idempotency keys prevent double-earn. Corrections (overdraft, etc.) are explicit compensation facts.

## Feedback
- FeedbackReport (thin append-only entity):
  - Available from global menu on every page / in all four templates (even mid-quest).
  - "Оставить отзыв" (Leave feedback) — primarily for reporting errors/bugs.
  - Auto-attaches current step position, quest, attempt context.
  - Synced like other facts (works offline via local queue).
- Review (separate):
  - After quest completion (on terminal or quest end).
  - Rating + optional comment.
  - Can be boosted via optional coin spend (RATING_SPEND fact).
- Both are visible to admins per version / per step for quality improvement (important because snapshots are frozen).

## Bundle Contents (for Offline Play)
Full ordered GameSteps including:
- All rich content and comic role images (task/character/hint/atmosphere).
- Plain acceptable answer lists (embedded for client matching).
- Frozen supporting values (gifts, hint costs, navigator data, animation refs).
- Version / snapshot id + integrity information.
- Media (images at minimum; short videos when present).

Client must be able to render the full sequence, do local validation, spend coins on hints (popup), use navigator data, play animated/voiced bonuses, and maintain local coin projection while completely offline.

## AccessGrant
- Player + Quest.
- Lifetime (no expiry in v1).
- Source recorded for audit (Payment, CouponRedemption, FreeQuest, Admin).
- Required before create Attempt or download bundle.
- Idempotent creation.
- Survives new quest versions.

## Commerce v1
- Single quest purchase only (no cart).
- Coupons = percentage discounts (different % supported; 100% = free via coupon).
- Free quests = identical mechanics to paid (price 0 or explicit is_free flag; auto-grant or "add to collection").
- One-time checkout.
- Grant created on successful payment / coupon / free / admin.
- Marketplace is a peer top-level component (not just thin supporting catalog). Published quests surface there with primary comic + template summary.

## Locked Decisions (from 08 + client alignment)
- Client fully validates against its snapshot; server records submissions + local outcome claim but performs no re-validation of correctness on sync.
- Physical steps: uniform explicit confirmation, "no difference", optional note. No subtypes or different completion UIs in v1.
- Answers: list of strings via simple multiline (or structured editor with live test). Basic membership match.
- Constructor preview: "Save then switch to real player as test user" is acceptable MVP. No high-fidelity embedded preview required at launch.
- Coins: earned exclusively via play (gifts defined in steps + completion bonuses). No admin manual adjustments, no real-money coin purchases in v1.
- Purchase: single quest only (no cart).
- Import of historical grants + attempt history is desired (full per-step where feasible).
- Quest size: ~5 MB per downloadable bundle (manageable for PWA offline).
- Branching: none in v1 (linear sequence only).
- Scope: events/calendar dead. Only Administrator (internal) + Player roles. Russian only in v1. Legacy magic links/password reset not supported.
- Event-sourced facts for all progress, coins, navigator uses, popup hints, mid-quest FeedbackReports, animated bonuses, rating spends.
- Client requirements from "Описание сайта" are authoritative for UX/gameplay details and have been incorporated (3 components with Marketplace as peer, 4 templates as primary, comic per page with 4 roles, navigator button as optional hint with shortest route, coins for tasks animated+voiced + spend or for rating, hints only via wrong-answer popup with no separate button, "Оставить отзыв" from menu on any page for errors + separate post rate/comment).

## Old System Anti-Patterns (Do Not Recreate)
- Mutable content under active players.
- 14 Page_type variants + 36-field multilingual bags + self-referential Next_page/Hint.
- 1,163 workflows (mostly ButtonClicked + SetCustomState + direct mutations).
- answer_card as per-user+step flag bag (Buy_hint, Complited, etc.).
- Scattered coin logic ("steps_for_accruing_coins_", scheduled "666" processors).
- No versioning, no snapshots, no offline design.
- Duplicated "page" vs "page_constructor", "quest" vs "quest_name_constructor".
- Denormalized lists on User polluting the model.

## Migration Notes (High Level)
- Old grants (buy_a_qest, payments, coupons, free, user lists) → AccessGrant facts + projections.
- Old answer_card + user Balance_coin + Getting_5 list + page_constructor Gift_Coins + quest countCoinMadeIt → synthetic legacy snapshots (content at export time) + StepCompletionFacts + CoinFacts (preserve submitted values and best-effort timestamps where possible).
- One-time idempotent job. Post-import the new system is clean. Legacy items marked "imported". Old scalar balance reconciled via diffs (manual review, no auto-adjust).

## Conceptual Tests / Goldens (Required)
- Golden fixtures from real quests: export page_constructor with Gift_Coins, simulate full playthroughs (including 4 templates, navigator use, wrong answers triggering popup hints, animated bonuses, FeedbackReports), assert projections, no duplicate facts, frozen amounts used, client match == recorded outcome.
- Idempotency: duplicate sync/upload of same completion or gift → only one fact.
- Race scenarios (property-based or adversarial): concurrent play on two devices, reset concurrent with play, version publish while attempt in progress, long offline + multiple hints/gifts, overdraft on reconnect.
- Version freeze: completion on v1 snapshot still uses v1 gift values even after live quest changed.
- Client/server projection fidelity: local fold on bundle must match server fold exactly.
- "Hard to publish bad": gates reject or warn on missing primary comic for Task templates, zero answers, invalid navigator, etc.

All of the above must be enforceable in types, unit tests, integration tests, and CI.