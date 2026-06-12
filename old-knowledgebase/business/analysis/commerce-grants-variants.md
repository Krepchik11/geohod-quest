# ANALYZE-06: Commerce, AccessGrant, Coupons, Free Quests, Lifetime Access, Single-Purchase Flow (Idempotency, % Discounts, Grant Sources) — Deep Adversarial Analysis

**Status:** Complete. Exhaustive deconstruction, 4-variant full-cycle adversarial analysis (deconstruct/expose/rebuild/self-critique each), edge matrix, recommendation, invariants, migration, offline ties, coupon constructor notes, and max documentation. Extreme skepticism applied throughout.  
**Path:** `business/analysis/commerce-grants-variants.md` (this file).  
**Grounding (per task):**  
- Core commerce: `business/02_COMMERCE_ACCESS_AND_COUPONS.md` (full: buy once own forever, % coupons incl 100%, free=identical mechanics, entities AccessGrant/Coupon/Payment/CouponRedemption, purchase/free/coupon flows, invariants idempotent (player,quest), edges listed (coupon post-payment-start, refunds/chargebacks, same-coupon race, admin grants, price/unpub mid-flow, 100% then free, old buy_a_qest mixed), open Qs on gifts, admin UI, import).  
- Domain: `business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md` (AccessGrant entity: player+quest, source Payment/CouponRedemption/FreeQuest/Admin, lifetime no expiry v1; player needs grant (or free) for Attempt or downloadable bundle; Coupon percent scope/limits; Payment supporting; cross ER; invariants grant req for attempt/dl; reject old sprawl).  
- v1 reqs/cuts/decisions: `business/06_V1_REQUIREMENTS_AND_CUT_LIST.md` (purchase+free+grant+dl core; YooKassa webhook idempotent grant creation; coupon mgmt in admin; single quest no cart/basket; import grants+attempts desired; cuts: basket, subscriptions, recurring).  
- Decisions: `business/08_DECISIONS_LOG.md` (purchase flow: single quest only v1; data import grants high-value; "Buy once, play forever"; no real $ coins/manual).  
- Assumptions/risks: `business/07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md` (assumptions: one quest at time, buy once forever; risks: import complexity; open: cart?, gifts?, 100% coupon vs free flag distinction?, coupon UI in v1?).  
- Vision/scope: `business/00_PRODUCT_VISION_AND_SCOPE.md` (lifetime access via purchase/coupon/free; commerce included v1; offline PWA; server source for grants).  
- Offline tie-in: `business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md` ("A player with valid AccessGrant (or free quest) can download the current published version"; grant gates bundle; attempts bound to snapshot at dl/start time; grants survive content updates).  
- Roles/ctor: `business/05_ROLES_PERMISSIONS_AND_AUTH.md` (Admin can create manual grants + coupons; Player actions require grant; download requires grant). `business/04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md` (admin stats incl grants; ctor surface for coupons per 02 cross-ref).  
- Why not copy: `business/09_WHY_THE_QUESTIONS.md` (old = accidental complexity, no offline/versioning, scattered mutations, 47 types).  
- Discovery (old buy_a_qest etc exactly as tasked): `discovery/parsed/data_types.json` (buy_a_qest aka "Subscription" 5 fields: subscriber/user, subscription/date, dataProcessing, subscription_number_for_sorting, Quest_name; payment 5f: user, idPayment, succeeded, amountOfMoney, quest; coupon 8f: codeWord, discount, validUntil, allQuest, countUsers, unlimited, usersHave/list.user, listQuest; no_buy 2f: user+Quest_name list (0 records); basket_buy 2f; user has denorm Buy_a_quest list + Completed_quests list + Payment list + Getting_5... + Balance_coin + 30+ other polluted fields; quest has Price + Users list + Publish_on_the_site + statusQuest); `discovery/parsed/api_events.json` + `discovery/parsed/workflows_all.json` (yKassa APIEvent: auth_unecessary=true, ignore_privacy_rules=true; expects notification+payment.succeeded with object.id/status/amount/desc("Оплата квеста ...")/payment_method/card/etc; actions: ChangeThing (cond+changes+to_change on ?sub/payment) + ScheduleAPIEvent (for async grant/card bootstrap, params user/quest/countCard/pageNumber)); `discovery/parsed/element_definitions.json` (Coupon custom def 22 WFs + states: codeword_/discount_/listquest_/countusers_/editcoupon_/...; Shop_main/Shop_quest_detail have couponapply_ states; "Coupon" reusable); `discovery/scripts/generate_docs.py` (yKassa: "Parses payment.succeeded. Updates Subscription/Payment records. Grants quest access"; journey: site detail -> initiate -> YooKassa -> yKassa webhook -> Create/update Subscription -> Unlock for User; buy_a_qest "subscriptions" P0; old mixed sub/one-time); `discovery/raw/data-api/probe_results.json` + `discovery/raw/data-api/record_counts.json` (test: 929 users, 21 quests, 556 pages; buy_a_qest/payment/coupon/basket_buy/no_buy_a_quest all 404 "Type not found" — NOT in Data API; no_buy:0; workflow probe yKassa 405 only POST); `discovery/raw/workflow-api/probe_results.json` (yKassa endpoint known); `docs/` generated (05_WORKFLOWS: payments backend yKassa grants access; 07_INTEGRATIONS: YooKassa primary via yKassa; 10_MIGRATION: buy_a_qest->subscriptions, payment->payments; 02_DATA_MODEL summaries).  
- Cross/parallel ANALYZE: `business/analysis/README.md` (ANALYZE-06 commerce grants explicitly "launching now" in wave; refs to grants in offline/progress/coins); `business/analysis/FINAL-BEST-PRACTICE-BLUEPRINT.md` (locked: "simple lifetime grants (idempotent, source-audited, single checkout v1)"; "Variants for grant model (simple flag + source log; capability token; event-sourced GrantIssued; per-attempt ticket...)"; "Grant required before download of snapshot (OFFLINE) or start attempt"; "Import of old buy_a_qest + payment + coupon as historical grants + facts"; "Players buy ... -> lifetime grant"); `business/analysis/migration-import-variants.md` (grants P0 in import; old buy_a_qest/payment/coupon as source for historical grants; quarantine legacy); `business/analysis/offline-model-variants.md` + `progress-attempt-sync-variants.md` + `coins-economy-variants.md` (grant gate for dl/attempt; idempotency everywhere; event facts preferred); `business/analysis/versioning-publishing-variants.md` (grants independent of versions; import binds historical to legacy snapshot).  
- Additional: `business/README.md`, `docs/01_APPLICATION_OVERVIEW.md`, `docs/04_API_SURFACE.md`, `docs/06_PAGES_AND_USER_JOURNEYS.md` (buy journey), `docs/08_SECURITY...` (yKassa ignore_privacy, webhook card meta), `docs/10_MIGRATION_MAPPING.md` (old buy_a_qest as "Subscription" mixed).  

**Date/Context:** 2026-06-09. Part of parallel adversarial ANALYZE wave (see `business/analysis/README.md` + FINAL-BLUEPRINT). This subagent focused exclusively on commerce-grants slice per delegation; cross-checked facts via tools (no whole-fs, stayed in /home/nabor/_projects/geohod/quests). Full cycle applied with extreme skepticism: deconstruct every listed edge + invented attacks; expose flaws in locked (02/01/03) + old (discovery); 4 variants (3 prompted + 1 invented per-attempt ticket); self-critique each; matrix; rec under robustness/idemp/no-double/clear-source + maintain/audit + KISS + offline fit. No impl code exists; purely conceptual pre-build. TDD/SOLID/DRY/KISS/YAGNI lens at model level. Max documentation: every claim tool-grounded or quoted from source.  

**Process Executed (full cycle, multiple variants, as mandated):**  
1. Grounded discovery + extraction (tools: list_dir, read_file x15+, grep x10+, run_terminal_command x8+ with python/json extracts for exact schemas/workflows/counts/probes).  
2. Deconstruct all edges/races (task list + adversarial expansions: concurrent sources, retries, races on free/coupon/payment, post-play refund+versioned content, gifts, multi-coupon, import quirks, webhook payload attacks, etc.).  
3. Expose flaws (harsh, in locked proposal + old mixed sub/one-time + basket/no_buy).  
4. 4 variants: V1 (simple lifetime flag + source audit log — locked baseline), V2 (capability/access ticket per grant w/ hooks), V3 (event-sourced: PaymentConfirmed/CouponRedeemed -> GrantIssued + projection), V4 (invented: core lifetime grant + per-attempt "download ticket" minted at snapshot dl for offline binding/stronger audit). For *each*: deconstruct (how handles edges), expose flaws, rebuild (entities/flows/invariants/ctor/migration/offline), self-critique.  
5. Edge matrix (webhook races, concurrent buys, versioned grants, import, refunds + 10+ more).  
6. Recommend (best for criteria).  
7. Exhaustive report sections: invariants, migration from old, offline dl tie (grant gate + snapshot), coupon creation ctor.  
8. Status/path at top + end.  

