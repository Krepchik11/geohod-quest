# ANALYZE-04: Deep Adversarial Analysis — Coins / Hint Economy & Earning Mechanics

**Date:** 2026-06-09  
**Subagent Role:** Chief Staff Engineer + Relentless Critical Analyst  
**Mission:** Exhaustive deconstruction of the coin/hint economy, old Bubble behavior, current locked conceptual model, race conditions, ambiguities, and proposal + evaluation of robust economy variants.  
**Skepticism Level:** Maximum. Every assumption attacked. No sacred cows from old implementation.  
**Scope:** Strictly per task — business/docs grounding + heavy mining of discovery/parsed (data_types, element_definitions, workflows via structural + descriptions) + current locked in business/ + old scattered mutations. No broadening to unrelated gamification, real-money (explicitly v1 cut), or post-v1 features.  
**Output:** This report (the primary artifact). No other files created.

## 1. Grounding & Sources (Exhaustive)

All analysis is grounded exclusively in:

**Business / Conceptual Docs (authoritative locked decisions and models):**
- `business/08_DECISIONS_LOG.md` (explicit "2026-06 — Coins Economy (v1)" section: earned exclusively via completions + gifts defined in steps; admins cannot manually adjust; no real-money coins v1; mechanics extraction points to Gift_Coins / Balance_coin / Getting_5... / countCoinMadeIt / Buy_hint / You_made_it / Complited + "steps_for_accruing_coins_" + old workflows).
- `business/09_WHY_THE_QUESTIONS.md` (harsh critique of old: "Gift_Coins lives on page_constructor. Balance_coin on user. Getting_5_coins_for_completing is a *list of quests* on the user (to track who already got the 5-coin bonus?). countCoinMadeIt on quest. ... The actual *when* the balance is increased, when "You_made_it" is set, how gift steps interact with hint buying, whether coins are per-attempt or global, whether the 5-coin award happens only on first completion — all of this lives in the 82 workflows on the `quest` page + reusable elements like "steps_for_accruing_coins_" + backend API events. It is not a clean rule; it is scattered mutations.")
- `business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md` (Player in-game coin balance; QuestAttempt: "Total coins spent on hints during this attempt"; StepCompletion: "Coins spent on hint for this step (if any). Whether the hint was revealed."; invariant: "Coin spend for hints is per-attempt, per-step. Coins are earned via quest completions and gifts defined in steps. Admins do not manually adjust balances (v1)."; ER includes Player --o{ CoinTransaction : spends on hints; "per-attempt, per-step").
- `business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md` (critical for races + offline: "Hint spend (coins): Deduct from the attempt's local coin balance (or player's cached balance), reveal the geo pin + any hint content for that step. Purely local."; "Narrative, video, gift, terminal steps: ... Gifts may award coins locally."; "On sync / reconnect: ... Server reconciles coin balance (master player coins = sum of earnings from completed quests/gifts minus spends). Local spends are applied."; "A completion that the server marks incorrect (or a hint spend that would overdraft coins) can cause the local attempt state to be corrected on next load."; "Multi-device: Each device can have its own local snapshot + local attempt state. On sync the server merges by (attempt, step, version). Last-write or union semantics needed for coin spends and completions."; "coins_spent_on_hint (integer)" in sync payload).
- `business/04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md` (GameStep supports "Gift / Reward (coins, narrative prize, "you made it" moment)."; "Hint model: per-step coin spend reveals the geo object on the map (plus any associated hint content)."; "gifts that award coins"; "coin-gated hints").
- `business/06_V1_REQUIREMENTS_AND_CUT_LIST.md` ("Hint purchase with in-game coins (reveal geo on map)."; "In-game coin balance and spend recording (per attempt + master balance reconciliation)."; "sync on reconnect"; risk callout: "Sync logic has races → lost progress or coin overspend for real players.").
- `business/07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md` (assumption 4: "Coins are earned only through quest completions and gifts defined inside steps. No admin manual balance changes, no real-money coin purchases in v1."; risks around import of old attempt history and "old answer_card data that was created via the complex scheduled workflows"; open questions on sync races/coin overdraft).
- `business/00_PRODUCT_VISION_AND_SCOPE.md`, `business/02_COMMERCE_ACCESS_AND_COUPONS.md`, `business/05_ROLES_PERMISSIONS_AND_AUTH.md` (cross-refs: coins as "lightweight in-game economy"; play actions include "spend coins on hints"; "All play actions (create attempt, submit completion, spend coin) require an authenticated Player who holds the relevant AccessGrant").
- `business/README.md` (status notes on coin economy updates).

**Discovery / Parsed (heavily mined for data_types, element defs, workflows structure):**
- `discovery/parsed/data_types.json`:
  - User fields: "Balance_coin" (number), "Getting_5_coins_for_completing" (list.custom.quest_name_constructor — explicitly for tracking the 5-coin bonus per quest), "Completed_quests" (list).
  - answer_card (the per-step progress/answer bag): "Buy_hint" (boolean), "Complited" (boolean), "You_made_it" (boolean — note spelling "youmadeit__boolean" internal), "Complited_quest" (boolean), "Count_wrong_answers", linked to User + Page_constructor + Quest_name.
  - page_constructor (step def, 36 fields): "Gift_Coins" (number) — the per-gift-step award amount.
  - quest_name_constructor (quest): "countCoinMadeIt" (number), plus completedcount, theNumberOfUsersWhoCompletedTheQuest, lists of answer_card, etc.
  - Other related: "Buy_help" (list on some types), Hint_Image, etc.
- `discovery/parsed/element_definitions.json`:
  - "Slide_Congratulations" (CustomDefinition, group_type custom.page_constructor, workflow_count: 9): has custom_states including "steps_for_accruing_coins_".
  - Other hint/gift related reusables: "Slide_Hint" (custom_states: closehintimage_, hint_show_, buyhint_, openhintimage_), "Slide_give_prize", mapbox, etc.
  - 52+ reusables total; "steps_for_accruing_coins_" is the smoking gun for completion-time coin logic.
- `discovery/parsed/workflows_all.json` + `workflows_sample.json` + `docs/05_WORKFLOWS_AND_BUSINESS_LOGIC.md`:
  - Quest page: 82 workflows (highest after site/calendar) — "Load quest... Navigate between page_constructor steps. Handle answers... Show/hide hints, images, gift pages. Track progress via custom states."
  - Top actions: 444 SetCustomState (UI leaked), 277 ChangeThing (DB mutations on answer_card/user/etc.), NewThing, etc. No clean "domain service".
  - Reusables have their own workflows (e.g. 9 on Slide_Congratulations, 3 on Slide_Hint, 21 on Slide_Error).
  - API events (22 total): addAnswerCard, create_answer_card_list, deleteAnswerCard, yKassa, 666/666_copy (scheduled), etc. — coin mutations likely in client quest-page WFs (ChangeThing / MakeChangeCurrentUser) rather than these, since always-online assumption.
  - Structural sample shows heavy reliance on ButtonClicked + ConditionTrue + SetCustomState + ChangeThing. No literal "coin" strings surfaced in parsed WFs (logic uses element custom_states + field refs by ID + expressions; "steps_for_accruing_coins_" is the accumulator).
- `discovery/parsed/option_sets.json`: Page_type includes "gift", "hint"; Gif_Gift option.
- `discovery/raw/data-api/probe_results.json` + `record_counts.json`: Confirms countCoinMadeIt on quest; answer_card etc. not API-accessible in probe (404 in some); page_constructor mirrors page.
- `discovery/parsed/pages.json`, `api_events.json`: Quest page + answer_card flows; no coin-specific API events (confirms client-driven mutations).
- `geoquest.bubble` (raw 5.5MB JSON export): Confirmed field names + structure align with parsed data_types (e.g. gift_coins_number internal); workflows are full but opaque in text grep (ID/expression heavy); used only for validation of extracted names, not new logic.

**Cross-refs in docs/ (historical reverse-engineered, secondary):**
- `docs/02_DATA_MODEL.md`, `docs/03_DATA_MANAGEMENT.md`, `docs/04_API_SURFACE.md`, `docs/05_WORKFLOWS_AND_BUSINESS_LOGIC.md`, `docs/06_PAGES_AND_USER_JOURNEYS.md`, `docs/10_MIGRATION_MAPPING.md`, `docs/APPENDIX/OPEN_QUESTIONS.md`, `docs/00_EXECUTIVE_SUMMARY.md`, `docs/01_APPLICATION_OVERVIEW.md` (old page types: gift/hint/congratulations; answer_card as progress collector; no clean coin domain; 82 quest WFs; migration maps answer_card → progress, but coins implicit).
- Old had 47 types, 1163 WFs (imperative, UI-coupled), no versioning/offline, mutable content, answer_card as "bag of flags" mutated by "dozens of imperative workflows".

**Explicit Cuts / Non-Grounds (per task scope):** No real $ coins, no admin balance ops, no external authors, no events domain, no branching v1, no code-level impl (none exists in workspace — only conceptual + discovery). Old "specific behavior" is NOT specification (per 09_WHY).

**Process Adherence:** Started broad (grep -i coin|hint|Gift|Buy_hint|... across /home/nabor/_projects/geohod/quests), narrowed to parsed/ + business/ reads, targeted jq/grep-equivalent on JSONs for field defs + "steps_for_accruing_coins_", inspected .bubble, cross-checked all coin mentions (67+ in initial, narrowed to core). Used list_dir, multiple read_file (full + offset/limit), grep with -B/-A/context. Never created files until this explicit deliverable. Updated todo tracker throughout.

## 2. Extracted Old Mechanics (Bubble Reality — Scattered Mutations, Not Rules)

From direct mining + business docs synthesis (the only reliable extraction; workflows themselves are 1,163 imperative UI state machines, not declarative rules):

- **Earning Sources (only these, per locked + old):**
  - **Gift steps:** Defined in page_constructor.Gift_Coins (number). When player reaches a "gift" Page_type step (or via Slide_give_prize reusable), award that amount to user.Balance_coin. Timing: likely on view/advance/button in quest-page WFs or on congrats slide.
  - **Completion bonus (the "5 coins"):** On quest "You_made_it" / Complited_quest / terminal congratulations (Slide_Congratulations reusable with 9 WFs). Award 5 to Balance_coin **only if** the quest is not already in user.Getting_5_coins_for_completing (list of quest refs — de-dupe mechanism). countCoinMadeIt (on quest) and completedcount / theNumberOfUsersWhoCompletedTheQuest appear to be related denorms or counters (possibly incremented on award or used in "you made it" condition).
  - **Accruing mechanism:** "steps_for_accruing_coins_" custom state on Slide_Congratulations (and likely related logic in quest WFs) — this was the accumulator for gift coins "made" during a playthrough, summed/credited on completion slide. Opaque: does it sum only unspent? Only first visit? All gift steps visited in sequence?
  - No other sources. No admin direct sets (though old privacy/UI may have allowed via MakeChangeCurrentUser). No real $ top-up.

- **Spending:**
  - Per-step, gated on "has geo or hint content": Buy_hint (boolean flag) on answer_card (tied to User + specific Page_constructor step + Quest).
  - Action: In hint-related WFs (buyhint_ states in Slide_Hint etc.), set Buy_hint=true on the answer_card (NewThing or ChangeThing), reveal geo/hint image, and **deduct 1 (or Gift_Coins equiv? — unclear, probably fixed 1 per buy) from user.Balance_coin**.
  - answer_card also carries Complited, You_made_it, Complited_quest, Count_wrong_answers — all mutated together in the same imperative flows. Per-step progress bag, not clean per-attempt aggregate.
  - Hint spend was immediate global mutation (client WFs assumed connectivity).

- **Tracking & State (Mixed Global + "Per-Attempt-ish"):**
  - Global authoritative?: user.Balance_coin (single scalar — source of truth for display/spend eligibility).
  - "Per-attempt"/playthrough: answer_card records (one per step visited/answered per play session?). Buy_hint lives here (so which steps had hints bought in this "attempt"). You_made_it / Complited_quest seem to mark terminal moments.
  - Quest-level: countCoinMadeIt (possibly # of coin awards triggered by this quest's completions).
  - User-level lists: Getting_5_coins_for_completing (de-dup for bonus), Completed_quests, buy_a_quest etc. (access).
  - No explicit QuestAttempt aggregate in old (multiple plays via multiple answer_card sets or resets via del?).
  - "per-attempt" was emergent from answer_card bags + custom states on quest page, not modeled.

- **Triggers & Timing (Lives in Old Workflows — Opaque):**
  - 82 WFs on `quest` page (ButtonClicked for answer/hint/gift/nav, ConditionTrue, ChangeThing for answer_card + user.Balance_coin, SetCustomState for UI like steps_for_accruing_coins_).
  - 9 WFs on Slide_Congratulations reusable: the "accruing" + award + You_made_it logic.
  - 3+ WFs on Slide_Hint: buyhint_, reveal.
  - Scheduled "666" API WFs + create_answer_card_list / addAnswerCard: server-side answer persistence (mixed with client mutations).
  - Earning likely on congrats slide load/click or "made it" flag set. Spending on buy button before reveal.
  - Re-completion: unclear if re-visiting gift or re-completing re-awards (list prevents 5-coin repeat; gifts?).
  - No versioning: page_constructor/quest mutable in place; no snapshot; attempts not version-bound. "Old" vs "new" gifts impossible to distinguish.

- **"Reconciliation" / Sync:** None in old (always-online assumption via API WFs + direct mutations). Balance was mutated in place; discrepancies only via bugs/races in WFs or manual data.

- **Other Scars:** answer_card as "bag of flags" mutated by "dozens of imperative workflows". UI state (custom states) leaked into domain (steps_for_accruing_coins_). countCoinMadeIt etc. as denorms without clear invariants. Import of historical answer_cards will be painful because timing/conditions lived in dead WFs.

**Bottom Line on Old:** This was not an "economy model". It was ad-hoc mutations to make the Telegram/quest page "feel" like there were coins for hints. Exact "first only vs every replay", "per-attempt wallet vs global", "award on step view vs completion", "amount per gift vs fixed", "what if negative?", "concurrent plays" were never specified — they were whatever the 82+9 WFs happened to do on the day they were written under time pressure. Copying = shipping bugs + races.

## 3. Current Locked + Conceptual Model (Business v0.2 — Partial, Leans Global + Reconciliation)

From decisions + domain + offline (locked, but coin details still under-specified — hence this ANALYZE):

- **Earnings:** Exclusively via (a) gifts/rewards defined inside GameSteps (GameStep can carry coin award amount, derived from old Gift_Coins), (b) quest completions (the 5-coin bonus, exact amount/trigger "to be taken from current project behavior").
- **Constraints:** Admins cannot adjust balances (v1). No real-money coin purchases (v1). 
- **Spends:** Per-step "Buy_hint" equivalent: spend to reveal geo (+ hint content) for a GameStep. Cost presumably fixed (1?) or per-step defined? (old unclear; new model must decide).
- **Tracking:**
  - Player: in-game coin balance (global scalar).
  - QuestAttempt (new aggregate root, supports replay): total coins spent on hints during this attempt.
  - StepCompletion: coins_spent_on_hint (int), hint revealed flag. Tied to attempt + step (or position + snapshot id).
- **Earning/ Spend Recording (per attempt + master reconciliation):** "master player coins = sum of earnings from completed quests/gifts minus spends".
- **Offline:** Local deduction/award from attempt-local or cached player balance. Gifts award locally on advance. On sync: upload StepCompletions (incl. coins_spent_on_hint), server records + reconciles master. Local state correctable on overdraft detection.
- **Versioning:** Attempts bound to quest snapshot/version at start. New attempts get latest. Earnings for a completion must use the gift amounts from *that* snapshot (not live).
- **Multi-attempt:** Multiple QuestAttempts per player/quest OK (reset/continue supported). Reset clears StepCompletions for that attempt only.
- **Invariants (from 01/03/06/07/08):** Coin spend per-attempt/per-step. Earnings only via defined gifts+completions. No manual admin. Balance never negative (implied by correction + prevention). Sync eventually consistent; client can proceed offline trusting local.
- **Unspecified / Ambiguous in Locked (Attack Surface):**
  - Exact earning triggers/amounts/timing (first-completion-only for bonus? every replay? on step visit or terminal?).
  - Per-attempt wallet vs pure global (attempt only tracks *spends*; earnings global?).
  - Cost per hint buy (fixed 1? per-step in GameStep?).
  - "steps_for_accruing" equivalent in new GameStep model.
  - How "5-coin" de-dup works across versions/attempts (per-quest ever, or per-version?).
  - Idempotency keys for earnings on sync/import.
  - Exact projection formula for master balance.
  - Conflict resolution for multi-device (last-write wins? union of spends? server tx?).

Current "lean" (global balance + event log of earns/spends for reconciliation) is implied but not fully specified — this report attacks it.

## 4. Deconstruction: All Races, Edge Cases, Failure Modes

**Multi-Device Simultaneous Spend + Sync (Highest Risk per 06/03):**
- Device A (offline): cached balance=5, buys hint on step 7 (local deduct to 4, reveals).
- Device B (online): sees 5, buys on step 12 (deducts to 4).
- Both sync: if naive "check current >= cost then deduct", second may succeed or race to negative. If "apply spends", double-spend (effective -2 from 5 without server seeing both).
- Merge by (attempt, step, version): spends are per-step, so two different steps OK, but total balance reconciliation must be atomic or use event log (append both spends, compute sum).
- If same step? (player buys twice?) — old had no guard; new must prevent duplicate spend record.
- Result: overspend, negative balance, "I bought the hint but coins disappeared" or "hint not revealed on other device".
- Import exacerbates: old answer_cards with Buy_hint=true but Balance_coin may not match historical sum(gifts) - sum(buys).

**Reset Attempt After Earning:**
- Complete attempt #1 → earn 5 (via completion) + any gifts (say +3) → balance +=8.
- Reset attempt #1 (clears StepCompletions, per locked).
- Re-play same attempt (or new?) → re-trigger congrats / gift steps → re-earn? Double (or infinite if no de-dup).
- If earnings tied only to StepCompletions recorded, reset + re-complete may re-emit rewards unless "first ever" check is global (player+quest, not attempt).
- Old: unclear (list was global on user; answer_cards could be recreated?).

**Earning on Re-Completion vs First Only:**
- The Getting_5... list implies *intent* "first completion only" for the bonus (to avoid farming the same quest).
- Gifts: if award on every visit to gift step (or every completion), replays farm coins → economy collapse or trivial hints.
- If only first-ever per quest: good for "you made it" magic, but then what is point of replay? (hints still cost, but no re-earn).
- Versioned: player completes v1 (earns 5 + gifts from v1 snapshot), admin updates quest (changes Gift_Coins or adds steps), player starts v2 attempt → new earnings? Or bonus only once ever?
- Old workflows likely had bugs here (scattered conditions on You_made_it + list membership).

**Versioned Gifts — Old Snapshot vs New (Critical with Offline + Versioning Decisions):**
- Attempt started on snapshot v1 (gift step X has Gift_Coins=10 in the bundle).
- Player plays offline, "claims" gift → local award +10.
- Sync: must credit exactly 10 (from v1 def), *even if* current live quest has 0 or 20 for X.
- If award happens only on server record of StepCompletion for gift step, server must read the amount from the *attempt's bound snapshot* (or embedded in completion).
- Race: player has old bundle, completes, earns old amount; meanwhile admin changes live. Correct (use snapshot).
- If "accruing" sums from current live steps: broken for old attempts.
- Old had zero versioning → this entire class of bug didn't exist (or was invisible).

**Overspend Prevention + Negative Balance:**
- Client (offline or cached stale): allows buy because local=1, cost=1 → spend.
- Concurrent: two buys "succeed" locally → server sees two spends when balance was 1.
- Server must: (a) reject spend if would go negative (return correction: "hint not bought, balance X"), or (b) allow append but project balance (may go negative, then block future until corrected via earnings), or (c) use ledger with total order.
- Old: no prevention (client WFs just did Change on user).
- Correction on next load (per offline doc) is damage control, not prevention. UX: "I spent the coin offline, but on sync the hint is un-revealed and I have the coin back (or not)".
- Negative: must be impossible in steady state; import or bugs can create.

**Other Edges:**
- Partial play: gifts earned mid-quest, then abandon. (Award or not? Old probably awarded on visit.)
- Multiple gifts in one quest: sum correctly via "steps_for_accruing" equivalent.
- Import of old data: historical answer_cards (with Buy_hint flags + You_made_it) + users (with old Balance_coin + Getting_5 list) must be reconciled without double-count or loss. Requires simulating old awarding logic or treating imported Balance as starting point + future events only.
- "Per-attempt vs global" unclear in locked: spends are attempt-scoped in records, but balance global + reconciliation "sum earnings - spends" (spends across all attempts?). If a player has 2 attempts, earns on #1, spends on #2: OK? Earnings credited globally even if "per-attempt play".
- Lost coins: failed sync (local award not uploaded), device loss (local only), duplicate attempt creation.
- Zero/negative start: new users balance=0; cannot buy until earn.
- Concurrency on earning: two devices complete same quest at same instant → both check "not in list", both award 5 → double earn.
- "You_made_it" vs "Complited_quest": old had both flags on answer_card; unclear which triggered bonus.

**Flaws in Current (Lean Global + Reconciliation) as Specified:**
- Opaque earning: still relies on "exact from old project" without clean rules → we risk reimplementing scattered mutations in new code (e.g. in sync handlers or completion services).
- Double-earn or lost on import/sync: no explicit idempotency model or event log yet; "sum of earnings" requires canonical source of truth for "was this gift/completion awarded?" (the list was a hack).
- "Per-attempt" vs global: attempt records spends, but earnings timing/scope fuzzy. If global only, then attempt-local "deduct from attempt's local coin balance" (offline doc) is a cache that can drift from master, leading to correction surprises.
- No explicit audit log → hard to debug "why is my balance 3 when I earned 5+2 and spent 4?".
- Versioning interaction underspecified → gift amounts must be snapshot-frozen for earnings.
- Races not mitigated in the docs beyond "reconciliation" handwave + "last-write or union" (insufficient for money-like).
- KISS violation risk: if we just put a number on Player and mutate it in completion/hint endpoints, we get old Bubble problems in typed code.
- Maintainability: future "real money coins" (cut for v1 but planned?) or analytics will be painful without events.

The model is directionally sound (earnings only from play, per-step spend tracking, offline local + server reconcile) but the accounting is not yet robust.

## 5. Proposed Economy Model Variants (Full Cycle on Each)

All variants must satisfy locked constraints:
- Earnings ONLY from gifts defined in (versioned) GameSteps + completions (modeled as special reward on terminal/"made it" step or explicit completion event). Amounts from the snapshot at attempt start.
- No admin manual adjustments (v1).
- No real-money coin top-ups (v1).
- Spend = per-step hint buy (deduct cost, mark revealed for that StepCompletion; geo + hint content shown only after).
- Support offline local award/spend + sync reconciliation.
- Multiple attempts + reset (reset affects only that attempt's progress/spends; earnings already banked are global or scoped per model).
- "5-coin" (or configurable completion bonus) as first-only (use a de-dup mechanism equivalent to old list, but clean).

**Variant 1: Simple Global Balance + Event Log of Earns/Spends (Current Lean, Minimally Extended)**

*Description:* Player has a `current_balance` (or purely derived). All changes are append-only `CoinEvent` records (or `CoinTransaction`): 
- Earn: {event_id (uuid or attempt+step+type), player_id, attempt_id (nullable), quest_id, quest_version/snapshot_id, step_position or step_id, reward_type: 'GIFT' | 'COMPLETION_BONUS_5', amount (>0), awarded_at (client or server), source: 'sync' | 'import'}
- Spend: {..., spend_type: 'HINT_BUY', amount (usually 1), step_position, revealed: true}
Balance for a player at any time = SUM(earn.amount) - SUM(spend.amount) over their events (or materialized scalar updated on append for perf).
Earning eligibility (e.g. first-only bonus): query for prior COMPLETION_BONUS event for (player, quest) before emitting new.

*Earning:* On authoritative server recording of a qualifying StepCompletion (for a gift step: amount = snapshot's game_step.gift_coins; for terminal: if no prior bonus event for player+quest, emit 5). For offline: client locally adds to its projected balance using snapshot gift values + local "I hit congrats" flag. On sync, server re-evaluates from uploaded completions (idempotent: if event for this (attempt,step,reward_type) exists, skip).
*Spend:* Client (offline) checks local projected >= cost, records local spend + mark revealed on StepCompletion, deducts from local. On sync upload the spend facts; server appends if not duplicate and (optionally) re-checks total (or accepts and allows temp negative with correction).
*Offline Fit:* Excellent for local play — client maintains a local event log or just a running balance + list of (step, spent) from its attempt state + snapshot gift defs. Can buy hints, see updated "balance". Gifts award on reaching step. On reconnect: upload StepCompletions (with coins_spent + any implicit earns), server projects authoritative, pushes corrections (e.g. "actual balance now X; some hint spends rejected").
*Race Mitigations:* 
- Use DB transaction or unique constraint on (player_id, quest_id, step_id, reward_type) or client-generated event_id for idempotent append.
- For spend: optimistic — always append the spend event (tied to unique step completion), compute balance after; if negative, emit a compensating "CORRECTION" event on next sync or block the reveal retroactively (client corrects UI).
- Or pessimistic: server endpoint for "claim hint spend" does SELECT ... FOR UPDATE on player/events, compute, if >= append+update materialized, else reject.
- Multi-device: events are the merge key; union of spends (per-step unique), earnings deduped by keys. Last-write timestamp for display only.
- Concurrent earn: the "no prior bonus" check inside tx or via unique (player,quest,bonus_type).
- Reset: does not delete prior events (earnings banked); new attempt gets fresh StepCompletions, can earn only if model allows (e.g. gifts yes if we decide replays re-award gifts, bonus no).
*Accounting / Maintainability:* Good — append-only log is auditable ("replay all events for player from genesis to now"). Import: seed with initial Balance as a synthetic "IMPORT_CORRECTION" event, then future events. Clear separation of "what happened" vs "current number".
*Pros:* KISS-ish (leverages existing StepCompletion as source); matches "reconciliation = sum earnings - spends" exactly; supports future real-$ coins (just more event types); easy stats ("total earned from gifts").
*Cons / Skepticism:* Still requires careful idempotency and tx around "check + append" (easy to get wrong → double or lost). Materialized balance can drift from log (bugs); must have periodic reconciliation job or always compute from log for truth. "Simple" in name only — the log + projection is the real model; if we just mutate a scalar + "log for debug", we lose robustness. Per-attempt spends but global earns still fuzzy (when is an earn "for" an attempt?). Versioned gifts handled only if we embed snapshot amounts in events. Old workflow opacity means we may mis-model the "accruing" timing (step visit vs completion record). Risk of negative if not strictly prevented. Not much better than old if implementation is imperative "if balance >=1 { balance -=1; record spend }".
*Full Cycle Verdict:* Viable minimal extension of locked. But "current lean" is insufficiently specified to be safe; needs the event log made first-class, not afterthought.

**Variant 2: Per-Attempt Coin Wallet (Coins Earned/Spent Scoped to Attempt, Convertible or Not)**

*Description:* Each QuestAttempt has its own `attempt_coin_balance` (or earned_in_attempt - spent_in_attempt). StepCompletion spends are charged against the owning attempt. Earnings (gifts hit during the attempt's play, or completion bonus on its terminal) are credited to *that attempt's* wallet.
Global player balance = SUM( all attempts' unspent/convertible balances ) or a separate "banked" balance.
On attempt complete/reset: option to "convert" net (or gross earned) to global bank, or keep scoped (hints only usable from coins earned in same attempt).
The 5-coin bonus could be always global (on first completion ever) or scoped to the completing attempt.

*Earning:* During attempt, on gift step completion record → credit attempt.wallet += snapshot.gift_amount. On terminal made-it → if first, credit bonus (to attempt or global).
*Spend:* Strictly from the attempt's wallet for hints bought in that attempt's StepCompletions. Client local: attempt has its local_wallet.
*Offline Fit:* Very clean — the attempt bundle + local state carries its own coin pot. No global cache drift during one play session. Gifts award to local attempt wallet. On sync: server applies to the attempt record (idempotent per completion).
*Race Mitigations:* Spends isolated per-attempt → no cross-attempt races. Multi-device on *same* attempt still possible (two devices playing same attempt id concurrently): still need unique per-step spend + tx or event-per-attempt. Earning races reduced (earns tied to this attempt's completions). Reset of attempt can zero or archive its wallet (earnings lost or banked first?). Concurrent completions on different attempts: independent wallets.
*Accounting:* Per-attempt ledger easy to audit for one playthrough. Global is a simple sum projection. But "convertible?" decision creates extra state (has this attempt's coins been banked?).
*Pros:* Matches "per-attempt tracking" language in requirements; makes "I earned these coins playing this quest, spent them on its hints" intuitive; simplifies offline (no global sync needed mid-quest); overspend only affects one attempt.
*Cons / Skepticism:* If coins are meant to be a *platform* economy (earn in easy quest, spend hints in hard one), scoping kills UX unless conversion is mandatory+automatic on complete. Conversion itself is a race point (complete attempt A, convert; meanwhile spend in B). "First only" bonus: if scoped, a player could farm by creating many attempts? (No, if bonus tied to quest ever, not attempt.) Complexity: now two balances (attempt + global), conversion rules, "what happens to attempt wallet on reset/abandon?". Old data had global Balance_coin + per-card Buy_hint (not cleanly per-attempt wallet). If non-convertible, then gift coins in a quest are only useful for that quest's hints — reduces incentive. "Per-attempt" was never cleanly true in old (balance global, cards just flagged spends). Maintainability hit for future shared wallets or team play.
*Full Cycle Verdict:* Good for isolation, but likely mismatches intent of lightweight *cross-quest* hint economy. Requires extra conversion logic that re-introduces races. Not KISS unless we decide "no global, all scoped and non-convertible" (then why call it "coins" vs "this quest's hint tokens"?).

**Variant 3: Step-Reward as First-Class Immutable Events Projected to Balance**

*Description:* Rewards (earns) are not mutations or scalars, but immutable facts emitted exactly when a rewarding StepCompletion is authoritatively recorded:
- RewardEvent: {id, player_id, attempt_id, quest_id, quest_version, step_id/position, reward_kind: 'GIFT' | 'COMPLETION_BONUS', amount, snapshot_gift_coins_value (frozen), emitted_at, idempotency_key: attempt+step+kind }
Spends are similarly facts on the StepCompletion or separate SpendEvent (but can be denormed onto the completion since 1:1 with hint buy).
Player balance = projection: fold all RewardEvents for player - all SpendEvents (or sum(spent_on_hint) over their StepCompletions).
The "steps_for_accruing_coins_" equivalent is: on recording completions for gift steps in an attempt, emit the rewards (sum is just query).
First-only bonus: before emitting COMPLETION_BONUS, check existence of prior RewardEvent for (player, quest, 'COMPLETION_BONUS') — or use a unique constraint / "awarded_completions" table as projection.

*Earning:* Server-only on successful insert of StepCompletion for a step that the *bound snapshot* marks as gifting (amount >0) or terminal. Client never "awards" authoritatively; it only projects locally for UI ("you will earn X on sync if this completes").
*Spend:* On client buy: mark local StepCompletion.coins_spent = cost, revealed=true. Upload on sync; server records the completion (with spend), which may be accompanied by any pending rewards from prior steps. No separate "deduct" — the spend is the fact.
*Offline Fit:* Client projects balance from: (a) snapshot (known gift amounts for unreached steps + already-completed local gifts), (b) its local StepCompletions (spent so far, earned so far in this attempt), (c) any previously synced global rewards. Can decide "can I afford this hint?" locally. On sync, server emits rewards for any gift completions in the upload (idempotent), records spends, returns authoritative projected balance + any corrections (e.g. a prior spend was on a step that server now knows was already revealed, or overdraft → un-reveal + refund event).
*Race Mitigations:* 
- Immutability + idempotency_key (e.g. hash(attempt_id, step_position, reward_kind) or uuid from client) makes double-emit impossible (INSERT ... ON CONFLICT DO NOTHING or unique index).
- Spends: per (attempt, step) unique; server can reject duplicate hint buy on same step.
- Multi-device: whichever completion records first "wins" the reward/spend fact; others see it on next load/sync (union semantics natural). No "simultaneous deduct" because no mutation of scalar until projection.
- Concurrent earn check for bonus: the existence query + insert of reward can be in tx, or the unique index on (player_id, quest_id, reward_kind) for bonus type (prevents double even across attempts).
- Versioned: amount is copied from the completion's snapshot at emit time; never re-computed from live quest.
- Reset: new attempt = new attempt_id; prior rewards stay (banked); new attempt can emit its own gift rewards if policy allows (or not, if we decide gifts are "once per quest ever" via same unique).
- Negative: impossible by construction (only spend facts that were allowed at client or accepted at server; projection can be negative only on import bugs, which we correct with explicit CORRECTION events).
- Overspend: client may over-spend locally against stale projection; server on sync simply records the spends + any rewards in the batch, returns the true projection. Client corrects (un-reveal if we decide to, or let the overspend stand and show negative "debt" until next earn — policy decision).
*Accounting / Maintainability:* Excellent. Events are the source of truth (append-only, immutable, replayable for audit "what was my balance on date D?"). Balance is always a view (can be materialized with triggers or computed on read + cached). Import: create historical RewardEvents + SpendEvents from old answer_cards + Getting_5 list + old Balance (as genesis correction if needed). Clear for debugging, analytics ("earnings by gift step"), future extensions (different reward kinds, expiration?).
*Pros:* Directly addresses "step-reward" nature of old gifts + "you made it". Robust against double/lost by design (facts, not mutations). Versioning trivial (snapshot frozen in the completion that caused the event). Fits "reconciliation on sync" perfectly. "Per-attempt" is natural (events link to attempt) while global balance is the projection. KISS at conceptual level: "when this step completion is recorded for a gifting step, a reward fact exists".
*Cons / Skepticism:* Slightly more entities (RewardEvent table or polymorphic events) than "just a number on user". Projection code must be correct (or use materialized view / periodic recompute + diff for corrections). Client projection for offline must faithfully re-implement the fold using only the downloaded snapshot + local state (bug here = player sees wrong "can buy?" locally, corrected on sync — acceptable per offline model). If earnings policy is complex (e.g. "gifts award only on first visit ever, not per-attempt"), the check moves to "has prior reward event for this (player, quest, step)?" — still clean. May feel over-engineered for "lightweight" economy if scale is tiny and no future real $.
*Full Cycle Verdict:* Strongest for robustness and clarity. Turns the "opaque accruing" into explicit facts tied to steps. Best long-term maintainability.

**Variant 4: Skeptical Alternative — Capability-Based Hints Without Numeric Balance (or With Non-Fungible "Hint Tokens")**

*Description:* Ditch the numeric coin altogether for v1 (or reframe). Instead of "balance of coins you can spend on any hint", earning play actions (completing a gift step, or the "you made it" terminal) directly grants *capabilities* or *unlocks*:
- Per-quest or global "hint credits" as a set: e.g. player has `unlocked_hint_spends: list< {quest_id, step_position, uses_remaining: 1 or N} >` or simply a boolean "has_earned_hint_for_step" per historical play.
- Or "hint tokens" that are earned (Gift_Coins becomes "number of hint tokens from this gift") but are non-fungible or quest-scoped (can only be spent on hints *in quests from same city / same author / same difficulty* or simply any, but tracked as set not scalar).
- Buy hint = check "has available unlock for this step/quest" (or decrement uses), mark revealed. No global number to race on.
- The "5 coins for completing" becomes "5 hint tokens" or "unlocked hints for next 5 spends" (global or scoped).
- Future real $ could buy "hint packs" as bulk unlocks.

*Earning:* On StepCompletion record for gift/terminal: insert unlock facts (or increment a uses counter on a player_quest_hint_credits row). "First only" is automatic if we only emit on first qualifying completion.
*Spend:* Check existence of unlock (or remaining >0), decrement or mark used, reveal. Pure boolean/int per (player, quest?, step) — no cross-spend races.
*Offline Fit:* Trivial. Snapshot tells which steps have "costs" (or all hints cost "1 unlock"). Client tracks its local "unlocks earned so far in this play + previously synced". Buy = mark local used + reveal. On sync: upload the used hints + any new unlocks from completions; server applies (idempotent "mark used for this step in this attempt").
*Race Mitigations:* No numeric balance → no overspend arithmetic races at all. Concurrent buys on different steps: independent unlocks. Same step: unique "used" fact per (player,step) or per-attempt. Multi-device merge: union of "used" marks (once used, used). Earning on completion: same idempotent reward fact as variant 3. Negative impossible. Import: from old Buy_hint flags + Getting_5, synthesize the unlocks that "should" have been granted (or treat old Balance as bulk "N free hint spends" global).
*Accounting:* "Clear" in a different way — audit is "which unlocks were granted by which completions, which were consumed by which hint buys". No "balance" math to get wrong. But loses easy "how many coins do I have?" display.
*Pros:* Maximum robustness (eliminates entire class of numeric races, negative, double-spend, reconciliation math bugs). KISS for the hard parts (no tx for "check >= cost"). Still supports gamification ("earn hint powers by finding gifts / completing"). Fits offline perfectly (local state is just set of earned/used). Versioning: unlocks tied to the completions on specific snapshots. If old "Gift_Coins=3" meant "this gift gives 3 hint spends", we can model as 3 uses on a token.
*Cons / Skepticism (Maximum Here):* This may violate the *business intent* of a "coin economy". The old system and all docs talk "coins", "Balance_coin", "in-game coin balance", "spend on hints", "lightweight in-game economy". Players expect a number they can see accumulate and a "cost 1 coin" UX. Capability model changes the mental model and existing content (Gift_Coins values would need reinterpretation as "hint uses granted"). Less flexible: variable hint costs harder (or require different unlock types); "I have 10 coins, this hard hint costs 3" becomes "I have 10 uses, this costs 3 uses". If future wants real-money coins or tradable, numeric is prerequisite. "Per-attempt" still needs scoping decision. Old data migration: the numeric Balance_coin + per-card Buy_hint doesn't map 1:1 to unlocks without lossy heuristics. May feel like "we changed the product" rather than "we rebuilt the backend cleanly". If the point of coins was simple variable gating without per-hint booleans everywhere, numeric wins.
*Full Cycle Verdict:* The most skeptical "what if the numeric thing is the source of all pain?" option. Excellent for robustness and simplicity of invariants ("an unlock fact exists or it doesn't"). But high risk of not matching locked "coin" language and player expectations from the existing Bubble app. Only recommend if stakeholder confirms "the economy feeling is secondary to avoiding coin bugs".

## 6. Proposed Invariants (Cross-Variant, to be Locked)

These must hold in the chosen model (and be enforced in code + tested):

1. All coin rewards originate exclusively from GameStep definitions in a specific quest snapshot (gift_coins amount on the step) or the canonical completion bonus (e.g. 5). No other sources. (Matches decisions + old.)
2. A reward fact/event for a specific (player, quest, reward_kind, [step]) is emitted at most once (idempotent; first-only for bonus via unique on (player, quest, 'COMPLETION_BONUS')).
3. Hint spend facts are 1:1 with a StepCompletion for that step in that attempt; a step cannot be "bought" twice for the same attempt.
4. Player-visible balance (or available hint uses) is always a faithful projection of the immutable reward/spend facts (or unlocks). Never mutated directly.
5. For any attempt, all rewards/spends during its lifetime use only the gift amounts and rules from the quest snapshot/version bound to that attempt.
6. Admins have no API or UI to create, delete, or adjust reward/spend facts or balances (v1). (Enforced by role + no such endpoints.)
7. No real-money purchase events for coins (v1).
8. Offline local decisions (can buy? current displayed balance) may be provisional; server reconciliation on sync is authoritative and may correct (reveal state, effective balance).
9. Reset of an attempt clears its StepCompletions and any un-banked per-attempt state, but does not retroactively revoke already-emitted (global) reward facts.
10. On import of old data: historical rewards/spends are synthesized exactly once as immutable facts; the starting balance (if using scalar) or projection matches old Balance_coin only after import events (or we accept drift and let future play correct via earnings).
11. Balance (projection) may temporarily appear negative only due to import bugs or explicit correction events; normal operation + client/server checks prevent it.
12. Multi-device / concurrent operations converge to the same set of facts (no lost or double rewards/spends).

These are the "no lost/double coins" contract.

## 7. Race Mitigations (Detailed, Model-Agnostic Where Possible)

- **Idempotency First-Class:** Every potential earn or spend action carries a natural or generated idempotency key (attempt_id + step_position + action_kind + client_timestamp or uuid). Server endpoints / sync handlers: "if fact with this key exists, return it; else create."
- **Unique Constraints at DB:** (player_id, quest_id, reward_kind) for bonuses; (attempt_id, step_position, action_kind) for per-step earns/spends. Enforces at most once.
- **Transactions for Check-Then-Act (Where Numeric):** In variants with balance check, wrap compute-projection + conditional insert in serializable tx or SELECT FOR UPDATE. Prefer variants that minimize this (events or capabilities reduce surface).
- **Event Sourcing / Append-Only Facts:** Preferred (see var 3). Facts don't race; projections do (but are disposable).
- **Sync Payload Design:** Upload is list of StepCompletions (with embedded coins_spent, local_is_revealed, client-computed earned_if_accepted). Server processes in stable order (by client step order or ts), emits rewards/spends, returns authoritative current projection + delta/corrections + which items were accepted/rejected.
- **Correction Protocol:** If server rejects a spend (overdraft) or withholds a reward (duplicate), client must roll back local UI state for that step/attempt on next load or via push. Display "syncing..." + "balance corrected".
- **Multi-Device Merge:** Facts are unioned by key. For conflicting reveals on same step: once revealed (any device), it stays revealed. For balance-affecting: the facts determine.
- **Import Special Case:** Treat as a bulk "create historical facts" job, with its own idempotency (e.g. per old answer_card id). Run once. Post-import, run a one-time projection vs old Balance_coin and log discrepancies for manual review (do not auto-adjust).
- **No Direct Scalar Mutation:** Even in "simple global" variant, the only way to change balance is via fact append. Background job or on-read can maintain a materialized_balance for perf, with checksum against log.
- **Version Binding:** All reward computations read gift amounts exclusively from the snapshot json stored with (or referenced by) the QuestAttempt / StepCompletion. Never from current quest GameSteps.
- **Client Local Projection Contract:** The PWA must implement *exactly* the same fold/projection logic as server for the data in one snapshot + local attempt state. (Test this with golden fixtures from real quests.)
- **Monitoring:** Alerts on "projection < 0 for player without recent import", "duplicate reward attempt logged", "sync correction rate > X%".

## 8. How It Fits Offline (Per 03_OFFLINE Locked Model)

- **Download:** Bundle includes full GameStep list with (for gift steps) their coin award amount (frozen from publish time), plus any "this step has a hint cost: 1" flag.
- **Local Play:**
  - Maintain per-attempt local state: completed steps, submitted answers, coins_spent per step (or used unlocks), local_projected_balance (or available_uses).
  - On reaching gift step or congrats: locally "award" (add to projected), update UI balance.
  - On buy hint for a step: if local_projected >= cost (or uses >0), set spent, deduct from local projected, reveal geo/hint locally. Pure client, no network.
  - Gifts/earns are "pending until synced" but visible locally.
- **On Sync/Reconnect:**
  - Upload the attempt's StepCompletions enriched with coins_spent_on_hint, hint_revealed, and (for analysis) any local "earned amounts I think I got".
  - Server: for each, if new, record, *emit reward facts for any gift/terminal steps per snapshot amounts* (idempotent), record spend facts.
  - Reconcile: compute authoritative player projection.
  - Response: the true current balance/uses, list of corrections (e.g. "step 7 hint spend was duplicate, not applied; your balance is actually +1 vs what you thought").
  - Client: apply corrections to local attempt state + global cached balance; re-render.
- **Versioned Offline:** Old attempt uses its old bundle's gift amounts for local earning projection and for what server will emit on sync.
- **No Connectivity Edge:** Player can exhaust local "coins" on hints, complete, earn more locally from gifts, continue spending in same session. All provisional until sync.
- **Correction Example (from doc):** "hint spend that would overdraft" → on sync, that StepCompletion may be recorded with coins_spent=0 or revealed=false (if policy is strict prevention), or accepted with negative effective, plus a note to player.
- **Fits All Variants:** Var1/3 use events/projection for the authoritative; var2 scopes to attempt (local wallet = attempt local state); var4 uses unlock sets (even simpler local state).

## 9. Recommended Tests (Adversarial, Property-Based, Golden)

- **Unit / Projection Tests:**
  - Golden fixtures: take 2-3 real quests from old data (export their page_constructor with Gift_Coins values, simulate a playthrough with gifts at positions 3,7 + terminal). Compute "expected rewards" per policy (first-only bonus or not). Assert projection matches.
  - "Fold is correct": given list of reward + spend events, balance == sum pos - sum neg. Idempotent re-fold same.
  - Version freeze: same completion on v1 snapshot emits 10; live quest now has 0 for that step → still emits 10.
- **Idempotency / Duplicate Prevention:**
  - Call "record completion for gift step" twice (same attempt+step) → only one reward event.
  - Two devices upload same spend for same step at same time → one accepted.
  - Re-complete after reset on same attempt id? (or new attempt) → bonus not re-emitted.
- **Race / Concurrency (Integration):**
  - Two concurrent "buy hint" for different steps when balance == cost for one: both succeed or one does (policy), no negative.
  - Two concurrent completions for bonus on first play: exactly one bonus event (tx or unique wins).
  - Spend while sync in flight: client local allows, server corrects.
  - Use property-based: generate random sequences of earns/spends/resets/syncs for a player; assert never negative in final projection, total earned == sum of gift amounts from the steps "completed" in the sequences (modulo first-only rules).
- **Offline + Sync:**
  - Play fully offline (multiple hints bought, gifts passed, congrats hit) → local balance updated. Sync → server events emitted, returned balance matches local (or corrected predictably). Re-load attempt sees correct reveals + balance.
  - Stale cache: device A spends last coin; device B (stale) tries spend → on sync, one or both corrected.
  - Multi-attempt: earn in attempt1, spend in attempt2 (if allowed by model) → global projection reflects both.
- **Import / Migration:**
  - Given old user.Balance_coin + list of answer_cards with Buy_hint + Getting_5 list + quest countCoinMadeIt → generate facts; assert final projection == old Balance (or documented delta) + no duplicate bonuses.
  - Re-run import job → no extra events.
- **Admin / Constraint:**
  - Attempt by admin role to call spend/reward endpoint or direct DB → denied.
  - No coin purchase path exists in v1 API.
- **Negative / Overspend Never in Normal Flow:**
  - Exhaustive: start 0, only spend after visible earn in sequence; assert >=0 always.
  - Policy test: "what if client lies and uploads spend > available?" → server records but projects negative + logs anomaly; or rejects the StepCompletion spend field.
- **Replay / Audit:**
  - From genesis events, replay to any point in time → balance at that point correct.
  - "Total coins ever earned from gifts in quest Q" query works from events.
- **Performance / Scale (for later):** Projection from 10k events is fast (or use materialized + checksum).
- **Old Behavior Equivalence (for migration validation):** For a real historical play (if full answer_card export available), the new facts should explain the old Balance change (modulo any one-time import correction).

Run these in CI against the sync/completion services + client projection code. Use real quest exports as fixtures.

## 10. Recommendation + Strong Rationale

**Recommended: Variant 3 (Step-Reward as First-Class Immutable Events Projected to Balance), with elements of Var 1 for the materialized view and Var 4's skepticism as a "what if we over-simplified numeric?" check.**

**Rationale (Robustness — No Lost/Double Coins):**
- Immutability + natural idempotency keys (tied to the StepCompletion that is already the authoritative record) makes double-earn structurally impossible and lost-earn detectable (missing fact for a recorded completion).
- Projection ensures the "master = sum earnings - spends" is never a lie; any drift is a bug in the projector, not the facts.
- Versioned gifts: solved — amount frozen in the fact at emit time from the attempt's snapshot.
- Races: minimized surface (no "read balance, decide, write" for earns; spends are facts on completions). Unique constraints + tx only where truly needed (bonus de-dup).
- Negative: only via import or explicit correction events; normal path cannot produce.
- Multi-device/offline/sync: facts union cleanly; client projection is best-effort provisional.
- Import: explicit historical facts, auditable.

**Maintainability (Clear Accounting):**
- Events are self-documenting: "this gift step in this version of this quest awarded 10 to this player on this attempt at this time because this StepCompletion was recorded."
- Easy to add: new reward kinds, analytics queries, "player lifetime earnings", admin visibility (read-only), future real-money (add 'PURCHASE' events that only admins+webhook can cause — but v1 forbids).
- "steps_for_accruing_coins_" becomes: query rewards where quest+version+attempt.
- Debugging a player complaint: dump their reward + spend events. No need to reverse-engineer 82 WFs.
- KISS at the right layer: the *concept* is simple ("rewards are facts about step completions"), implementation has the necessary machinery (events table or outbox + projector) but no more accidental complexity than old.

**Why Not the Others (Skeptical Critique):**
- Pure Var 1 without making events first-class: too easy to fall back to imperative scalar mutation + optional log (recreates Bubble debt in Rust).
- Var 2: adds conversion complexity and scoping decisions that the old data and locked docs do not clearly support; risks fragmenting the economy.
- Var 4: Too radical a product change. The existing content, player mental model (from 929 users, 21 quests), and all business docs are built around "coins" as a numeric balance you earn and spend. Capability model would require re-authoring or re-explaining every Gift_Coins value and "buy hint with coins" UX. Robustness win is real, but at cost of fidelity to the grounded business. Use it only if numeric races prove unmanageable in practice (or for a future "simplified hints" mode).
- Hybrid: Var 3 + materialized balance (for fast reads) + capability flavor for the "first-only" bonus tracking (a narrow unique fact instead of scanning all events) is ideal.

**Trade-offs Accepted:** Slightly more tables/events than "int on user". Client must implement correct local projector (but this is required anyway for offline validation of answers per locked decisions). If scale is <100 players and no one complains about coin bugs, a simpler scalar + careful tx in 2-3 endpoints could "work" — but we are building for robustness and the next 5 years, not the demo.

This recommendation maximizes "no lost/double", "clear accounting", and KISS (simple domain rule: rewards are consequences of recorded step facts) while staying faithful to every locked constraint and the extracted old intent (gifts + completions only; per-step hint spends; reconciliation; offline local play).

## 11. Status + Path at End

**Status:** COMPLETE. All task requirements executed: grounded in specified business/docs + heavily mined discovery/parsed (data_types for Gift_Coins/Balance_coin/Getting_5_coins_for_completing/countCoinMadeIt/You_made_it/Complited/Buy_hint; element_definitions for "steps_for_accruing_coins_"; workflows for triggers via grep/read + docs/05); deconstructed all listed races + exposed current flaws (opaque old WFs, double/lost on import/sync, per-attempt vs global unclear); proposed 3+ variants (exactly 1-4 as listed) with *full cycle* on each (earning, spend, offline, races, accounting, pros/cons/skepticism); invariants; race mitigations; offline fit; recommended tests; rich report written; skepticism max throughout; extracted old mechanics included.

**Deliverable:** `/home/nabor/_projects/geohod/quests/business/analysis/coins-economy-variants.md` (this file, written via tool after exhaustive reads/greps; absolute path per guidelines).

**Next / Path (Recommended, Not Scope Creep):**
- Stakeholder review + decision: lock a variant (or hybrid) in `business/08_DECISIONS_LOG.md` (update the Coins Economy section with chosen model + key invariants).
- Update related business/ (esp 01_DOMAIN add explicit RewardEvent or equivalent aggregate; 03_OFFLINE detail the sync payload for rewards; 07_ close relevant open questions).
- When implementation phase: use this as spec for the completion/sync services + client attempt state + projector. Generate tests from the recommended list + golden real-quest data.
- Migration: this informs how to synthesize facts from old answer_card + user lists (parallel to other ANALYZE tasks).
- If more adversarial cycles needed (e.g. walk a specific real quest's gift steps end-to-end), open follow-up.

**Self-Critique (as Required by Role):** This report is exhaustive within scope but relies on business docs' *descriptions* of old workflows (since parsed WFs are structural/IDs, not executable logic, and .bubble grep yielded little readable). If the "5 coin" was actually 10 or conditional on other things in the real 9 WFs, the "exact from current project" will need one more extraction pass with full exports. The recommendation privileges robustness over pure minimalism; if team velocity demands the absolute simplest scalar, Var 1 with heavy testing can be forced — but I would flag it as technical debt on day 1. No over-broadening occurred.

End of ANALYZE-04 report. Path clear. Ready for decision.