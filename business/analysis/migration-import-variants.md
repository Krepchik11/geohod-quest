# ANALYZE-09: Data Migration/Import & Historical Fidelity — Deep Adversarial Analysis (Bubble → New System)

**Status:** Complete. Exhaustive deconstruction, variant analysis (4+), data quality exposure, recommendation, and mapping guidance.  
**Path:** `business/analysis/migration-import-variants.md` (this file).  
**Grounding (per task):**  
- Business decisions: `business/08_DECISIONS_LOG.md` (explicit "Data Import: Importing historical AccessGrants (bought + free quests) + attempt history is desired ('yes'). Full per-step history from old answer_cards is included in scope where feasible."), `business/07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md` (import desirable; "Importing old attempt history may be more complex than expected because old `answer_card` data was created through complex scheduled workflows without clean versioning."; open Q on what happens to old answer_card data).  
- Commerce/Progress/Domain: `business/02_COMMERCE_ACCESS_AND_COUPONS.md` (grants from buy_a_qest/payment/coupon/free; old mixed "Subscription"), `business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md` (snapshot-bound attempts, StepCompletions, no re-val on sync, old answer_card insufficient), `business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md` (AccessGrant, QuestAttempt + version/snapshot, StepCompletion; reject 47-type sprawl, User lists pollution), `business/00_PRODUCT_VISION_AND_SCOPE.md` (lifetime grants, multiple attempts + reset/continue, offline PWA, internal constructor).  
- Content/Coins: `business/04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md`, `business/08_DECISIONS_LOG.md` (coins from completions + step gifts only; Gift_Coins, 5-coin via Getting_5_coins_for_completing, Balance_coin, Buy_hint, countCoinMadeIt, You_made_it/Complited; timing in quest WFs + "steps_for_accruing_coins_" elements).  
- Heavy discovery: `discovery/parsed/data_types.json` (full 47 types; key: user (30f + lists: buy_a_quest, answer_card, completed_quests, Getting_5_coins_for_completing, Payment, current_quest; Balance_coin), buy_a_qest (5f: subscriber, Quest_name, subscription/date), payment (5f: user/quest/succeeded/amount/idPayment), answer_card (9f: User, Quest_name, Page_constructor, del, Buy_hint, Complited, You_made_it, Complited_quest, Count_wrong_answers), page_constructor (36f incl. Page_type 14 vals, Answer list.text, Gift_Coins, Next_page/Hint self-refs, number_page, latitude etc., Answer_card backref), quest_name_constructor/quest (31f: Price, Page list, Users list, countCoinMadeIt, completedcount, theNumberOfUsersWhoCompletedTheQuest, statusQuest, questsetting, creatorUser, geo, multilang names/summaries), statistic (9f: user/quest, right/wrong nums, Сompleted_Quest, Last_Page, Buy_help list, Viewed_Page list, Right_answers list), coupon, review_quest etc.), `discovery/parsed/workflows_all.json` + `discovery/parsed/api_events.json` (1,163 WFs total; 82 on `quest` page; APIEvents: yKassa (webhook -> ChangeThing + Schedule), create_answer_card_list (9 actions: multiple NewThing + ChangeThing + Schedule; params countCard/pageNumber/quest/user), addAnswerCard (schedules with Subscription/num/list), deleteAnswerCard, 666/666_copy hacks, updateOldUser; "steps_for_accruing_coins_" in Slide_Congratulations reusable element), `discovery/parsed/element_definitions.json` (Statistic, New_statistic, Slide_* with coin state), `discovery/parsed/option_sets.json` (Page_type 14 vals incl. questionnoanswer/gift/congratulations), `discovery/raw/data-api/record_counts.json` + `discovery/raw/data-api/probe_results.json` (test branch only: 21 quests/quest_name_constructor, 929 users, 556 page/page_constructor; 40+ types 404 "Type not found" incl. answer_card/buy_a_qest/payment/statistic/coupon/reviews/etc. — NOT in Data API), `discovery/raw/workflow-api/probe_results.json` (wfs require POST, many 405/404), `docs/10_MIGRATION_MAPPING.md` (initial type map: buy_a_qest→subscriptions, answer_card→answer_cards, payment, quest_name→quests, page_constructor→quest_pages; notes manual export needed for 40 types), `docs/02_DATA_MODEL.md` / `docs/03_DATA_MANAGEMENT.md` / `docs/05_WORKFLOWS_AND_BUSINESS_LOGIC.md` / `docs/06_PAGES_AND_USER_JOURNEYS.md` (old ER: User--o{Answer_card, buy_a_qest; Page--o{Answer_card; journeys: addAnswerCard on submit, yKassa -> Subscription grant; data management: only 6 types API-accessible, manual NDJSON export for rest; 47 types total; referential via Bubble thing IDs), `docs/01_APPLICATION_OVERVIEW.md`, `docs/09?` (via 09_WHY), `business/09_WHY_THE_QUESTIONS.md` (old = accidental complexity, no offline/versioning, scattered mutations, do not copy quirks).  
- Old docs for volumes: limited (test branch); real prod volumes unknown without full manual exports (potentially ~1k users × plays × ~20-30 steps/quest = 10k-100k+ answer_card records feasible but export-dependent).  
- Cross: `docs/04_API_SURFACE.md`, `discovery/parsed/pages.json` (quest page 82 WFs), `business/analysis/README.md` (ANALYZE-09 spawned in parallel wave).

**Date/Context:** 2026-06. Part of parallel adversarial ANALYZE wave (see `business/analysis/README.md`). Full cycle applied: deconstruct, expose flaws (old + proposals), 4+ variants, self-critique each, recommend for correctness (no lost player history) + maintainability (clean new model not polluted by old quirks). TDD/SOLID/YAGNI/KISS lens.

---

## Executive Summary (Adversarial)

**Business mandate (locked):** Import historical AccessGrants + attempt history ("yes"); per-step answer_card history "where feasible". "Buy once, play forever + unlimited replays with reset/continue". Coins earned exclusively via quest completions + gifts in steps (no manual/admin, no real-money coins v1). New attempts/downloads get latest published quest version/snapshot; old attempts bound to version started with. Client fully validates vs its snapshot; server records only (no re-val on sync).

**Core tension (the attack surface):** Old Bubble model = mutable, non-versioned, server-centric, imperative WF-driven data (answer_cards created/mutated in batches via scheduled APIEvents; progress scattered in denorm lists + per-step flags + stats; no attempt aggregate; content (page_constructor Answers, Gift_Coins, Page_type) live-editable with no history). New model (from 01/03/08) = snapshot-bound QuestAttempt + StepCompletion (immutable facts per version), clean AccessGrant, explicit versioning for offline fidelity. Mapping is lossy by nature.

**Key finding:** Full per-step fidelity is *not feasible* at 100% (data model mismatch + missing fields + incomplete exports + content drift + no persisted submitted values). "Where feasible" = best-effort summary attempts + mappable StepCompletions against import-time v0 snapshots + raw legacy metadata quarantine + audit trail. Grants are high-value and more tractable.

**Data quality from old project (harsh exposure — see dedicated section):** 
- 40+/47 types (incl. all player progress: answer_card, buy_a_qest, payment, statistic, coupon, most user lists full fields) inaccessible via Data API (404 in probes; only page/quest/user limited + upload_file/no_buy accessible in test branch). Migration requires manual Bubble editor NDJSON/CSV exports per type (error-prone, privacy/PII risk, no automation, operator-dependent).
- Volumes: discovery only test branch (21 quests, 929 users, 556 steps). Real historical player data (answer_cards) unknown scale; no counts for critical tables.
- Mutable live content + no versioning: answer_card.Page_constructor IDs point to *current* steps; post-play edits (answer fixes, reorders, type changes via 14 Page_types) make historical cards semantically invalid vs any single snapshot.
- No discrete "attempt": scattered across answer_card (per-step), statistic (agg + last_page + lists of viewed/right/buy_help), user.completed_quests / currentquest / Getting_5_coins_for_completing lists, quest.Users / counts. Ambiguous boundaries, possible overlaps/partials.
- Inconsistent/racy states: 1,163 WFs (839 ButtonClicked, 444 SetCustomState, 277 ChangeThing, 48 NewThing; 24 ScheduleAPIEvent), 82 on quest page alone + scheduled "create_answer_card_list" (9 actions: NewThing batches + Changes + reschedule), yKassa -> schedule, 666 hacks, updateOldUser, deleteAnswerCard, soft `del` on cards. No txns; connectivity drops = orphan cards, unflagged completions, wrong coins. "You_made_it" (terminal magic?) vs "Complited" (per-step?) vs "Complited_quest" (full?) — precedence/when-set unclear from schemas.
- Coin reconstruction hell: Balance_coin (user scalar), Gift_Coins (per page_constructor), countCoinMadeIt (quest), Buy_hint (per answer_card), Getting_5_coins_for_completing (user list<quest> for dedup 5-coin awards on "steps_for_accruing_coins_" in Slide_Congratulations), scattered in  quest WFs + reusables. Old may already be inconsistent.
- Missing fields for fidelity: answer_card has *no* player-submitted value (only Count_wrong_answers + flags); Answers live only on page_constructor (author acceptable). Old server-validated; no "what they typed".
- Other: PII/geo in user, duplicated quest/page vs *_constructor types, dead event_* bloat (cut), ignored privacy in WFs, unknown plugins (41+), referential via opaque Bubble IDs (dangling risk), "Subscription" display name for one-time buys (per 02), legacy auth (telegram/magic) not supported in new (08 scope cut).
- Result: Import will surface "garbage" (inconsistent grants vs completions, coin deltas, missing pages for cards, partial plays). Must be adversarial + auditable or pollutes new DB + player trust.

**Recommendation (robust alternative, variant 4 below):** Grants P0 (full, from buy_a_qest + payments + free inference + coupons if exported). Summary legacy QuestAttempts (one per inferred historical play/user+quest, bound to materialized v0 snapshot from exported current page_constructors at import time; status/aggs from Complited_quest/You_made_it/statistic). Best-effort StepCompletions (only cleanly mappable answer_cards by Page_constructor ID match into v0 steps; note gaps). Quarantine unmapped/old quirks in jsonb `legacy_metadata` + `legacy_source_id` + import_audit table (traceability, no core model pollution). Set player master coin balance from old Balance_coin (or computed historical net) as one-time legacy credit; future earnings strictly per new rules (08) from new completions/gifts only. Legacy attempts = history view + "start new attempt (current version)" (limited continue; no exact resume for old). Import = idempotent offline job (tools/migrate-legacy/) consuming operator-provided NDJSONs + producing dry-run anomaly reports. One-time cost; post-import all plays use clean snapshot model.

This delivers "no lost player history" at practical fidelity level (grants + "I completed these, with these aggs/flags, some per-step") while keeping new model (QuestAttempt/StepCompletion/AccessGrant/snapshots) pristine for maintainability, offline correctness, and future evolution. Aligns "where feasible". Shallow loses too much history; pure deep overpromises fidelity and risks bad data; dual adds permanent complexity.

**Risk if ignored:** Players lose owned quests (support tickets, refunds, churn); "erased" progress erodes trust; coin complaints; analytics start polluted; import hacks leak into runtime code (violates 09 "do not copy quirks").

---

## 1. Old System Data Creation Workflows & Mutable Model (Deconstruction)

From `discovery/parsed/data_types.json`, `api_events.json`, `workflows_all.json` (via summaries), `element_definitions.json`, `docs/05_`, `docs/06_`, `docs/03_`:

- **Grants/Purchases:** `buy_a_qest` (Subscription) + `payment` created/updated via yKassa APIEvent (POST webhook on "payment.succeeded"; parses object.id/status/amount/desc (contains quest), recipient; does ChangeThing on ?payment/sub, then ScheduleAPIEvent (params user/quest/countCard/pageNumber) for async grant + card bootstrap). `addAnswerCard` WF (takes Subscription or listSubscription + numberSubscription) also schedules. Free grants? Inferred (price=0 quests, coupons, manual, or "no_buy" inverse?); not explicit in schemas. `coupon` (code/discount/unlimited/usersHave/listQuest) separate, redemptions not strongly typed in discovery. `basket_buy` / `no_buy` supporting (0 records in test).

- **Per-play bootstrap:** `create_answer_card_list` APIEvent (params: countCard (number, likely #steps or batch size), pageNumber, quest (quest_name_constructor), user): 9 actions — ChangeThing (conditions), NewThing x3+ (create answer_card for pages?), ChangeThing updates (initial flags?), ScheduleAPIEvent (reschedule?). Called/scheduled on payment success or addAnswerCard. Suggests *upfront creation of N answer_card records per full quest play* for the user's steps.

- **Progress mutation (gameplay):** 82 WFs on `quest` page (dominant in journeys): Load quest/pages (from URL/param or currentquest on user), navigate (Next_page self-refs on page_constructor), InputChanged (for question types) → validate (server-side against live page Answers?) → ChangeThing on answer_card (set Complited, increment Count_wrong_answers on wrong, set Buy_hint=true on spend/reveal). Show/hide elements (444 SetCustomState + Hide/Show across app), page_type branches (14 options drive UI: question → answer flow; questionnoanswer/gift/congratulations → physical/gift/terminal; lead/hint/error etc.). On terminal (Slide_Congratulations reusable): "steps_for_accruing_coins_" custom state logic (in element_definitions): award Gift_Coins (from the step) + 5-coin bonus (if quest not in user's Getting_5_coins_for_completing list), update user.Balance_coin, add to user.completed_quests + Getting_5..., update quest.completedcount / theNumberOfUsersWhoCompletedTheQuest / countCoinMadeIt, set Complited_quest / You_made_it on relevant card(s), perhaps create/update statistic. "You_made_it" likely the "magic moment" flag (gift reveal or final success screen).

- **Other:** `statistic` / New_statistic (reusable on quest_name_constructor; 23 WFs): tracks per-user-per-quest right/wrong, completed, last_page (for resume?), lists of viewed/buy_help/right_answers pages (denorm for UI?). `deleteAnswerCard`, soft `del` on cards. "666"/"666_copy"/"chatbot"/"updateOldUser" (legacy batch/cleanup/scheduled hacks; updateOldUser takes countCard/pageNumber/quest/user like create). Currentquest on user for "in progress". Quest "Users" list (denorm players).

- **No attempt, no version, mutable:** Everything refers to live quest/page_constructor IDs. No snapshot/created_version on cards or stats. Content (Answers list on page_constructor — the "correct" at time, Gift_Coins, Page_type, geo, texts) editable in-place by admins (via Existing_Quest/Edit_Page reusables: 63+55 WFs). Scheduled async + imperative mutations = races, partial states on drop. Old "offline" was none (all via connected WFs/API).

- **Journey evidence (docs/06_):** Buy → yKassa → Subscription grant + unlock. Play → load page_constructors → answer submit → addAnswerCard → (re)load. Completion → review.

This is *not* a clean domain model; it is Bubble-era accumulation of UI state machines + backend mutations (per 09_WHY_THE_QUESTIONS.md, 05_WORKFLOWS).

---

## 2. New Model Snapshot (for Mapping)

From `business/01_`, `03_`, `08_`, `02_`:

- **AccessGrant** (core "ticket"): player_id + quest_id, granted_at, source (purchase | coupon | free | admin), source_reference (payment_id | coupon_redemption_id | null). Idempotent per (player,quest). Survives price/content changes. From buy_a_qest + payments (succeeded) + free inference + coupons.

- **Quest + Snapshots/Versions:** Quest (price, content metadata, status Published/etc.). On publish: materialize immutable snapshot (GameSteps sequence + acceptable answers lists (from constructor multiline) + Gift_Coins + kinds inferred from content + geo + media refs + version id). ~5MB bundle incl. protected answers for offline. New downloads/attempts get latest; old attempts frozen to their snapshot.

- **QuestAttempt** (aggregate root, one playthrough): player + quest + snapshot_version_id (bound at start/download), status (InProgress/Completed/Abandoned), started_at, last_activity, completed_at, current/last_step_pos, total_coins_spent_hints_this_attempt, wrong_answer_count (agg), etc. Multiple per (player,quest) allowed. "Continue" = resume latest in-progress using its snapshot. "Reset" = clear its StepCompletions (grant/attempt record survives); new attempt can pull latest version.

- **StepCompletion** (fact): quest_attempt + step (pos or id in that snapshot), submitted_answer (string|null for physical), player_confirmed (bool for physical), is_correct (bool — client-determined vs snapshot at time; recorded as-is), coins_spent_on_hint (int), completed_at (client time), synced_at. For offline: local first, upload on sync (server records, no re-val).

- **Coins:** Master player balance (reconciled). Earnings: on attempt completion (if rules) + gift steps (recorded via StepCompletion or dedicated gift completion). Spends: per-step in StepCompletion. No manual. Import historical balances carefully (see below). (See also ANALYZE-04 for economy.)

- **Other:** Review (post attempt), Payment (external ref + grant link), Coupon + Redemption.

Invariants: Grant required for attempt/download. Attempt bound to snapshot. Client validates its bundle. Linear v1. Etc.

**Mapping goal:** Preserve grants (access/ownership). Preserve "player X completed Y quests (with Z wrongs, W hints, on ~date)" + as many per-step facts as mappable. Do not lose history that affects player value (collection, personal stats, "I did that"). Do not pollute new aggregates/invariants with old quirks (e.g. no "Complited" flag leaking; use status + is_correct).

---

## 3. Deconstructed Challenges of Mapping

1. **Mutable non-versioned → snapshot-bound attempts:** Old cards reference live Page_constructor (ID + current content). At import, current exported page_constructors define the *only* available "historical" content. Create v0 snapshot from them (serialize ordered steps by number_page or Page list order; capture per-step: kind (infer: Page_type question* → answer-req with Answers list; questionnoanswer/gift → physical + gift; congratulations/screenafterquest → terminal; etc.), texts, Gift_Coins, geo, hint ref if any). Bind all imported attempts for that quest to *this* v0. Problem: If quest evolved (e.g. answer fixed in page_constructor.Answers after some players used old list; step added/removed/reordered; Page_type changed), imported "successes" may not match v0's acceptable list, or reference non-existent steps in v0. Old "correct" outcome may become "incorrect" (or vice versa) under v0. No way to reconstruct *what the player actually saw* without full Bubble change history (not in discovery).

2. **Incomplete data (many types not in API) + volumes:** Probes + data mgmt docs: answer_card, buy_a_qest, payment, statistic, coupon, review_quest, most user denorm lists, etc. all 404. Only content (quests/pages) + limited user accessible in test. `record_counts.json` incomplete (no player history counts). Volumes: unknown for answer_cards (critical for per-step); 21 quests small but 929 users × replays × steps could be substantial. Import requires: (a) operator enables types + API or (b) manual "Data → App data → Export NDJSON" per type in Bubble editor (one-by-one, for prod branch), redact PII, upload to discovery/raw/exports/ or feed to import job. No cursor/pagination guarantee for large; duplicates/races possible. "Full" data may be partial (soft dels, test data, dangling). Without exports, only shallow possible (from accessible user.completed_quests lists + quest.Users?).

3. **Inconsistent states from old workflows:** Scattered mutations + schedules + no txns = possible: buy_a_qest without payment succeeded (or vice versa); answer_cards with Complited_quest=true but not all per-step Complited or You_made_it; Count_wrong_answers >0 but Complited=true; Buy_hint spends without corresponding coin delta; user.Getting_5_coins_for_completing lists out of sync with actual 5-coin awards; orphan cards (user/quest deleted?); statistic vs card counts mismatch; partial batches (countCard scheduled but some NewThing failed). "del" cards. 666 hacks suggest ad-hoc fixes. Import must be *adversarial*: validate cross-refs (card.quest in exported quests; card.user in users; page ID in quest's Page list at import), flag anomalies in audit report (e.g. "user U has 3 buy_a_qest for Q but only 1 statistic"), quarantine or best-effort (e.g. create grant anyway; create attempt with status=Abandoned if flags conflict; skip bad cards). Heuristics for attempt grouping (e.g. cards created in same batch via countCard/pageNumber; or time clusters if Created Date exported; or per statistic record; or all cards for (user,quest) as *one* legacy attempt if no clear split).

4. **Coin state reconstruction:** Old: global scalar Balance_coin mutated on completion/gift. Awards: conditional 5-coin (dedup via Getting_5... list on user + "steps_for_accruing_coins_" logic in congrats slide — probably only on first full completion per quest); per-gift step Gift_Coins (awarded when? on reaching that slide or on You_made_it?). Spends: Buy_hint bool on answer_card (per-step or cumulative? when spent during play). Quest denorm countCoinMadeIt. New (08): earnings *only* via completions + gifts in steps; recorded cleanly per-attempt/StepCompletion; master balance = earnings - spends; no manual. Challenge: Historical net for a player = sum (5s + gifts from their completed attempts) - sum (Buy_hints). But to attribute per-attempt (for new model), need to know *which* gift steps were "reached" in *which* inferred attempt (map cards with You_made_it or high page numbers to gifts in v0). Dedup lists make "first time" ambiguous on import. If old data already inconsistent (e.g. Balance_coin != computed), which wins? Recommendation in robust variant: one-time set player's balance to *old Balance_coin value* (preserve what they "had"); do not backfill per-legacy-attempt earnings/spends into new accounting (or do minimal: spent = count Buy_hint cards in the attempt group; earnings=0 or flat "legacy completion credit" only if marked complete). Future plays 100% clean per new rules. Audit report coin totals pre/post.

5. **"You_made_it" vs completed + per-step semantics:** answer_card has three bools + count: Complited (likely per-step success/advance), You_made_it (terminal "magic" — gift? congrats? final physical?), Complited_quest (full play success). Possibly multiple cards per play (one per step), with flags set progressively; You_made_it/Complited_quest only on the "last" card or a special one. Statistic has separate Сompleted_Quest + last_page. In new: clean QuestAttempt.status + StepCompletions (is_correct or player_confirmed) + perhaps a terminal completion. Mapping: if any card in group has You_made_it or Complited_quest, mark attempt Completed + attach legacy flag. Per-step: map each card's Complited/Buy_hint/Count_wrong to a StepCompletion (is_correct = Complited, coins_spent = Buy_hint?1:0, wrong contrib). Gaps if not 1:1 (e.g. physical steps had fewer cards; some steps skipped). "You_made_it" may map to a specific gift/terminal StepCompletion or just attempt.completed_at + metadata.

6. **Other mapping frictions:** 
   - Dates: answer_card schema in data_types shows no explicit date fields (Bubble auto Created/Modified may be exportable); hard to order attempts or set attempt.started/completed reliably. Use subscription dates on buy, or mod dates on statistic/cards.
   - Submitted values: lost forever (old didn't persist player input, only counts/flags). New StepCompletion wants submitted_answer for audit/replay/analytics (wrong answers per version valuable per 03/08). Legacy attempts will have nulls here.
   - Step order/IDs: use number_page + Quest's Page list order for v0 positions. Cross-ref via Bubble thing ID (exported in NDJSON as _id or similar).
   - Free vs paid: grants from buy_a_qest regardless of payment (some may be coupon 100% or free or manual).
   - Multi-lang cut: ignore EN/SRB; RU only.
   - Auth/identity: map old user (by _id or telegram/email_techno) to new Player (new email+pw auth; legacy not supported). Grants/attempts attach to new identity. PII handling critical.
   - Reviews: separate, P1; map if review_quest exported.
   - Scale/ops: Small #quests helps (21 in discovery); import job must be restartable, report-only first ("--dry-run"), produce migration_audit (anomalies, counts pre/post, unmapped cards, coin deltas, flag conflicts).
   - Post-import drift: After import, if admins edit quest before "v0" is "published" in new system, or multiple imports, version carefully. Retain v0 snapshots (see ANALYZE-02).

7. **Broader risks (from 07/03/09):** Import more complex than expected. Frozen buggy answers already accepted for snapshots; imported legacy add another "frozen old data" class. If no snapshots retained for v0, old attempts un-resumable after local clear (but per rec, limited continue anyway). Player UX for legacy: must communicate "this history imported from previous system; details approximate; start fresh for current content."

---

## 4. Variants (Full Cycle: Description, Mapping Mechanics, Pros/Cons, Data Issues Hit, Self-Critique, Alignment to Goals)

**Goal criteria (from task + grounding):** 
- Correctness: no lost player history (grants preserved; attempt/completion summary + per-step max feasible; coins continuity without breaking new rules).
- Maintainability: clean new model (snapshot-bound attempts, no old flag pollution like "Complited"/"You_made_it" as first-class, no WF-scatter logic, pure StepCompletion facts); one-time import cost ok; no runtime dualism if avoidable; auditable/traceable.
- Feasibility given data: accounts for incomplete API, unknown volumes, mutability, missing submitted values, inconsistent states.
- Other: aligns decisions (import yes + per-step feasible; coins clean; snapshots); YAGNI (don't over-engineer dual for "transition" that never ends); supports offline/replay model.

### Variant 1: Shallow — Only AccessGrants + Basic Attempt Metadata; Force Replay/Start New for Historical Players
**Description:** Import buys/grants only (buy_a_qest → AccessGrant, correlate succeeded payments for source/amount/audit trail; infer frees/coupons from price=0 or missing payment or coupon redemptions if exported; user.completed_quests lists for confirmation). For history: create minimal QuestAttempt records (or just denorm "has_completed" on grant or player profile) per (user,quest) where flags/lists indicate prior play (from statistic._ompleted_quest or Complited_quest cards or completed_quests list). No (or minimal aggregate) StepCompletions. No v0 snapshots needed beyond current quest content. Players with grants see collection ("you own this"); any "old attempts" are read-only "previously played" markers (completed count, perhaps total wrongs/hints if easily aggregated from statistic). To "play again" or "continue": always start *new* QuestAttempt against *latest* published snapshot/version. Old progress not restorable in player UI.

**Mapping mechanics (shallow):**
- Grants: straightforward from buy_a_qest (per user+quest dedup), payments (for metadata), quest exports (for quest_id).
- Basic metadata: from user.completed_quests + quest stats + any accessible statistic (if exported) or count of answer_card groups (even if cards themselves not fully used). Set attempt.status=Completed if flags, started/completed ~ subscription or mod dates.
- Coins: set player.balance = old Balance_coin (one-time).
- Per-step: skip entirely (or one "legacy aggregate" completion record).
- No deep ID mapping or grouping heuristics.
- v0 not materialized specially.

**Pros:**
- Simple, low-risk import (fewer tables, less inference).
- Fast, robust to data quality problems (inconsistencies in cards ignored).
- Maintainability excellent: new model untouched by old (no legacy attempts with quirks; all post-import attempts clean snapshot-bound per 03/08). Import code tiny/throwaway.
- Correct for grants (ownership preserved; no re-purchase). Summary history ("you completed these") preserved at level that affects collection/stats.
- Aligns "where feasible" (per-step not feasible here, but grants + basic attempt yes).
- Small scale (21 quests) makes replay low-friction for players.

**Cons (harsh):**
- Loses per-step history (violates spirit of "full per-step ... where feasible" and "no lost player history"). Players who remember specific solves/hints/"You_made_it" moments feel data erased.
- "Basic attempt metadata" may be too basic (no dates, no aggs) → weak value.
- Coin: global set ok, but no attribution.
- If many historical plays, players lose sense of progress investment.

**Data quality issues hit (exposed):** Still requires full manual export of buy_a_qest, payment, user (full lists + completed_quests + Balance_coin), quests (to map), and preferably statistic (for metadata). answer_card exports optional (can ignore). Still surfaces grant-vs-completion inconsistencies (e.g. buy exists, no completed flag → still grant, no attempt marker). Low volume of critical data reduces risk. If exports incomplete, some grants missed → players lose access (bad correctness).

**Self-critique:** Pragmatic minimum. Satisfies literal "import is yes for grants + attempt history" if "history" = metadata only. But task says "per-step where feasible" implying we should try deeper if possible. Risks player perception of loss. Easy to "upgrade" later to deeper (add StepComps to existing legacy attempts) if exports obtained post-launch. Protects new model best. For MVP timeline, attractive. Rejected for over-shallowing history.

**Alignment:** High maintainability. Medium correctness (grants yes, history partial). Feasible given incompletes.

### Variant 2: Deep Reconstruction — Map Old answer_cards to New StepCompletions Against "v0 Snapshot"; Preserve Max History
**Description:** Full reverse-engineering. At import time, for each quest, materialize a v0 snapshot from exported current quest_name_constructor + its page_constructor Pages (order by number_page or list; capture all fields needed: texts, Answers (acceptable), Gift_Coins, Page_type → kind, geo, etc.). Then, group historical answer_cards (full export required) + statistic by (user, quest) into "attempts" (heuristics: batch size from countCard in creation WFs, or #cards == quest page count, or statistic records as delimiters, or time-based if dates exported; fall back to single legacy attempt per (user,quest) with all cards). For each inferred attempt: create QuestAttempt (bound to v0 snapshot_id, status from Complited_quest/You_made_it/statistic.Сompleted_Quest, aggs from counts). For each answer_card in the group: resolve Page_constructor _id to position/kind in v0 steps (exact ID match at import snapshot materialization time); create StepCompletion (submitted=null or "unknown (imported)", is_correct=Complited or from count, coins_spent=Buy_hint ?1:0, player_confirmed= (physical kind), wrong contrib=Count_wrong_answers). Map You_made_it to terminal step or attempt flag. Also pull from statistic (last_page → current pos if in-progress; lists for viewed etc. into metadata). For coins: attempt-level spent = sum Buy_hints; earnings attributed if complete (sum relevant Gift_Coins from v0 steps reached + 5 if in Getting_5 at time?); or global player balance set from old + delta logged. Import raw old records to legacy jsonb or side table for audit. Create v0 as first "published" snapshot in new quest versioning.

**Mapping mechanics (deep):**
- Snapshot materialization: import-time, from page exports + quest.Page list. Store as immutable (perhaps in same snapshot table as future versions, with import_note="v0 from Bubble export <date>").
- Grouping/attempt inference: non-trivial; use creation WF knowledge (countCard suggests per-play batch of cards for all steps).
- ID mapping: Bubble thing IDs must match between answer_card.page_constructor and page_constructor exports.
- Flags → new: Complited → is_correct (for answer steps); You_made_it/Complited_quest → attempt.completed + perhaps special terminal completion; Count_wrong → aggregate or per-comp note.
- Coins/gifts: cross-ref gift steps in v0 that have corresponding "reached" cards (high number_page or gift page_type + You_made_it).
- Statistic: enrich attempt (right_answers etc. if not derivable from cards).
- Trace: every imported row has legacy_source_type="answer_card", legacy_source_id=BubbleID, imported_at.

**Pros:**
- Maximizes "no lost player history" and "per-step where feasible": players get StepCompletions for as many old solves as mappable; can potentially "view history" or even resume a legacy attempt against v0 snapshot (if we retain v0 bundles and allow legacy version downloads).
- Preserves "You_made_it" magic as explicit terminal.
- Good for analytics (wrong counts per old "version" approximated by v0).
- Aligns business desire for attempt history.

**Cons (harsh):**
- Overpromises fidelity: submitted_answer lost (old never stored it; only counts/flags) → StepCompletions incomplete vs native new ones. "is_correct" from old server logic may not match v0's acceptable list (content drift post-play). 
- Complex, brittle heuristics for attempt boundaries and "reached" steps (risk of phantom attempts or merged plays or under-counted steps).
- Coin attribution error-prone (old logic scattered/imperative/conditional on lists).
- High data quality sensitivity: any ID mismatch (page edited/deleted), partial cards, flag conflicts, missing exports → incomplete or wrong history. Manual export step = high ops friction + potential for bad data in.
- Maintainability hit: import code complex (groupers, mappers, v0 materializer, anomaly detectors); must live forever for re-runs or corrections. If we allow "continue legacy", adds special case in player/attempt logic (version handling already complex per 03/ANALYZE-02).
- Time: full per-step for potentially large history.

**Data quality issues hit (amplified):** *All* of them. Requires *complete* manual NDJSON for answer_card + statistic + page_constructor + quest + user + buy_a_qest + payment + (for coins) full user lists. Probes show this data was never API-accessible in discovery; export process will reveal how much is actually there (vs test counts). Inconsistencies will cause mapping failures (e.g. 17% cards point to pages not in current quest export → "content drift detected"; report it). No submitted values = systemic loss. Racy old states = conflicting is_correct vs count_wrong in output. Volumes may surprise (if prod has more quests/players than test branch). "del" cards, orphans, 666 artifacts pollute unless filtered.

**Self-critique:** Noble but risky "preserve everything". Likely produces "plausible but not exact" history that can mislead (player sees "completed step 5" but under v0 it would have been wrong answer). Violates "clean new model" if legacy quirks (You_made_it special casing) leak into StepCompletion usage or queries. Over-engineering for one-time historical data (YAGNI for full replayable legacy attempts if "limited continue" suffices). If data quality bad, "max history" becomes "max garbage" — worse than shallow for trust. Good as aspirational target, but needs heavy quarantine + UI disclaimers ("imported; approximate; some steps/details unavailable due to previous system limitations"). Rejected as primary; usable as enrichment on top of robust base.

**Alignment:** High correctness (if data cooperates). Lower maintainability (complexity, potential runtime special cases). Low feasibility given incompletes + mutability.

### Variant 3: Dual Model During Transition or Import-Time Snapshot Materialization
**Description:** Hybrid/parallel tracks. Always materialize v0 snapshots at import (as deep). But store/process old data in "dual" structures: e.g. normal AccessGrant/QuestAttempt/StepCompletion for mappable parts + parallel `legacy_attempts` or `legacy_step_facts` tables (or jsonb on attempts) holding raw or partially-mapped old answer_card/statistic/buy objects, original flags (Complited/You_made_it), creation WF params (countCard), etc. Runtime: new attempts use clean snapshot path (03 model); legacy attempts use special "legacy mode" (view-only history, or limited resume using v0 bundle if retained; coin handling special). "During transition": after import + stabilization period (e.g. 6-12mo), decide to migrate legacy details into main model (or purge details, keep summaries) and delete dual paths. Or permanent dual for historical fidelity.

**Mapping mechanics:** Same deep materialization + grouping + ID mapping for the "clean" side. Plus: store full original NDJSON row or selected fields + raw flags in legacy side, linked by legacy_source_id. Dual queries/reports for admin (old vs new stats). Player UI branches on attempt.is_legacy.

**Pros:**
- Maximum flexibility/fidelity: can preserve *raw* old data exactly (bypassing mapping loss for submitted? but none existed; for flags/You_made_it semantics).
- Quarantines quirks (old flags stay in legacy side; new model pure).
- Supports phased: import shallow grants first (quick wins), later re-run with full answer_card exports for deep enrichment into legacy or main.
- "Transition" allows time to validate mappings against real player feedback.
- Import-time snapshot materialization is shared good (enables v0 binding for both sides).

**Cons (harsh):**
- Permanent complexity tax if "transition" never ends (dual code in attempt service, player UI, coin recon, sync, analytics, admin, exports, tests — forever). Violates maintainability + KISS/YAGNI.
- Risk of divergence (legacy data "updated" differently than main? or stale).
- UI/UX fragmentation for players ("why does my old attempt behave differently?").
- Still requires same full exports + faces same data quality/inference problems as deep (dual just stores the mess, doesn't solve mapping).
- Ops: two sources of truth during transition = bugs.
- After "end of transition" migration step: another complex data move.

**Data quality issues hit:** Same as deep (requires exports; inconsistencies must be handled on *both* sides or ignored on legacy). Dual may make audit easier (compare mapped vs raw), but doesn't fix root (e.g. no submitted values; content drift still makes old flags questionable vs v0).

**Self-critique:** Sounds responsible ("don't throw away info") but is classic "we'll clean it up later" that becomes technical debt. The old project itself is the cautionary tale of accumulated dual/hacky paths (page vs page_constructor, 666, scattered coin state, ignored privacy). "Dual during transition" assumes we have discipline to sunset; history of Bubble suggests otherwise. Better to do *one* high-quality import with strong auditing + quarantine (jsonb + audit table) inside the *single* model, with clear "legacy" metadata flag on normal QuestAttempt/StepCompletion rows. This achieves quarantine without dual runtime paths. Rejected as overcomplicating.

**Alignment:** Medium correctness (preserves raw). Poor long-term maintainability. Feasible short-term but not robust.

### Variant 4: Robust Alternative — Legacy Attempts with Limited Continue Capability + Best-Effort Per-Step + Strong Auditing + Quarantine (Recommended)
**Description (synthesis of best from others + adversarial lessons):** 
- **P0 Grants:** Full import of AccessGrants from buy_a_qest (dedup (user,quest)), correlate payments (for source= purchase, amount, external_id, audit), free/coupon inference (price=0 quests, coupon if exported + usersHave, or buy without payment, or special flags). Idempotent, with legacy_source.
- **v0 Snapshot Materialization (import-time, shared with deep):** For every quest with history or content, from exported quest + page_constructor Pages: create v0 (or initial) Quest + Snapshot in new system (serialize steps with captured Answers lists, Gift_Coins, inferred kinds from Page_type + content, number_page order, etc.). This "freezes" the historical content view. Future publishes create vN. (Aligns 03/08 offline/snapshot model.)
- **Summary + Best-Effort Legacy Attempts:** For each (user,quest) with grant or completed_quests or cards or statistic: infer discrete historical "plays" (use creation batch knowledge + card counts vs quest page count + statistic records + mod/created dates if exported from full NDJSON; conservative: default to *one* legacy attempt per (user,quest) aggregating all available cards/stats for that pair, unless clear evidence of multiple distinct (e.g. multiple statistic or card batch timestamps far apart)). Create QuestAttempt bound to the v0 snapshot: status = Completed if Complited_quest or You_made_it present or statistic.Сompleted_Quest, else InProgress/Abandoned based on partials; started/completed_at ≈ from buy/subscription or card/ statistic dates (or null/imported); aggs (total wrong, hints spent) summed or from statistic; last_step from Last_Page mapped if possible. 
  - Per-step: *best effort* — for every answer_card whose Page_constructor ID resolves cleanly to a step in the *v0 snapshot at import time*, create StepCompletion (submitted_answer = null /* not persisted in old */, is_correct = !!Complited (or heuristic from count_wrong==0), coins_spent_on_hint = Buy_hint ? 1 : 0, player_confirmed = (step kind physical), completed_at = card mod date, legacy_note="mapped from answer_card"). Leave gaps where no card or no ID match (common due to drift/partials). Do *not* synthesize missing steps.
  - You_made_it / terminal: map to attempt.completed=true + optional special "terminal" StepCompletion or flag in legacy_metadata.
  - Statistic: use to enrich aggs / last state if no/better than cards.
- **Coins (conservative, clean):** Do *not* attempt full per-legacy-attempt earnings attribution/replay (too error-prone, would pollute with old conditional logic). Instead: (a) for each legacy attempt, record *observed spends* (sum Buy_hint across its mapped cards) in StepCompletions (affects that attempt's total); (b) on player import, set initial master coin balance = old user.Balance_coin (or computed historical net from all their grants/attempts if cross-check passes; log as "legacy_import_credit" CoinTransaction with ref to import batch); (c) any "5-coin" or gift earnings from legacy plays are *already reflected* in that balance — do not double-count on future. New attempts/earnings (post-import) strictly follow new rules (completions + gifts in new StepCompletions/gift steps). Audit report: pre/post player balances, deltas, any mismatches with old Getting_5... lists.
- **Quarantine + Traceability (key to maintainability):** Every imported Grant/Attempt/StepCompletion/Transaction has `legacy_source_id` (Bubble _id or composite), `legacy_source_type` ("buy_a_qest" | "answer_card" | "statistic" | ...), `imported_at`, `import_batch_id`. On attempts/steps: `is_legacy=true`, optional `legacy_metadata` jsonb (raw original flags {complited, you_made_it, complited_quest, count_wrong, buy_hint, original_page_id}, creation params like countCard, unmapped fields, notes like "content_drift: page not in v0", "partial: only 12/18 cards mapped"). Do *not* add old-specific columns to core tables. Use normal StepCompletion/Attempt schema for everything.
- **Limited Continue Capability:** Legacy attempts (is_legacy) are primarily *history* (visible in player collection "past plays", admin stats, personal "I completed on...", exportable). "Continue" or "replay" from legacy: UI offers "Start new attempt (current quest version)" (pulls latest snapshot, clean new QuestAttempt). Optional advanced: if v0 snapshots retained and bundles generatable, "Replay this historical version" (downloads v0 bundle, starts/continues a *new* attempt? or the legacy one against v0 — but per 03, attempts are version-bound anyway; limit to view + reset-to-new). No automatic "resume exact old state" for legacy (avoids offline/sync complexity with frozen v0). Reset on legacy = clear its (imported) StepCompletions or just start fresh.
- **Import Implementation:** Dedicated, idempotent, auditable job (e.g. Rust binary or script in tools/import-legacy or as DB seed/migration job; consumes NDJSON files provided by ops from Bubble exports: answer_card.ndjson, buy_a_qest.ndjson, payment.ndjson, user.ndjson (full, incl lists + Balance + completed + getting5), quest_name_constructor.ndjson + page_constructor.ndjson (full fields), statistic.ndjson, coupon.ndjson if avail, review_quest.ndjson). 
  - Phases: validate schemas/cross-refs; build v0 snapshots per quest; group/map per user+quest; create grants (idempotent upsert); create/update attempts + steps (best effort, with gaps noted); coin setup + txns; write migration_audit (JSON/report table: summary counts, anomalies list e.g. "42 answer_cards with no matching page in v0 (drift or deleted steps)", "7 users Balance_coin != sum historical net (inconsistent old data, used old balance)", "3 buy_a_qest without corresponding quest export", flag conflicts, partial plays, orphans, "X grants created from completed_quests list fallback (no buy record)", coin totals, etc.).
  - Dry-run mode, sample mode, --quest=ID filters. Post-run: human review audit report before "commit" or prod data load. Traceability allows "undo" or targeted re-import/fix for specific legacy IDs.
  - Handle PII: redact or map only needed (auth handled separately).
- **After import:** Old Bubble can be decommissioned. All future data creation via new paths (clean). Legacy data is just historical rows with metadata. Can evolve (e.g. later enrich more per-step if better exports, or add player "clear my legacy history" self-service).

**Pros (vs criteria):**
- Correctness: Grants 100% preserved (no lost ownership). History: summary attempts + "as much per-step as mappable" (feasible given constraints) + aggs/flags/You_made_it semantics via metadata. No player loses "I played/completed these" or coin balance continuity. "Where feasible" respected without overclaim.
- Maintainability: New model *not polluted* — legacy is normal rows + metadata flag/jsonb (queries can filter is_legacy for special handling or ignore; core invariants hold). Single model for attempts/completions/grants. One-time import complexity (with excellent docs/audit) >> permanent dual or scattered logic. Aligns 01/03/08 clean domain. Import job auditable/re-runnable.
- Feasibility: Explicitly accounts for incompletes (shallow fallback if no answer_card export: use completed_quests + statistic + grant for summaries only), mutability (v0 from export time), missing submitted (null + note), inconsistencies (audit + best-effort + quarantine), coin scatter (conservative master set + observed spends only). Small #quests helps validation.
- Other: Supports offline (v0 is a snapshot like any other). "Limited continue" matches "unlimited replays" while respecting version binding. Exposes/handles all data quality issues upfront via report (prevents silent pollution).
- Vs 1: Preserves *more* history (per-step + aggs) without much extra cost.
- Vs 2: Doesn't overpromise (gaps explicit, submitted lost acknowledged, no full coin replay); quarantines instead of forcing perfect map.
- Vs 3: Achieves quarantine/trace *without* dual runtime paths or "transition" theater (all in one model).

**Cons (harsh, self-exposed):**
- Still lossy: no player submitted strings; possible inaccurate attempt splits or step mappings due to old data shape; v0 != exact historical view for drifted quests; coin "legacy credit" is a blunt instrument (future earnings clean, past "baked in").
- Ops dependency: requires successful full manual exports from Bubble (if editor access limited or data huge/ sensitive, may get only partial → falls to summaries). Import job non-trivial to write/test (but one-time; use sample data from discovery/parsed + synthetic inconsistent cases).
- Player communication: legacy history must be labeled ("Imported from previous system, <import date>; some per-step details unavailable or approximate due to model differences. Start a new attempt for the current version of the quest.").
- If audit shows massive quality problems (e.g. most cards unmappable), fallback to shallower summaries gracefully.
- v0 retention: if we decide *not* to keep historical snapshots long-term (per ANALYZE-02 tradeoffs), legacy attempts become "view only" (no re-download/resume of v0); still valuable as history.

**Data quality issues hit (and mitigated):** *All exposed earlier, explicitly.* The variant *requires* building the adversarial audit/report as core output of import — this turns old project flaws into actionable pre-go-live data cleanup/understanding (e.g. "we see 12% of historical plays have Complited_quest but no You_made_it card; mapped as Completed with note"). Missing API access is called out as requiring manual export process (document in runbook + this analysis). Inconsistencies/quarks quarantined rather than "fixed" or ignored. Volumes handled by scalable NDJSON ingest + grouping (test with discovery counts + scale up). No submitted values → documented limitation, not a bug in import. This is the "relentless critical analyst" approach: import doesn't hide the mess; it surfaces it safely.

**Self-critique:** This is the "Chief Staff Engineer" synthesis — pragmatic, evidence-based, risk-aware. It satisfies the business "yes" for import scope at the highest feasible fidelity without the purity violations of shallow, the overreach of deep, or the debt of dual. Conservative on coins/continue avoids baking old scattered logic into new. Audit + metadata + legacy flag = traceability and clean separation (SOLID: single model, open for extension via metadata). If data quality turns out better than feared (full exports + consistent states + stable content), the "best-effort" path naturally captures more per-step. If worse, still delivers grants + summaries (better than nothing, no lost access). One-time nature + throwaway-or-archive import tooling keeps long-term clean (DRY/YAGNI). Risks (lossy details, export ops) are called out with mitigations (UI labels, audit review gate, fallback paths). Could be critiqued as "still too much work for history" — but task + decisions mandate the attempt; this minimizes downside. Recommended after full cycle.

**Alignment:** Highest combined correctness + maintainability. Directly implements decisions (import yes + feasible per-step; snapshot binding from day 1 even for legacy; clean coins). Grounded in all specified artifacts.

---

## 5. Detailed Mapping Table (Old → New, with Caveats)

| Old (data_types / workflows) | New | Mapping Notes / Caveats / Feasibility |
|------------------------------|-----|---------------------------------------|
| buy_a_qest (subscriber, Quest_name, subscription/date, ...) + payment (succeeded, amount, idPayment, user/quest) | AccessGrant (player, quest, granted_at, source=purchase, source_ref=payment) | High. Dedup per (player,quest). Use payment for amount/audit if succeeded. Free/coupon: infer or from coupon export. Idempotent. Legacy_source. Caveat: some buys may lack payment (manual/coupon 100%/free). |
| user (Balance_coin, completed_quests list<quest>, Getting_5_coins_for_completing list<quest>, Answer_card list, current_quest, Payment list, ...) | Player (minimal + coin balance) + links | Map identity (email/telegram → new auth). completed_quests → summary attempts/grants. Balance_coin → initial player balance (legacy credit). Other lists cut (geo, UI flags per 08/01/06). Full export needed for lists. |
| answer_card (User, Quest_name, Page_constructor, Complited, You_made_it, Complited_quest, Buy_hint, Count_wrong_answers, del) | StepCompletion (in legacy QuestAttempt bound to v0) + legacy_metadata | Best-effort. Map by Page_constructor ID → v0 step pos/kind. is_correct ≈ Complited; coins_spent ≈ Buy_hint; wrong count per or agg. You_made_it/Complited_quest → attempt completed + metadata. del → ignore or note. *No submitted_answer* (lost). Gaps expected. Statistic can supplement. |
| page_constructor (36f: Page_type, Answer list.text, Gift_Coins, number_page, texts_*, geo, Hint/Next_page, Answer_card list, Quest_name) + quest Page list | GameStep in v0 Snapshot (for quest) | Materialize v0 at import from current export. Infer kind: question* (answer-req + Answers), questionnoanswer (physical), gift (gift + coins), congratulations (terminal), etc. Capture Answers (acceptable for that v0), Gift_Coins. Order by number_page or Page list. Future edits create new versions only. |
| statistic (user, quest, right/wrong nums, Сompleted_Quest, Last_Page, Buy_help/Viewed/Right_answers lists) | QuestAttempt aggs + StepCompletion notes + legacy_metadata | Enrich attempt (completed, counts, last pos if mappable). Lists → metadata or ignored (denorm). Useful fallback if no/partial cards. |
| quest_name_constructor (31f: Price, Page list, Users list, countCoinMadeIt, completedcount, theNumberOfUsers..., statusQuest, creator, geo, tags, reviews, questsetting, ...) | Quest + stats (denorm completedcount etc.) | Core. Users list → grants/attempts cross-check. Counts → init stats or audit. countCoinMadeIt → legacy note (not used in new). Price → base_price. status → published state. |
| Gift_Coins (page), countCoinMadeIt (quest), Balance_coin (user), Buy_hint (card), Getting_5... (user list), steps_for_accruing_coins_ (WF in congrats) | CoinTransaction / attempt totals / player.balance | Conservative: observed spends from cards in StepComps; player.balance = old Balance (legacy); no backfill earnings per legacy attempt (or minimal flat on complete). New earnings clean. Audit deltas vs old lists/quest counts. |
| You_made_it / Complited / Complited_quest (on card) + Page_type (congratulations etc.) | QuestAttempt.status + terminal StepCompletion + legacy_metadata {you_made_it, ...} | Map flags to status + metadata. Do not leak as core fields. "Made it" magic preserved in history view. |
| create_answer_card_list / addAnswerCard / yKassa (schedules, NewThing/ChangeThing batches) + 82 quest WFs (ChangeThing on cards) + 666 hacks | N/A (import only; no runtime equiv) | Historical only. Import replays the *results* (cards), not the WF execution. Use knowledge of batching for grouping heuristics. Ignore impl details. |
| coupon, review_quest, etc. | Coupon + Redemption; Review | P1/P2. If exported, map (usersHave → redemptions/grants). Reviews post-attempt. |

**Additional:** All with created/mod dates if exported (for attempt timing). Bubble thing IDs → legacy_source_id (for traceability, re-import, support queries). v0 snapshots get import provenance.

---

## 6. Recommended Implementation Path & Next Steps (Post-This-Analysis)

1. **Export process (ops + this analysis as spec):** Document exact Bubble steps for full NDJSON exports of required types (answer_card, buy_a_qest, payment, user (with all lists), statistic, page_constructor (full 36f), quest_name_constructor (full), coupon, review_quest, etc.). Test branch first (use discovery counts as baseline). Redact PII. Produce `discovery/raw/exports/<date>/` + checksums. Validate against probes (expect 0 for non-enabled).

2. **Import tooling:** Implement adversarial import job (in new stack or standalone; prefer typed). Input: NDJSON dir + config (dry-run, batches). Output: DB writes + `migration_audit_<batch>.json` (counts, full anomaly list with examples, coin balance report per player, unmapped % , drift report "cards vs current pages"). Idempotency via legacy_source_id upserts + batch_id.

3. **v0 + Quest bootstrap:** During import (or pre), ensure quests exist in new system with v0 snapshots materialized (can be same as or precursor to constructor publish flow). Map old quest IDs to new.

4. **Auth/identity first:** Separate user migration (emails, map old → new Player IDs) before grants/attempts. (Per 08, legacy auth cut; new email+pw.)

5. **Validation & dry-runs:** Synthetic (hand-create inconsistent old-like NDJSON from data_types + workflows knowledge: partial cards, flag conflicts, missing pages, coin mismatch). Then real test exports. Human sign-off on audit before prod load. Cross-check: grants created == expected from buy + completed lists; attempt counts reasonable vs 929 users/21 quests; total StepCompletions << total cards (gaps ok, report % mapped).

6. **Player UX + comms:** In collection/attempts UI: distinguish legacy (badge "imported <date>", "details from previous system", "start fresh" CTA prominent). History export includes legacy note. Support runbook: "legacy import issues" with audit queries.

7. **Coin continuity:** Post-import player balances match old (or documented delta). Test: old player with history + balance logs in, sees correct coins, completes new quest → earns per new rules only.

8. **Metrics of success:** All historical grants present (no "I bought X but can't access"); players see reasonable summary history + some per-step where data allowed; no coin balance complaints attributable to import; new plays 100% clean (snapshot, offline, sync); audit report reviewed + anomalies < threshold or accepted; old Bubble decommissioned.

9. **Risks & fallbacks:** If exports impossible/incomplete → shallow grants + summaries from accessible data (user.completed_quests + quest stats) + note "limited history import". If massive drift → lower expectations on per-step % mapped. Monitor post-launch support volume on "missing old progress".

10. **Documentation:** Update `business/08_DECISIONS_LOG.md` / `07_` with import outcomes if needed. Link this analysis from `docs/10_MIGRATION_MAPPING.md` (expand it). Add to runbooks.

**Related ANALYZE (cross-ref for consistency):** ANALYZE-01 (offline/snapshots), ANALYZE-02 (versioning/snapshots retention — critical for v0 legacy), ANALYZE-03 (GameStep/StepCompletion semantics — mapping target), ANALYZE-04 (coins — reconstruction), ANALYZE-05 (QuestAttempt/replay/continue — limited for legacy), ANALYZE-07 (constructor — v0 from publish).

---

## 7. Conclusion & Status

This analysis is exhaustive, adversarial, and grounded as specified. Old project data is *usable* for grants + feasible history but *not clean or complete* — the import must be engineered as a rigorous data transformation + audit exercise, not a lift. Variant 4 (robust legacy attempts) is the recommendation because it best balances the dual mandates: maximum practical historical fidelity (no lost grants or summaries) without compromising the clean, snapshot-bound, maintainable new domain model that satisfies offline, versioning, coin, and replay requirements.

**Status:** ANALYZE-09 complete. File written. Todo items marked. Ready for synthesis (SYNTH-001 per analysis/README) or implementation planning.

**Path:** `business/analysis/migration-import-variants.md`

(End of report. No further scope.)