No broadening: stayed strictly on commerce/access/coupons/free/lifetime/single-purchase/idemp/%/sources + listed process + specified output file. Parallel awareness only for consistency (e.g. event-sourcing preference from coins/progress, grant gate from offline/versioning).

---

## Executive Summary (Adversarial)

**Business mandate (locked per 02/01/08/06):** "Buy once, own forever". Successful purchase (or 100% coupon or free grant) for player+quest creates *permanent* lifetime AccessGrant. Coupons = % discounts at purchase time (1-100; 100% = free via coupon, discount calc pre-provider, final charged = what YooKassa sees). Free quests (price=0 or explicit is_free) = *identical mechanics* to paid (add to collection, dl, play, replay; no Payment record). Single quest checkout only (v1; no basket/cart per 06 cut). Grants from Payment | CouponRedemption | FreeQuest | Admin. Idempotent creation (at most 1 per (player,quest); handles webhook retries, double-clicks). Grant *not consumed* (unlimited QuestAttempts/replays/resets per grant). Grants survive price changes/content publishes/unpubs. Coupon redemption only on successful grant. Source + source_reference for traceability. Old: buy_a_qest ("Subscription" display but one-time per-quest) + payment + coupon + basket_buy + no_buy mixed subscription-like with one-time; we simplify to pure lifetime AccessGrant.

**Core tension (the attack surface — grounded in docs + discovery):** Lifetime + idempotent + source clarity + offline gate ("grant req before dl snapshot or attempt" per 03/01) sounds simple, but collides with real payment provider asynchrony (YooKassa webhooks not tx with app state; retries; partial payloads), concurrent client actions (coupon validate + pay start; free "add" races), versioned content (grant exists while quest evolves; old attempts freeze per 03/08), post-grant mutations (refund/chargeback *after* play started + coins spent + reviews written), mixed old data (buy_a_qest without clear succeeded payment? usersHave lists vs per-redemption; no_buy 0 records unclear; basket schema but inaccessible/404; denorm pollution on user; scheduled async grants via 666-style; ignore_privacy_rules on yKassa), admin/manual bypasses, gifts (buy-for-other), multi-coupon attempts, import fidelity (historical grants must not create dups or lose ownership), and KISS pressure (no over-tokenization for "lifetime" that never expires).

**Key findings (harsh):**  
- Locked (02/01) is underspecified on *enforcement* of idempotency (unique constraint? optimistic? app-level check-then-act race window?), audit depth (enum+ref sufficient for disputes/chargebacks?), free vs 100% coupon distinction (player-visible? analytics?), pending states during payment (what prevents dl mid-webhook?), refund policy (02 assumes "no revoke for v1; log it" — but post-play + offline snapshot already downloaded = irreversible value leak), and constructor surface (coupon creation mentioned but not detailed; admin manual grants bypass everything).  
- Old system (discovery facts): buy_a_qest is misnamed "Subscription" (fields lack recurring; per-quest one-time intent) yet mixed with payments; coupon redemptions hacked via usersHave list (not first-class CouponRedemption; no per-quest scoping strong in schema); yKassa webhook (authless, privacy-ignoring, ChangeThing+Schedule only — no visible idemp key, amount reconciliation explicit, or grant creation atomic); grants "unlocked" via denorm user lists + buy_a_qest records (pollutes User like 09 warns); basket_buy/no_buy vestigial (0 records, 404); no source audit trail (hard to tell "was this from coupon 100% or payment?"); async schedules = partial states on failure; no versioning anywhere (content mutable; attempts unbound). Exactly the "accidental complexity" 09 deconstructs.  
- Common flaw: treating grant as simple boolean flag (or list membership) without first-class lifecycle/audit/events makes races, refunds, imports, and offline binding fragile. "Free=identical" hides that free has no external_id for recon, different abuse vectors. Single-checkout cuts old basket but leaves gift Q open.  
- 4 variants analyzed (full cycle): V1 (simple flag + audit log — closest to locked) is KISS but weak on replay/strong audit/refund hooks. V2 (per-grant capability tickets w/ expiration hooks) adds power for revocation/offline but risks over-tokenization (YAGNI for lifetime default). V3 (event-sourced GrantIssued from upstream confirmed events + projection) wins on robustness/idemp/audit (aligns coins/progress event prefs) but more surface. V4 (invented: lifetime grant + *per-attempt download ticket* minted at dl time) strengthens offline binding (snapshot+grant+attempt proof) + anti-share without changing core grant.  
- **Recommendation:** Hybrid leaning V3 (event-sourced core for grants + minimal lifetime AccessGrant projection) + V1 audit elements + V4 optional per-dl ticket for offline strength. Best balances: idempotent by event key/constraint (no double-access), clear source (events carry full PaymentConfirmed/CouponRedeemed/AdminGrantIssued payload), maintainable audit log (replay "why this grant on date X?"), KISS (no full capability crypto unless needed; projection keeps reads simple), offline fit (grant check at dl gates bundle; ticket can bind to specific snapshot/version for stronger client proof without per-grant expiry). Beats locked on races; beats old on everything. One-time migration synthesizes events from buy_a_qest+payment+coupon. Coupon ctor: dedicated admin form (not game-step ctor) producing Coupon + usage queries tied to redemptions/grants.  

**Risk if ignored:** Double-grants (revenue loss + support); lost grants on import (churn); webhook dup creates dup attempts/coins; chargeback player keeps play value + offline bundle; concurrent free/coupon races increment counters wrong or grant dup; version publish + lifetime grant confusion ("why my replay uses old answers?"); coupon ctor missing = no % discounts in v1; old mixed semantics leak into new (e.g. "subscription" thinking causes recurring bugs). Violates 06 success (webhook tested with retries creates grant reliably) and cross invariants (grant gate for dl).

---

## 1. Old System Deconstruction (Discovery-Grounded Facts Only — Not Sacred)

From exact tool extractions (data_types.json, api_events.json, workflows_all via python/grep, probes, record_counts, generate_docs.py, element_definitions, docs/ generated):

- **Grants/Purchases (mixed sub/one-time):** `buy_a_qest` (display "Subscription", api guess "subscription"; 5 fields: subscriber (user), subscription (date), dataProcessing (date), subscription_number_for_sorting (number), Quest_name (quest_name_constructor)). Linked via user.Buy_a_quest (list.custom.buy_a_qest denorm) + quest.Users (list.user). Also user.Completed_quests (list quests), current_quest. `payment` (5f: user, idPayment (YooKassa), succeeded (bool), amountOfMoney, quest). `basket_buy` (2f: User, Quest_name) + `no_buy` (2f: user, Quest_name list; 0 records in test; purpose unclear — free marker? "chose not to buy"?).  
- **Coupon:** `coupon` (codeWord text, discount number, validUntil date, allQuest bool (global?), countUsers, unlimited bool, usersHave list.user (who redeemed?), listQuest list quests (scoped)). Redemptions not first-class typed; hacked into coupon.usersHave + countUsers + quest/user lists. Element "Coupon" (22 WFs, custom states for editcoupon_/codeword_/discount_/listquest_/countusers_/validuntil_/error...); "couponapply_" in Shop_main (82 WFs) + Shop_quest_detail (19 WFs).  
- **yKassa webhook (grant creation path):** APIEvent "yKassa" (id bTPIu/bTPIv; auth_unecessary: true (!); ignore_privacy_rules: true (!); parameter_def auto from payload). Expects YooKassa "notification" + "payment.succeeded" with rich object: id, status, amount.value/currency, income_amount, description ("Оплата квеста <name>"), recipient, payment_method (type/bank_card, card first6/last4/expiry/issuer like Tinkoff/Mir), captured_at/created_at, paid/refundable/refunded_amount, authorization_details (rrn, auth_code, 3ds). Actions: ChangeThing (condition, changes, to_change — likely on payment or buy_a_qest/sub) + ScheduleAPIEvent (condition, date, api_event, _wf_param_user/quest/countCard/pageNumber — async handoff for grant + answer_card bootstrap). Docs: "Parses payment.succeeded. Updates Subscription/Payment records. Grants quest access." Journey: quest detail -> initiate pay (couponapply_ possible) -> YooKassa checkout -> POST yKassa -> update sub/payment -> unlock (via buy_a_qest + user lists?). Other WFs: addAnswerCard (takes Subscription or list+num), create_answer_card_list (9 actions: NewThing batches + Change + Schedule; params countCard etc for upfront per-step cards), 666/666_copy scheduled hacks, updateOldUser.  
- **Free/Other:** no_buy 0 records (schema exists but vestigial?). Free quests via price=0 on quest_name_constructor (Price number) or status/Publish_on_the_site. No explicit "is_free" or auto-grant type in schemas. Admin manual? Via direct data changes (no typed path visible).  
- **User pollution (09 warning):** 30+ fields + lists: Buy_a_quest, Completed_quests, Payment, Getting_5_coins_for_completing (dedup for 5-coin), current_quest, Balance_coin, etc. + geo/UI state (current_lat/long, closePopup, deleteUser...). Grants "ownership" via list membership or buy_a_qest existence (not clean aggregate).  
- **Scale/Access:** Test branch only (929 users, 21 quests, 556 pages ~26 steps/quest). Critical commerce types (buy_a_qest, payment, coupon, basket_buy, no_buy_*) 404 via Data API — require manual Bubble "Data -> App data -> Export NDJSON" for real migration. Volumes for historical grants/attempts unknown (prod may be larger). No counts for answer_card etc in discovery.  
- **Flaws visible even in schema/WF:** No idempotency key on webhook (replay same object.id may re-ChangeThing or re-schedule). No explicit link payment -> buy_a_qest (quest/user overlap only). Coupon "usersHave" is crude list (no timestamp, no resulting grant, race on countUsers). Async schedule = window for partial (payment succeeded but grant not yet; or card bootstrap fails). Privacy ignored on sensitive card meta. "Subscription" name + fields (no end date, no recur) = semantic lie for one-time. Basket/no_buy dead/empty. Mutable (no grant "created_at" audit beyond dates). Content live (Price changeable mid-flow). No source enum (hard to distinguish coupon vs paid vs free vs admin in data).  

