# marketplace-grants

## Purpose

Lifetime AccessGrant (idempotent, source-audited: Payment/CouponRedemption/FreeQuest/Admin) for "buy once" access that survives versions; single-quest checkout + coupon % (incl 100%); free quests using identical mechanics (grant + attempts + snapshots + facts); peer Marketplace surface (lists published quests with primary comic + template summary from snapshot; publish flow surfaces; grants/purchases flow through the surface); attempt eligibility requires valid grant or free quest (reuses player/facts post-grant for usage); TDD goldens extended for grant creation (idempotent), post-grant attempt, coupon redemption, free identical flows. Per PLAN Phase 3 Commerce after Player+Sync+Reconnect; follows SPEC/TECH AccessGrant + Commerce v1 invariants; YAGNI per explicit cuts (no real-money, no subscriptions, no cart, no external authors). (Purpose derived from proposal "New Capabilities" section; additive to facts/snapshots/prior player contracts.)

## ADDED Requirements

### Requirement: Lifetime AccessGrant is idempotent and source-audited
The system SHALL create AccessGrant records (player_id + quest_id + granted_at + source + optional source_ref) that are idempotent (at most one per player+quest; second create for same returns existing with no duplicate). Source SHALL be recorded for audit (enum: Payment | CouponRedemption | FreeQuest | Admin). Grants SHALL be lifetime (no expiry) and survive subsequent quest version publishes (grant enables access to latest published at play time; old attempts remain bound to their snapshot via facts).

#### Scenario: Idempotent grant creation on double "buy" or reconnect
- **WHEN** player "buys once" (or applies coupon) for quest "mystery-fortress-v1" as "demo-player" (first time), then immediately "buys" again (double-click, reconnect, or multi-device) with same or different source
- **THEN** only one grant record exists for (demo-player, mystery-fortress-v1); second call returns the existing grant (created=false or equivalent); no duplicate audit entry; source from first creation preserved (or last if policy allows, but idemp no new).

#### Scenario: Grant source audit for coupon 100% vs free vs payment
- **WHEN** checkout with coupon_percent=100 for a quest; or "get free" button on free-flagged quest; or "buy once" (default Payment)
- **THEN** created grant has source=CouponRedemption (for 100%), FreeQuest (for free button/flag), or Payment; grant enables identical downstream (snapshot access, attempt facts, coins from goldens).

### Requirement: Checkout + coupon % (incl 100%) creates grant; free identical
Single-quest checkout (no cart) SHALL accept optional coupon (numeric % 0-100 or code stub) and player/quest, compute effective (100% treated as free-equivalent), and create idempotent grant with appropriate source. Free quests (price=0 or explicit flag) SHALL use identical grant creation + post-grant attempt/snapshot/facts mechanics (source=FreeQuest; no special paths).

#### Scenario: Coupon 100% creates grant with CouponRedemption source, identical to free
- **WHEN** marketplace checkout for published quest, user enters coupon 100 (or clicks "get free" on free quest), "purchase" succeeds (stub)
- **THEN** grant created with source=CouponRedemption (or FreeQuest); player can immediately download/play the snapshot (same as paid); post-grant facts/attempts (gifts +5 "МИХАЙЛО ПУПИН" etc) identical in shape/projection to paid grant path; no price charged (YAGNI stub).

#### Scenario: Paid "buy once" + coupon <100 both succeed to grant
- **WHEN** checkout with no coupon (Payment source) or coupon=20 for quest
- **THEN** grant created (source=Payment or CouponRedemption); eligibility true; attempt facts flow using same snapshot as listed.

### Requirement: Marketplace peer surface lists published quests with comic + template summary; publish surfaces; grants/purchases through surface
Marketplace SHALL list currently published quests (initially goldens + registered); each entry SHALL include primary comic (derive from snapshot media.task or first non-null role or stub) + 4-template summary (e.g. counts or ordered list of templates from snapshot.steps). Publish (from ctor explicit Publish after gates) SHALL surface the snapshot (register id + name + comic + summary in backend). All "buy once"/"get free"/coupon flows SHALL go through the marketplace surface (not direct API or other entry); owned status (has grant) SHALL be visible in list (e.g. "Owned - play" vs "Buy once").

#### Scenario: Ctor publish surfaces new snapshot to marketplace list
- **WHEN** ctor completes gates + clicks Publish on edited quest (or mystery golden), serialize + surface call
- **THEN** marketplace list (re-fetch) includes the quest with primary comic (from its media) + template summary (from its steps); old attempts unaffected.

#### Scenario: Buy/get-free through marketplace creates grant and updates owned
- **WHEN** user in marketplace list clicks "Buy once" (or "Get free", or enters 100% coupon) on a published entry
- **THEN** grant created idemp (source per coupon/free), list updates to show "Owned", play link enabled to /quest?golden=... with eligibility.

### Requirement: Attempts require grant or free (eligibility reuses player/facts/snapshots)
Before creating attempt or appending facts for a quest, the player SHALL have a valid lifetime grant (or the quest is free). Eligibility SHALL reuse snapshots (for version/summary at buy time) + facts (for post-grant usage/attempts). "Owned" checks and gates SHALL be additive (preserve existing 4-template, popup, navigator, reconnect, goldens fidelity).

#### Scenario: Post-grant attempt on published snapshot produces goldens facts
- **WHEN** grant created via marketplace for mystery-fortress-v1 (or free), player opens /quest, performs happy actions ("МИХАЙЛО ПУПИН" etc)
- **THEN** facts emitted match happy-with-gift expected (incl gift_claimed +5); projectBalance=5; eligibility passed (no block); reconnect/corrections still work.

#### Scenario: No grant on non-free blocks or warns; free quest allows identical
- **WHEN** direct /quest on non-free without prior grant (or grant check fails)
- **THEN** eligibility false (banner "Access required - visit marketplace" or block first fact/advance); free quest (source FreeQuest grant or flag) allows full identical flow (facts, projections, reconnect).

### Requirement: Goldens TDD for grant/attempt/coupon/free flows + idemp
Goldens + replay harness SHALL drive TDD: extend for grant creation (idempotent calls), post-grant attempt eligibility (facts only after grant), coupon redemption (100% source + identical mechanics), free identical (same snapshot/attempt/facts as paid). RED first (failing asserts on missing grant/attempt/coupon), then impl to green. Existing happy "МИХАЙЛО ПУПИН"+gift+5 + edges + reconnect fidelity preserved.

#### Scenario: Replay extended covers grant idemp + post-grant attempt + coupon 100%
- **WHEN** replay harness (or test) calls createGrantIdemp(demo, quest, Payment) twice; then with coupon=100; then sims attempt facts only after eligible grant (free or paid); asserts on source, idemp (second no new), post-grant facts match golden, free source identical projection
- **THEN** all pass (RED until grant/checkout impl + eligibility in player/replay); happy path + edges untouched.

#### Scenario: Backend grant tests + client replay green on full flows
- **WHEN** cargo test (grant idemp, concurrent sim, coupon 100% source, post-grant facts eligibility) + npx tsx player-replay (grant scenarios + coupon + free)
- **THEN** green; gates (build/lint/reuse) pass; manual "buy in market -> grant -> attempt facts + reconnect" succeeds with fidelity.

(These ADDED map 1:1 to proposal Capabilities, design decisions (idemp key, peer surface, 100% reuse, TDD RED, YAGNI stub), PLAN/SPEC/TECH Commerce + AccessGrant, archived player/facts contracts, current skeleton (no grants yet). Testable via extended goldens, cargo, frontend gates, manual flows. No REMOVED/RENAMED.)