This is *not* a model; it is Bubble-era imperative accumulation (1,163 WFs, 444 SetCustomState, 277 ChangeThing, scheduled everything). See 09_WHY for why we extract intent only.

---

## 2. Locked Model Snapshot (02/01/03/06/08 — For Attack)

**Entities (quoted/paraphrased):**  
- Quest: base_price (nullable/0 for free).  
- Coupon: code, discount_percent (1-100), scope (quests list or null), max_uses, uses_count, per_user_limit (default 1), valid_from, valid_to, active.  
- AccessGrant: player_id, quest_id, granted_at, source (enum: purchase, coupon, free, admin), source_reference (payment_id or coupon_redemption_id or null).  
- CouponRedemption: coupon_id, player_id, quest_id (if scoped), used_at, resulting_grant_id.  
- Payment: external_id (YooKassa), player_id, quest_id, original_amount, discount_amount, final_amount, currency, status, provider_payload (audit), created_at, confirmed_at.  

**Flows (happy + free + coupon):**  
1. Catalog (price shown; free if 0/is_free).  
2. Initiate purchase (opt coupon code).  
3. Validate coupon (limits/valid/ownership/scope; calc discount; no negative).  
4. Pay via YooKassa (provider sees final).  
5. On success (webhook or client+recon): idempotent create AccessGrant (player+quest); record Payment; if coupon: record Redemption (decr counters).  
6. Free: "Add to collection" or first view/play -> grant (no Payment). Same semantics.  
7. Replay: grant not consumed; unlimited attempts.  

**Invariants (from 02/01):** Grant at most 1 per (player,quest) lifetime. Counters only on successful grant. Free no Payment. Grants survive price/content changes. Discount at purchase time. Server source for grants. Grant (or free) req before Attempt or dl bundle.  

**Edges explicitly called out (02 + expansions):** Coupon post pay-start/pre-confirm; refunds/chargebacks (assume no revoke v1; log); same-coupon concurrent race on counter; admin manual; unpub/price change mid; 100% coupon then free ok; gifts? (open); basket? (cut, single only); import old mixed.  

**Offline tie (03/01):** "A player with valid AccessGrant (or free quest) can download the current published version of a quest." Bundle = snapshot (GameSteps + acceptable lists + gift amounts + version + integrity; ~5MB). New dl/attempt = latest published; old attempts frozen. Grant gates this.  

**Ctor/admin (04/05/02/06):** Admin can create coupons + manual grants. Coupon creation/assignment/tracking usage in quest ctor / admin surface (MVP? open). Basic stats: grants/purchases per quest.  

This is the "locked" baseline under attack.

---

## 3. Full Deconstruction: Edges, Races, and Adversarial Scenarios

Grounded + expanded (using real old quirks + locked gaps + offline/versioning cross + payment async reality):

1. **Webhook retry idempotency (core per 06 success criteria):** Same payment.succeeded delivered 2x (provider retry, network, test replay). Does ChangeThing in yKassa create dup buy_a_qest? New: grant create must be exactly-once. Window: first succeeds, second sees "exists" but must not double-redemption or double Payment row. Payload tampering? (amount mismatch vs expected; description quest name drift). Recon after client "success" + webhook lag.  
2. **Concurrent coupon + payment:** Player enters coupon (validate OK, discount applied, counter *not yet* incr per 02 "only on successful grant"), starts pay. Before webhook, re-enters same coupon or different. Or two tabs: coupon validate in tab1, pay in tab2 (no coupon). Final charged? Discount applied? Redemption? Grant source?  
3. **Free quest auto-grant races:** Quest free (price=0). Player A "Add to collection" (check no grant -> create). Player A + B hammer at same ms (or A on two devices). Counter? Dup grant? Or "first" wins but second sees grant OK (idemp). Free vs paid 100% coupon race for same quest.  
4. **Lifetime grant + versioned quest content (03/08 locked):** Grant issued on v1. Admin publishes v2 (new answers, steps, Gift_Coins). Player replays (gets v2 per "new attempt latest"). But historical attempt frozen to v1. Refund? Grant survives (per 02). What if quest archived? Existing grants + dl of *their* snapshot still work. Mid-play publish: player on old bundle continues; new dl gets new.  
5. **Refund/chargeback after play started:** Payment succeeded -> grant -> dl snapshot -> play (StepCompletions, coins spent on hints from gifts, review written, 5-coin earned). Then chargeback (YooKassa refund). Policy (02: "no, for v1 simplicity; log it"). But player has offline bundle + progress + value received. Revoke grant? (breaks replay, support hell). Keep grant but mark Payment refunded + audit? Analytics revenue vs actual? Post-play chargeback after multiple replays. Partial refund (discount was 50%; charged 50% of base).  
6. **Multi-coupon / stacked / abuse:** One coupon per purchase (assumed). But player applies couponA (25%), system validates; then before confirm applies couponB? Or admin assigns overlapping. Per-user limit=1 vs total max_uses race (two players redeem same global 10-use at same instant; counter check-then-incr). 100% coupon for paid quest later made free (grant exists; no problem per 02 but analytics double-count "free"?). Expired coupon used via client tampering pre-validate.  
7. **Gift purchases (buy for another player):** Open Q in 02/07. Player A pays for quest X for Player B. Grant to B (not A). Payment linked to A? Source? "Gift" metadata? Redemption/coupon on gift? If B already has grant? (idemp). Admin "gift" grants. Old basket_buy may have hinted at multi but 404/empty.  
8. **Import of old buy_a_qest (migration critical per 08/09/ANALYZE-09):** Historical buy_a_qest (no clear "succeeded" link always; date only) + payment (succeeded bool but may be falsey) + coupon (usersHave list, no per-redemption row) + user.Completed_quests + no_buy/basket_buy. Create grants? But dups? (player has buy_a_qest + completed_quests entry for same). Source? (purchase if payment succeeded, coupon if in usersHave, free if price0 or no_buy, admin else). Ambiguous cases: buy without payment; payment without buy; coupon redeemed but no grant. Subscription_number_for_sorting hints at ordering but not source. Old "Subscription" semantics leak (does import create recurring-like? No). Volumes unknown (manual export needed for inaccessible types).  
9. **Other adversarial (price/unpub mid, admin, dl without grant, etc.):** Price changed between cart (initiate) and confirm (webhook uses old? new? final_amount recorded at time). Quest unpub after grant (dl still allowed per offline). Admin manual grant concurrent with purchase (dup?). Dl bundle without grant (bypass check — cheat for offline play). Client lies about coupon on pay init (server must re-validate on confirm). Multi-device: device1 buys (grant), device2 "free add" races. Post-grant quest price to 0 (existing owners unaffected). Webhook for failed/refunded payment (must not grant). Description payload quest name mismatch (recon fail). Old data with soft dels or dangling quest refs.  

Every scenario must preserve: no double-access (one grant max), clear source for audit/dispute, idempotent, grant gates offline dl + attempts, free/paid 100% produce equivalent player experience.

---

## 4. Flaws Exposed in Locked (One-Time Lifetime per Quest, Single Checkout, % Coupon, Free=Identical) + Old

**Locked flaws (harsh, even though "our" proposal):**  
- Idempotency is *stated* ("at most once per (player,quest)") but not *designed* (no mention of unique DB constraint, event key, or check-then-act tx; race window on concurrent free + coupon + pay remains). 02 says "Coupon usage counters only incremented on successful grant" — but if grant create fails after counter? Or webhook after client path?  
- Source is weak enum + optional ref: for free/admin, source_reference=null → no traceability (who admin-granted when? for what reason?). Audit "why does this player have grant?" requires joining Payment or Redemption or guessing. Insufficient for chargeback disputes or "was this 100% coupon or free quest?" analytics.  
- "Free=identical mechanics" erases distinctions: free has no external_id/amount for recon; different abuse (mass free via bug vs paid fraud). Player may see "free" vs "100% coupon" differently in catalog (open Q). Post-grant, no way to tell origin in grant itself.  
- Refund policy hand-wave ("no revoke v1; log") + lifetime + offline dl = value leak. Player downloads bundle (5MB snapshot), plays, earns coins, writes review, then chargeback — grant (and offline value) survives. Log only helps support, not revenue. Versioned content makes "revoke" even messier (which snapshot to "un-dl"?).  
- Single checkout (locked 08/06) good for v1 but leaves gift Q completely open; old had basket_buy schema (even if dead) — future cart would require re-thinking grants (per-quest still OK but checkout atomicity across?).  
- Coupon in "buying model" + "quest constructor / admin surface" (02) but no details on creation ctor, validation during pay (re-entrancy?), usage reports tied to resulting_grant_id. 74 open: "is this part of MVP?" — if not, % discounts cut.  
- No pending/hold state: during pay, does player "have" anything? Can they dl? (No per grant req). Webhook lag = UX "paid but no grant yet".  
- Lifetime + versioned (cross 03): grant allows *future* attempts on *new* snapshots, but no binding of *grant itself* to version at purchase time. (OK per "survives", but analytics "purchased v1 content" lost).  
- Self-critique in 02 itself weak: lists edges but assumes "idempotent create" solves; no attack on "source enum sufficient".  

**Old flaws (even harsher — cautionary, per 09):**  
- Semantic lie: "Subscription"/buy_a_qest for one-time per-quest purchases (fields have no recur/end; used for lifetime access intent). Mixed with payment (succeeded separate) + coupon (usersHave list hack) + basket/no_buy (vestigial, 0/404).  
- No first-class grant or redemption: ownership via denorm lists on polluted User (Buy_a_quest + Completed_quests) + buy_a_qest existence. Violates 01 "deliberately minimal" + 09 "UI state + lists of everything".  
- Webhook anti-pattern: auth_unecessary + ignore_privacy_rules + no visible idempotency (replay risk on same object.id) + async Schedule for actual grant (partial states guaranteed on drop/failure). Amount recon in desc string only. Card PII in payload (logged?).  
- Coupon races/abuse: usersHave list + countUsers (check-then-mutate without tx visible; concurrent redeem same code possible; no per-redemption row with resulting "grant"). allQuest vs listQuest scoping crude. No valid_from (only validUntil).  
- Import poison: buy_a_qest dates + payment.succeeded bool + coupon.usersHave + user lists + no_buy = ambiguous sources, possible dups (buy + completed entry), dangling refs, no audit trail. "Subscription_number_for_sorting" hints ordering hacks. Mutable content means imported "success" may not match any snapshot.  
- No offline/versioning at all (09): all via connected WFs; grants "unlocked" live; no snapshot binding.  
- Dead code bloat: basket_buy schema despite 404; no_buy 0; event_* for dead calendar; 47 types.  

Both suffer "flag/list as grant" without lifecycle. Old worse (scattered, racy, no source). Locked better (clean entities) but still underspec'd on enforcement/audit/refund/offline binding depth.

---

## 5. Variant 1: Simple Lifetime Grant Flag + Source Audit Log (Locked Baseline + Minimal Hardening)

**Description (rebuild from locked):** Core AccessGrant row (unique on (player_id, quest_id); granted_at, source enum purchase| coupon|free|admin, source_reference (nullable), plus denorm quest/player for reads). *Plus* append-only GrantSourceAuditLog (or embedded immutable entries): id, grant_id, event_type (GRANT_ISSUED | COUPON_REDEEMED | PAYMENT_CONFIRMED | ADMIN_MANUAL | FREE_AUTO), payload (full Payment snapshot or coupon code+id or admin_id+reason or null), created_at, external_ref (yookassa id or coupon_redemption_id). On any grant-creating path: check/create grant under unique constraint or tx (idemp); *always* append audit entry (even if grant existed — "duplicate attempt logged"). Free path: explicit "FREE_AUTO" entry. Manual: "ADMIN_MANUAL". Coupon: first redeem record, then grant (or combined). Payment: confirmed webhook -> Payment row + audit + grant. Projection: grant row is current truth; log for history/replay/dispute. Coupon ctor separate (see later). Offline: simple "SELECT grant WHERE player+quest" before serving snapshot (or free flag on quest). Migration: for old buy_a_qest + succeeded payment -> GRANT_ISSUED + PAYMENT_CONFIRMED audit + Payment; for usersHave -> COUPON_REDEEMED + grant if missing; synthesize one audit per inferred source; flag anomalies (buy without payment).

**Deconstruct (how handles edges):**  
- Webhook retry: unique (player,quest) or INSERT ... ON CONFLICT DO NOTHING on grant; always append audit (second append is "retry logged" — idempotent read).  
- Concurrent coupon+pay: validate coupon (no counter incr yet); on final confirm path (webhook or recon) apply one source only (prefer pay over coupon? or last-wins with audit of both attempts). Tx around grant create + redemption incr.  
- Free race: same unique + audit "FREE_AUTO attempted 2x"; second succeeds as no-op.  
- Lifetime + version: grant row independent of snapshots (per 03); audit has timestamp of issue (can correlate to publish history if needed).  
- Refund post-play: never delete grant row (lifetime); append "CHARGEBACK_LOGGED" audit entry + mark Payment refunded. (Policy decision external to model.) Offline bundle already out = accepted leak for v1.  
- Multi-coupon/gift: gift = admin or special "GIFT_PURCHASE" source with payer metadata in audit payload; multi = one grant, multiple audit entries (one per source attempt).  
- Import: as above; audit explains "synthesized from buy_a_qest 123 + payment idPayment=foo on 2023-...".  

**Expose flaws (harsh self-critique of this variant):** Still relies on "grant row as flag" for runtime checks (projection not first-class); audit is append-only but if main grant mutated (rare), desync possible without tx. Source enum still coarse (audit payload is jsonb/blob — queryable?); for pure free, payload may be empty. No built-in expiration hook (lifetime default hard). Refund "log only" still leaks value (player keeps dl + play). KISS win but audit may be ignored in practice (queries on jsonb painful without indexing). Concurrent sources may produce multiple audit rows for "one" grant — correct for history but confusing ("why 3 GRANT_ISSUED?"). Import anomalies (dangling) still require quarantine table. Less robust than full event-sourcing for replay ("what was state at T?").

**Rebuild details (entities/flows/ctor/migration/offline):**  
- Tables (conceptual): access_grants (id PK, player_id, quest_id, granted_at, source, source_ref, UNIQUE(player,quest)); grant_audits (id, grant_id, event_type, payload jsonb, created_at, external_id?); payments (as 02 + grant_id?); coupon_redemptions (as 02 + audit link); coupons (as 02 + uses_count updated only on redemption success).  
- Flows: Pay path (with coupon): validate (re-validate on confirm) -> YooKassa -> webhook (idemp by external_id on Payment first, then grant+audit) -> if coupon: redemption + decr (idemp). Free: check !grant -> grant + FREE_AUTO audit (idemp). Admin: explicit grant + ADMIN_MANUAL audit (bypass pay).  
- Offline tie: before bundle materialization/serve: if quest.is_free or exists(grant for player) then ok (bind to current snapshot). Ticket not here.  
- Coupon ctor (admin surface, separate from game step ctor per 04/05): Form: code (unique, case-insens?), discount_percent (1-100), scope (all or multi-select quests), max_uses (null=unlim), per_user_limit (1), valid_from (now), valid_to, active. On save: validate no dup code, scope quests exist/published. List: usage (redemptions joined to grants + player; counters). Assign: per-player or global code. Reports: redemption rate, revenue impact (via linked payments). Part of admin (MVP or post per open).  
- Migration: idempotent job per (old buy_a_qest or user completed entry or coupon.usersHave): compute intended source, INSERT grant ON CONFLICT, append N audit rows (one per evidence: buy, payment, coupon match). Quarantine table for conflicts (e.g. buy + no_buy). Reconcile counts vs old. Post: new plays use clean paths.  

**Self-critique:** Closest to locked (minimal delta), good KISS/maintain (one row + log table simple), sufficient audit for most disputes, easy migration. But "flag + log" is half-measure — for true robustness (replay entire grant history as source of truth) or complex hooks (future expiry/revoke) it will accrete special cases. Offline fit OK (simple check) but no stronger binding (see V4). Aligns "source-audited" in FINAL-BLUEPRINT but doesn't go far as event-sourced variants in coins/progress. Risk: audit becomes write-only. Better than old (clean, no denorm lists, explicit sources).

---

## 6. Variant 2: Capability Token / Access Ticket per Grant with Expiration Hooks (Even if Default Lifetime)

**Description (rebuild):** Core lifetime AccessGrant (as V1, or even thinner: just existence marker). *On grant issue* (or on demand), mint a first-class AccessTicket/Capability: id, grant_id, player_id, quest_id, snapshot_version_at_issue (or current), minted_at, expires_at (NULL = lifetime), signature (HMAC or DB-only token), capabilities (["download_snapshot", "start_attempt", "replay"]), revoked_at (null), source_event_ref. Ticket can be "refreshed" or new one minted per dl/attempt. Hooks: on refund -> set revoked_at on active tickets for that grant (or specific). Even for default lifetime, ticket has "valid_until" for forced re-auth or binding. Offline: bundle includes ticket id + signature; client presents on sync or future dl; server validates/revokes. For v1 lifetime, most tickets never expire but hook exists. Coupon ctor same. Multiple tickets per grant OK (history of dls).

**Deconstruct (how handles edges):**  
- Webhook retry: grant unique; ticket mint idemp (or one "primary" ticket + log).  
- Concurrent: mint only after successful grant; tx.  
- Free race: same.  
- Lifetime + version: ticket can pin snapshot_version_at_issue (for the dl that minted it); grant itself lifetime allows new tickets for new versions. On publish, existing tickets for old snapshots remain valid for their attempts.  
- Refund post-play: set revoked_at on grant's tickets; on next sync/dl, reject with "access revoked (chargeback)". But offline bundle already local = player can continue local play until re-dl attempt (weak enforcement; accepted). Audit hook fires.  
- Gift: ticket issued to recipient.  
- Import: synthesize grant + one initial "legacy" ticket per historical play.  

**Expose flaws:** Over-tokenization for lifetime case (YAGNI per task prompt; "even if default lifetime" adds ceremony: token gen/validate/refresh/revoke paths, crypto or DB token table, client storage of ticket, expiry logic that mostly does nothing). Adds attack surface (token theft = grant theft until revoke; signature replay if not bound tightly to snapshot/attempt). For offline PWA: ticket in bundle helps binding but local tampering possible (client can ignore local ticket expiry); server still ultimate gate on sync. Complicates KISS (now grant + ticket + hooks vs simple flag). Revoke post-dl still leaks value (same problem as V1). Concurrency on ticket mint (if per-dl). Maintenance: token table + revocation jobs + client token mgmt. May feel like "subscription" creeping back despite cuts.  

**Rebuild details:** Similar to V1 + tickets table (or JWTs stateless with revocation list/epoch). Flows: grant create -> mint initial ticket (lifetime or short for "activation"). On dl: if valid grant, mint (or return) ticket bound to *this* snapshot_version; embed in bundle (or separate). Client stores ticket; on sync includes ticket proof. Server: validate ticket not revoked, matches player/quest/snapshot. On refund/chargeback: revoke tickets (or grant-level flag that projects to tickets). Coupon ctor unchanged. Migration: legacy grants get one "imported" ticket each (no real signature). Offline: stronger — bundle only usable with matching ticket (local check + server on sync).  

**Self-critique:** Provides the "expiration hooks" and per-grant capability for future (real expiry, time-limited promos, stronger offline anti-share via ticket binding to device/snapshot). Good for audit (tickets are explicit "uses" of grant). But directly violates "KISS (no over-tokenization)" in task. For pure lifetime + no planned expiry, this is premature generality (exactly what 09/02 warn against). Robust for refund enforcement (better than log-only) but enforcement still eventual (offline play continues). Less simple than V1; more complex than needed vs V3 (events can model revocation without tokens). Offline fit improved (binding) but at cost of token plumbing everywhere. Reject for v1 unless gifts/ promos require time-bound access.

---

## 7. Variant 3: Event-Sourced Grants (PaymentConfirmed -> GrantIssued, CouponRedeemed -> GrantIssued) + Projection

**Description (rebuild, aligns other slices):** No "grant flag" as primary mutable state. Instead: append-only GrantEvent log (or general DomainEvent with type GrantIssued | GrantRevoked | etc.). Events:  
- PaymentConfirmed {payment_id, player_id, quest_id, amount_final, external_id, ts, ...} -> causes projector to emit GrantIssued {player, quest, source: 'purchase', source_event: payment_id, ...}.  
- CouponRedeemed {redemption_id, coupon_id, player, quest, discount, ts} -> GrantIssued.  
- FreeAutoGranted {player, quest, reason, ts} -> GrantIssued.  
- AdminManual {admin_id, player, quest, reason, ts} -> GrantIssued.  
- (Future) ChargebackReceived -> GrantRevoked or Compensation event (policy).  
Grant "state" = projection (current view: for (player,quest) the latest non-revoked GrantIssued or null). Unique constraint or projector dedup on (player,quest,source_event) for idemp. Projection table (denorm for reads: player/quest -> grant_id or just bool + source summary) updated by projector (or query log on read for small scale). Coupon ctor: on create Coupon, on redeem -> CouponRedeemed event (not direct counter; projector incrs or counts events). Offline: at dl time, check projection (or replay relevant events) has valid GrantIssued for player+quest; if yes, serve current snapshot + record "SnapshotDownload" event bound to grant event. Full replay possible for "state at T".  

**Deconstruct (how handles edges — strongest here):**  
- Webhook retry: PaymentConfirmed event keyed by external_id (idemp ingest: if exists, no-op or append duplicate-ignored). Projector emits GrantIssued at most once (unique on source_event).  
- Concurrent coupon+pay: two upstream events (PaymentConfirmed + CouponRedeemed) may both try to cause GrantIssued; projector or ingest enforces "at most one GrantIssued per (player,quest)" — second is "superseded" or logged as additional source (audit via multiple events). Order by ts or causal.  
- Free race: same; first FreeAutoGranted wins the grant event.  
- Lifetime + versioned: GrantIssued event is immutable fact at a point in time; independent of snapshots. Later SnapshotDownload events reference the grant event id + the snapshot at dl time. Old attempts frozen via their download event's snapshot. Publish creates new snapshot but does not touch grant events.  
- Refund/chargeback post-play: on Chargeback event, emit GrantRevoked (or "AccessRevoked" compensation) with reason; projector marks projection revoked. On sync/dl: check projection valid. Audit full: "granted by Payment X on T1; revoked by Chargeback Y on T2". Offline bundle leak accepted but future dls/synced attempts blocked; local play may continue (policy).  
- Multi/gift: GiftPurchaseConfirmed event (special) -> GrantIssued to recipient. Multiple source events for same grant possible (audit "purchased by A as gift for B + coupon by B?").  
- Import: bulk "create historical events" job (idemp by legacy id): for each old buy/payment/coupon match, append PaymentConfirmed (synthesized), CouponRedeemed, etc. + GrantIssued. Projector runs once. Anomalies -> special "LegacyImportAnomaly" events.  

**Expose flaws:** More moving parts (event log + projector(s) + projection table or on-read fold) than simple flag (V1). For v1 scale (small users/quests) may be overkill (querying log for "has grant?" on every dl is fine if indexed, but projector adds latency/ops). Revocation modeling requires deciding policy (hard revoke vs soft + audit only) — event sourcing makes it explicit but doesn't solve the "player already has bundle" reality. Coupon redemption as event good, but ctor must emit events cleanly. Migration must synthesize *correct causal order* of events (hard if old data timestamps ambiguous). Client/offline must understand "projection may be stale until sync" (but grant check is server-side on dl). If events are the source, projection drift bug = bad (must have golden tests). May feel less "KISS" initially (though long-term DRY/robust per coins/progress slices).  

**Rebuild details:** Event store (append-only, e.g. events table with id, type, payload, ts, causation_id, correlation_id). Projectors (e.g. grant_projector: on GrantIssued/Revoked, upsert projection row player+quest -> current_grant_state + last_event_id). API: dl endpoint does "current_grant = project(player,quest); if not valid error". Sync can include grant proof. Coupon: admin create emits CouponCreated; redeem path emits CouponRedeemed (idemp via code+player+quest unique). On GrantIssued from it, link. Offline: server checks projection at dl request time; client bundle can embed "grant_event_id" for audit on sync. Migration: one-time append of historical events (idempotent job with its own keys); run projectors; verify projection matches expected counts from old. Coupon ctor: same form as V1, but on save/redeem -> events (not direct UPDATE count; count = count(Redeemed events for coupon)).  

**Self-critique:** Strongest for robustness (idemp by construction on event keys; no double-access via projector invariant; clear source = the events themselves are the audit, replayable exactly; "what grants existed on 2023-09-17?"). Maintainability high (append-only, projectors isolated, easy to add new event types like Gift or Revoked without mutating tables). Fits offline (dl decision is "does projection from events say yes?"). Directly aligns event-sourcing recs from ANALYZE coins/progress/sync (facts over mutations). KISS at *conceptual* level ("everything is event; grant is derived") even if impl has projector. Better than V1 for disputes/replay/import (full history not just "current flag + some logs"). Vs V2: no token ceremony for lifetime case (events can model limited grants later via Revoke or Expiry events). Vs old: night-and-day (no scattered lists, no async WF hacks, explicit sources). Downside: for pure v1 "lifetime no revoke ever" it may be heavier than needed — but the task requires robustness + audit + idemp, and this delivers without over-tokenizing. Minor: projector correctness must be tested (but TDD falls out naturally: "given these upstream events, projection has exactly these grants"). Recommended direction.

---

## 8. Variant 4 (Invention): Core Lifetime Grant + Per-Attempt "Ticket" Minted at Download for Stronger Offline Binding

**Description (rebuild):** Core AccessGrant (simple or event-sourced projection as V1/V3) for lifetime ownership. *Additionally*, on every "download snapshot for play" (or new attempt start) that passes grant check: *mint a bound AccessTicket* {id, grant_id, player_id, quest_id, snapshot_id (the one being dl'd), minted_at, attempt_id (if starting attempt), binding_hash (e.g. hash(grant + snapshot + player_secret or device-ish + server_nonce)), valid_until (short for this dl session or lifetime), signature}. Ticket is *per-attempt/download*, not per-grant. Core grant is the "right to obtain tickets". Offline: bundle includes the ticket (id + binding + snapshot data); client can do local validation of binding (tamper-evident). On sync: client sends ticket proof; server re-validates against grant (still valid?) + snapshot + attempt. Stronger offline binding: ticket ties the specific downloaded snapshot + the grant at dl instant; prevents simple "share the bundle file" without the ticket context (or requires sharing auth). Even for lifetime grants, ticket provides audit "this playthrough was authorized under grant G at T for snapshot S". Revoke at grant level can invalidate future tickets. Free grants also mint tickets. Coupon ctor unchanged.

**Deconstruct (how handles edges):**  
- Webhook etc: same as base grant variant (V1 or V3); ticket only on successful dl after grant exists.  
- Concurrent: grant first (idemp), then dl mints ticket (per dl, so multiple OK).  
- Free race: grant wins; subsequent dls get own tickets.  
- Lifetime + versioned: grant lifetime; each dl mints ticket bound to *the snapshot served at that moment* (old attempts keep their old tickets/snapshots). New publish -> new dls get new tickets for new S.  
- Refund post-play: revoke grant (or mark); future ticket mints fail; existing tickets for in-flight attempts can be honored or expired (policy: "play already started keeps value"). Binding helps audit "this ticket was minted pre-revoke".  
- Gift/import: gift grant -> tickets to recipient. Import: historical grants + one synthesized "legacy ticket" per inferred historical play (bound to legacy snapshot).  
- Stronger anti-abuse: sharing a quest bundle file without corresponding ticket (or player context) fails local or server checks on sync. Per-attempt mint allows "this download session" tracking.  

**Expose flaws:** Adds another concept (ticket) on top of grant — complexity creep (task warns "no over-tokenization"). For pure online dl, ticket is just a log entry; value mostly in offline PWA (where bundle + ticket travel together). Binding_hash: how strong? (device fingerprint flaky on PWA; full crypto signature requires key mgmt). If ticket lifetime short, complicates "resume old attempt after days offline" (need to re-validate or refresh ticket without new dl). Revoke still doesn't un-play the local bundle (same leak). Migration/import of "per historical play ticket" is approximate (old had no dl concept). May over-engineer anti-share (v1 trusts physical honesty for steps anyway; cheating model deprioritized per 03). Ops: ticket table + expiry/revoke jobs. Vs V3 pure events: this is "event + derived ticket artifact for offline".  

**Rebuild details:** Grant as base (prefer event-sourced from V3 for source). Ticket table or append "TicketMinted" event (id, grant_event_id, snapshot_id, attempt_id, binding, minted_at). Dl flow (grant check passes): select/ create latest snapshot; mint TicketMinted event + return ticket token to client with bundle (bundle json includes ticket_id + binding + snapshot content + hash). Client persists ticket with local snapshot/attempt. On sync: include ticket; server validates ticket matches grant still valid, snapshot matches attempt's bound version, binding ok (or just existence + player match for simplicity). On new attempt: can re-use grant or mint fresh ticket. Coupon ctor: unchanged (coupons feed into grant events, which enable tickets). Offline fit: *strong* — local bundle is self-describing with its authorizing ticket; tamper on ticket detectable; server on sync can reject if grant revoked post-mint.  

**Self-critique:** Directly addresses task invention prompt ("per-attempt 'ticket' minted at download for stronger offline binding"). Improves on pure grant (V1) by making the *dl act* auditable and bound (ties to specific snapshot/version per 03/02; supports "which download was this play from?"). Better anti-share than raw bundle dl (ticket is the "proof of purchase" at that time). Fits offline PWA perfectly (bundle carries its authorization context). Complements event-sourcing (TicketMinted is just another event in the log; projector for "active tickets per grant"). But adds surface: now grant (ownership) + ticket (use instance). For v1 where "cheating model deprioritized" and physical steps trust honesty, the binding may be overkill (simple grant check on dl + attempt binding to snapshot suffices). Risks scope creep or "subscription token" feel. Good evolution path: start with grant, layer tickets later if share/abuse or detailed dl-audit needed. Strong for robustness + offline fit; weaker on pure KISS than V1 or even V3 alone. Viable if combined (V3 events + V4 tickets for dl).

---

## 9. Edge Case Matrix (Webhooks, Concurrent, Versioned, Import, Refunds + More)

| Scenario | V1 (Flag + Audit Log) | V2 (Capability Ticket + Hooks) | V3 (Event-Sourced + Projection) | V4 (Grant + Per-DL Ticket) | Notes / Risks (all variants) |
|----------|-----------------------|--------------------------------|---------------------------------|----------------------------|------------------------------|
| Webhook retry (same succeeded 2x) | Unique grant; 2nd appends "retry" audit. Idemp. | Same + ticket mint idemp or no-op. | Event key on external_id; projector emits GrantIssued 1x. | Same as base + dl ticket separate. | Payload amount mismatch? Recon must fail 2nd safely. Old yKassa had no key visible. |
| Concurrent coupon validate + pay start | Validate no counter; confirm path picks one source or logs both. Tx on grant. | Same; ticket on final. | Two upstream events; projector dedups GrantIssued. | Same. | Discount applied? Which source wins in audit? |
| Free auto-grant race (2 players or devices at ms) | Unique (p,q); 2nd no-op + audit "race logged". | Same. | First FreeAutoGranted event wins; 2nd ignored or additional source. | Same. | Counter not needed for free; "first" semantics via event order. |
| Lifetime grant + mid-publish versioned content | Grant row independent; audits timestamped. New attempts get new S. | Ticket can pin S at mint; grant allows new tickets. | GrantIssued immutable at T; SnapshotDownload events carry S. | Ticket per dl pins exact S. | Per 03/08: old attempts frozen; grants survive. Analytics per-version via dl events. |
| Refund/chargeback *after* play started (dl + completions + coins + review) | Keep grant; append CHARGEBACK audit + Payment refund mark. (No revoke per 02 policy). | Revoke tickets (future dls blocked); existing local bundles leak. | Emit Chargeback + GrantRevoked/Compensation; projector updates. | Revoke affects future tickets; past ticket audit shows pre-revoke mint. | Value leak inevitable for offline (bundle out). Policy decision, not model. Support tickets high. |
| Multi-coupon or overlapping | One grant; multiple redemption audits or error on 2nd. | Same. | Multiple Redeemed events; GrantIssued 1x (or multi-source). | Same. | Per-user limit enforcement at redeem time (idemp event). |
| Gift purchase (A pays for B) | Grant to B; audit "GIFT from A" payload. Payment to A. | Ticket to B. | GiftPurchaseConfirmed event -> GrantIssued to recipient. | Ticket to recipient. | Old basket_buy may have been attempt at this; 404 now. Metadata in payload/audit. |
| Import old buy_a_qest + payment + coupon + no_buy (ambiguous/dup) | Grant + N audit rows (one per evidence); quarantine anomalies. | + legacy ticket per inferred play. | Append synthesized events (PaymentConfirmed etc + GrantIssued); projector; anomaly events. | Same + legacy tickets bound to v0 snapshot. | Per ANALYZE-09: high value grants P0; fidelity lossy; manual export needed (404 types); one-time idemp job. Old "sub" semantics ignored. |
| Coupon used after pay started pre-confirm | Discount may apply or not; confirm path decides source. Audit both attempts. | Same. | Redeemed event only on success path. | Same. | Per 02 edge. Final charged = what provider saw. |
| Quest unpub/price change mid-flow or post-grant | Grant survives; dl allowed for grantees (per offline). Audit notes timing. | Ticket valid for its S even if unpub. | Events at T independent of quest status. | Ticket pins S at mint time. | 06 "should": unpub hides from *new* buyers; existing grants work. |
| Admin manual grant concurrent with pay | Dup prevented by unique; audits for both (manual + purchase). | Same. | Events from both; dedup grant. | Same. | Manual bypasses pay; source clear in audit/event. |
| Dl snapshot without (or revoked) grant | Server check fails pre-bundle. | Ticket check fails. | Projection check fails. | Grant + ticket check. | Core invariant (03/01). Offline local play possible post-dl until sync/re-dl. |
| 100% coupon then quest made free for all | Grant exists (coupon source); free path no-op for that player. | Same. | CouponRedeemed event; later Free events don't re-issue. | Same. | Per 02 "no problem". Analytics distinguish sources. |

Matrix covers task-mandated (webhook races, concurrent buys, versioned grants, import, refunds) + all deconstructed. All variants can satisfy core invariants with proper tx/unique/keys; differences in audit depth, revocation power, offline binding strength, and complexity.

---

## 10. Recommendation (Robustness, Maintainability, KISS, Offline Fit)

**Best:** Primary V3 (event-sourced grants via upstream confirmed events + projection) *augmented with* V1-style audit elements (or the events *are* the audit) + selective V4 (per-dl TicketMinted events/tickets for offline snapshot binding when stronger proof needed, e.g. future anti-abuse or detailed analytics). Or start V1 hardened + evolve to V3 (events are natural for the "source" requirement).

**Rigorous why (under all criteria + skepticism):**  
- **Robustness (idempotent grants, no double-access, clear source):** V3 wins — event keys (external_id for payments, (coupon,player,quest) for redemptions) + projector dedup make dup impossible structurally. Sources *are* the events (full payload, causation). Projection enforces "at most one active grant". V1/V4 similar via unique but weaker replay. V2 adds revocation power (hooks) but token theft/race new vectors. Old had none of this.  
- **Maintainability (audit log):** V3 (or V1 log) provides full history/replay ("replay all GrantIssued up to T for player X"). Events enable "what if" and easy addition (Revoked, Gift). Projection keeps reads simple (like current flag). V2 tokens are artifacts, not the log.  
- **KISS (no over-tokenization):** V3/V1 avoid V2's capability ceremony for default-lifetime case. Tickets (V4) only where dl happens (not core ownership). Avoids old denorm lists + WF hacks. Simple projection or flag for the "has access?" question.  
- **Offline fit:** All work (grant/projection check before bundle). V3 + V4 best: dl can emit SnapshotDownload + TicketMinted event (binds grant_event + snapshot); bundle carries proof; sync validates. Ties directly to 03 ("grant req for dl current published version") + versioning (tickets pin S). V1 sufficient for basic gate; V2 overkill unless expiry planned.  
- **Other:** Aligns FINAL-BLUEPRINT ("source-audited"), cross ANALYZE (events in coins/progress/sync for idemp/merge), migration (synthesize events once), ctor (events from admin actions). Beats locked (underspec'd enforcement) and old (racy, mixed, no source). For v1 small scale, V3 projector is cheap (or even on-read fold initially). Future: easy to add time-bound grants via new event types without schema change.  

**Rejected:** Pure V1 too weak on replay/audit for "clear source" + disputes. Pure V2 violates KISS/no-over-token for lifetime. Pure V4 adds unnecessary ticket for every case. Old model: never (09).  

**When to revisit:** If gifts become common (needs recipient + payer modeling), or real expiry/ promos added, or chargeback policy changes to aggressive revoke (then V2 hooks or V3 Revoked stronger). Measure real webhook dup rate, concurrent buy attempts, support tickets on "I paid but no access".

---

## 11. Hardened Invariants (v0.3 — Survive All Variants + Cross-Slices)

1. An AccessGrant (or equivalent projection from GrantIssued events) exists at most once per (player_id, quest_id) for the lifetime of the system (idempotency on all paths: webhook, free auto, coupon, admin, import, concurrent).  
2. Grant creation (or GrantIssued event) occurs *only* on confirmed success paths: PaymentConfirmed (with matching amount recon), successful CouponRedemption (counters updated only then), explicit FreeAuto or Admin. Never on "initiate" or failed.  
3. Free quests (price=0 or is_free flag on Quest) produce AccessGrants with *identical player semantics* (dl, attempts, replay) to paid/100% coupon, but *never* produce a Payment record.  
4. All monetary and grant-creating operations are idempotent w.r.t. external provider events (YooKassa object.id) and client retries (natural keys or generated idempotency keys). Duplicate delivery = no-op or logged duplicate.  
5. Coupon redemption (event or record) is 1:1 with a resulting GrantIssued (or contributes to it); usage counters (or event counts) incremented only on successful grant. Per-user and global limits enforced atomically with grant.  
6. Grants (and their authorizing events/tickets) are independent of Quest versions/snapshots/publishes/unpublishes/archives. Existing grants always allow starting new attempts (on latest S) or re-dl of snapshots bound to prior attempts.  
7. A valid grant (projection or ticket) is *required* to obtain any downloadable snapshot bundle or to create/advance a QuestAttempt (or free quest implicit grant). Server enforces at dl/attempt start time. (03/01 core.)  
8. Source is always clear and auditable: every grant has originating event(s)/audit (Payment, CouponRedemption, Free, Admin, Gift, ImportLegacy) with full payload/timestamp. No null-source grants post-migration.  
9. Refunds/chargebacks (post-grant or post-play) never delete the grant row/event (lifetime policy for v1); they append Revoked/Compensation/Chargeback events + mark Payment. Existing offline bundles and in-flight attempts may retain value (accepted leak; future access can be blocked).  
10. Multi-source for same (player,quest) (e.g. gift + own coupon) produces multiple authorizing events but at most one active grant (or explicit multi-source grant).  
11. (Import-specific) Historical grants from old buy_a_qest/payment/coupon are synthesized as one-time idempotent events/rows with "legacy" marker; no pollution of new invariants; anomalies quarantined.  
12. (Ctor) Coupon creation (admin) is separate from game step authoring; produces Coupon entity + enables redemptions that feed grant events. Usage visible in admin stats tied to grants.  
13. (Cross) Grant check + snapshot binding happens *before* any offline bundle materialization or attempt record. Tickets (if used) bind the specific dl to a grant + snapshot.  

These are testable (property-based: any sequence of retries/races/events/import produces exactly 0 or 1 grant per (p,q); projection always matches log; dl only when grant valid; etc.).

---

## 12. Migration from Old buy_a_qest / payment / coupon / basket / no_buy (Grounded + Idempotent)

Per 08/06/ANALYZE-09: "Importing historical AccessGrants (bought + free) + attempt history desired ('yes')". Grants high-value/P0.

**Strategy (one-time, idempotent job in tools/migrate-legacy/ or similar; operator provides NDJSON exports since 404 in API for these types):**  
1. Export (manual in Bubble editor for inaccessible): buy_a_qest, payment, coupon, (user for lists + emails/ids for matching), quest_name_constructor (for prices/scopes), no_buy, basket_buy if any. Map Bubble IDs to new UUIDs or keep as legacy_source_id.  
2. For each potential grant evidence (prioritized):  
   - buy_a_qest (per subscriber + Quest_name): if matching succeeded payment (by user/quest/amount/date or idPayment), source=purchase + Payment row + audit/event.  
   - payment succeeded + quest: purchase source.  
   - coupon.usersHave (list users) + listQuest or allQuest: for each user/quest in scope, CouponRedemption + grant (source=coupon) if not already from payment. Handle countUsers/unlimited as limits on synthesized redemptions.  
   - no_buy (if records appear in prod export): treat as free or "opted out" (flag, do not create grant if price>0).  
   - user.Completed_quests or Buy_a_quest lists (denorm): cross-ref to above; if no other evidence, source=free or admin (quarantine).  
   - basket_buy: ignore or map to multi (rare).  
3. Idempotency: for each legacy key (old buy_a_qest id or (user,quest) pair or coupon+user), "if corresponding grant/event exists (by legacy_source_id or natural (player,quest)), skip; else create + append events/audits".  
4. Source inference heuristic (adversarial, logged): payment succeeded? -> purchase. In coupon usersHave for that quest? -> coupon (or multi). Price was 0 at approx time? -> free. Else admin/unknown (quarantine). Multiple -> multiple audit/events, one grant.  
5. Quarantine/anomaly table: buy without payment, payment without buy_a_qest, coupon redeem no grant, dups (3 buy_a_qest for same), dangling quest refs, date inconsistencies, coin/grant mismatch. Produce report for manual review.  
6. Post-grant: link to historical QuestAttempt/StepCompletion synthesis (see migration-import-variants + offline for v0-legacy snapshots from page_constructor at import time). Grants enable "replay from history" (new attempt on current S) or "view my old plays" (bound to legacy S).  
7. Coins separate (per ANALYZE-04): set master Balance from old Balance_coin as one-time legacy credit (or compute from synthesized rewards); do not backfill into per-attempt events unless clean.  
8. Verification: counts match (old buy_a_qest succeeded ~ new grants); spot checks on real players ("I bought X in 2023, still have it"); projection vs old lists.  
9. Cutover: after import + verification, old data read-only/quarantined; new paths only.  

Ties to offline: imported grants immediately allow re-dl of synthesized legacy snapshot (for in-progress old attempts) + new current-version attempts. Per 03/02: bind imported attempts to v0-legacy snapshot materialized from migration-time page data (Answers lists etc mapped to GameStep acceptable).  

**Challenges (from deconstruct + 09):** Ambiguous sources (the mixed sub/one-time problem); incomplete exports; no per-redemption rows; mutable old content (imported "correct" may not match v0); no dl timestamps (infer from dates). Mitigated by quarantine + explicit legacy marker + audit events explaining synthesis.

---

## 13. Ties to Offline Snapshot Download Requiring Valid Grant

Per 03 (locked): "A player with valid AccessGrant (or free quest) can download the current published version of a quest." The bundle is self-contained snapshot (GameSteps + acceptable answers lists + supporting frozen + version id + integrity hash; ~5MB for PWA cache).

- **Gate:** Every variant must implement the check *server-side at dl request time* (before materializing/serving bundle or allowing attempt start). Free quest = implicit grant for all (or per-player free grant row for uniformity).  
- **Version binding:** Dl always serves *current latest published* snapshot (new attempts get new content per 08). The grant itself is *not* versioned (lifetime, survives publishes). But in V3/V4, the dl act can be an event (SnapshotDownload {grant_event_id or grant_id, snapshot_id, ts, ticket?}) — this binds the specific play authorization to a snapshot for audit/analytics/re-dl of exact bundle later (if snapshots retained per versioning analysis). Old attempts (imported or prior) keep their bound snapshot.  
- **Offline implications:** Client stores bundle + (optional) ticket/grant proof. Local validation uses the embedded snapshot data (per 03 client-full-val decision). On reconnect: sync includes proof (ticket or just player+attempt+version); server re-checks underlying grant still valid (not revoked post-dl). If grant revoked (chargeback), future syncs or re-dls can be rejected (local play may have continued — accepted). Re-dl for cleared data: requires valid grant (or historical ticket if retained); serve the snapshot bound to the attempt (may be old version).  
- **Per-variant strength:** V1: basic "has grant row?" check. V2: validate ticket (even lifetime one) at dl. V3: projection from events (or replay) says valid GrantIssued. V4: grant check + mint TicketMinted bound to *this* snapshot_id + embed in bundle (strongest local binding; "this specific download was authorized under G for S at T").  
- **Constructor/publish tie (04/02):** Publish produces the bundle-serializable shape. Stats in ctor include grants (who has access). Unpub (06 should): hides from catalog/new buyers; grant holders + their bound snapshots still dl-able.  
- **Risks (cross 03/02):** Snapshot retention needed for re-dl of old attempts (indefinite for referenced). Drift: player has old bundle (old answers); admin publishes fix — only new dls see fix. Grant check must be fast (cache projection or simple exists). Tamper: client can't "invent" grant for dl (server gate); local bundle tamper detectable via hash or on sync mismatch.  

This is non-negotiable: commerce (grant) is the gate for the entire offline PWA play experience.

---

## 14. Constructor for Coupon Creation (Admin Surface)

Per 02/05/04/06/08: "Coupons are part of the buying model and must be supported in the quest constructor / admin surface (creation, assignment, tracking usage)." "Admin can create ... coupons." "Admin UI for coupon creation and usage reports — is this part of MVP or later?" (open, but assume needed for % discounts in v1 commerce).

**Proposal (separate from GameStep ctor, in admin section):**  
- Dedicated "Coupons" admin view (or tab in broader admin/ctor).  
- Create form (fields per 02/01):  
  - code (text, unique, case-insensitive normalize on save/lookup; validation no dup).  
  - discount_percent (integer 1-100; UI slider or input; 100 special for "free via coupon").  
  - scope: radio "Platform-wide (all quests)" (allQuest=true) or "Specific quests" (multi-select from published quests list; listQuest).  
  - limits: max_uses (number or "Unlimited"), per_user_limit (default 1; usually 1), valid_from (date, default now), valid_to (date or null), active (bool).  
  - (Internal) created_by admin, created_at.  
- On create/save: validate (unique code, scope quests valid/published if specific, discount range, dates sane). Persist Coupon. (In event model: emit CouponCreated.)  
- Assignment/issuance: codes are self-serve (player enters at checkout) or admin can "issue to specific players" (pre-populate usersHave or create per-player redemptions).  
- List / management: table of coupons (code, discount, scope summary, uses_count / redemptions, active/valid, actions: edit/disable, view usage).  
- Usage / reports (tied to grants): for selected coupon, list redemptions (player, quest if scoped, used_at, resulting_grant_id link, linked Payment if any for revenue impact). Stats: redemption count/rate, total discount given, grants produced. Export CSV. Per-quest: "coupons used on this quest" in quest admin stats (cross grants).  
- Edit: limited (e.g. extend valid_to, toggle active, adjust max_uses upward); no change to issued redemptions/grants. Disable = active=false (no new).  
- Validation at purchase time (re-validate on confirm path): code lookup (active, within dates, scope matches quest or global, per-user not exceeded, total uses not exceeded) -> calc discount (final = original * (1 - pct/100); no negative). Record only on success.  
- In game step / quest ctor (04): read-only visibility (e.g. "X coupons used on this quest" in stats; perhaps "apply test coupon" in preview as admin). No creation there — separate surface to keep ctor focused on content/steps.  
- Migration tie: old coupon + usersHave -> new Coupon + redemptions (infer quests from listQuest or all).  
- Risks: code collision on import; admin error creating 100% for wrong scope; usage reports must join across payments/grants/attempts for value.  

This enables the % discount requirement without polluting quest authoring. If "not MVP", cut to manual grants only + hardcoded free; but commerce locked includes coupons.

---

## 15. Self-Critique of This Analysis + Remaining Risks

- **Thoroughness:** Used tools for *every* discovery fact (no paraphrasing old without extracts); cross-ref'd all mandated business/ + analysis/ + docs/. Deconstructed every listed edge + invented 6+ more (gifts, binding, tampering, import ambiguities). 4 variants full cycle. Matrix covers 13+. But no real prod volumes or live yKassa samples beyond probe (test branch only); prod may have more basket/no_buy usage or coupon patterns.  
- **Skepticism level:** High — attacked own locked baseline, V1 (as "our" proposal), V3 (favorite, still called out projector cost), V4 (invention, still critiqued for creep). Old system eviscerated per 09 mandate. No sacred cows (even "free=identical" questioned for analytics).  
- **Bias:** Event-sourcing preference inherited from parallel slices (coins, progress, sync) — but justified here by "clear source" + "audit log" + "idempotent" requirements + migration replay needs. KISS respected (no V2 unless needed).  
- **Gaps not closed:** Exact gift UX (recipient flow, notification?); chargeback policy (business decision beyond model); whether coupon ctor is admin-only or exposed in quest ctor preview; snapshot retention policy (cross versioning); binding strength for V4 tickets (device vs nonce). These are noted as open or policy.  
- **Risks if rec ignored:** As in exec summary + per variant critiques. Implementing naive "if not exists grant {create}" without tx/keys = dup grants under load/retry. Treating grant as mutable flag without events = lost history on import/refund. Ignoring offline gate = paid content leak. Copying old buy_a_qest as "subscription" table = recurring bugs. Weak coupon ctor = no discounts or hacked in shop WFs like old.  
- **Process note:** This is the mandated artifact. Will feed synthesis (FINAL updates, business/02 refresh if needed). Other ANALYZE (e.g. 05 progress, 09 migration) already cross-ref grants consistently.

---

## Appendix: Glossary (for Report Self-Containment)
- AccessGrant: lifetime (player,quest) ownership ticket.  
- CouponRedemption: record of % discount application leading to grant.  
- yKassa: old webhook for YooKassa payment.succeeded -> grant.  
- buy_a_qest: old "Subscription" type (actually one-time per quest).  
- Projection: derived current state from event log.  
- Snapshot: versioned quest bundle for offline (per 03/02).  

All paths lead to: robust, auditable, idempotent grants that cleanly gate offline access, with clear migration and no old mess.

**Status:** Complete. Exhaustive report written to business/analysis/commerce-grants-variants.md. All task elements addressed with max documentation and extreme skepticism.  

**Path:** `/home/nabor/_projects/geohod/quests/business/analysis/commerce-grants-variants.md` (absolute). Ready for cross-review, synthesis into FINAL-BEST-PRACTICE-BLUEPRINT.md, and updates back to business/02_COMMERCE... + 01 if invariants tightened.  
