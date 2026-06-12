# ANALYZE-05: QuestAttempt, Replay, Reset, Continue, Multi-Device & Sync Model — Deep Adversarial Analysis + Variants

**Task ID:** ANALYZE-05  
**Role:** Chief Staff Engineer + Relentless Critical Analyst (subagent)  
**Date:** 2026-06-09  
**Status:** Complete (report delivered; model in business/03 remains high-risk, unhardened)  
**Inputs Grounded:**  
- business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md (full)  
- business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md (full, "highest-risk area")  
- business/05_ROLES_PERMISSIONS_AND_AUTH.md (player ownership of attempts)  
- business/07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md (multi-device merge open; sync risks)  
- business/08_DECISIONS_LOG.md (locked client-local no-reval + snapshot binding)  
- business/06_V1_REQUIREMENTS_AND_CUT_LIST.md (explicit: "Sync logic has races → lost progress or coin overspend for real players" as v1 failure mode)  
- business/02_COMMERCE_ACCESS_AND_COUPONS.md, business/04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md, business/09_WHY_THE_QUESTIONS.md, business/00_PRODUCT_VISION_AND_SCOPE.md (supporting)  
- docs/02_DATA_MODEL.md, docs/03_DATA_MANAGEMENT.md, docs/05_WORKFLOWS_AND_BUSINESS_LOGIC.md, docs/04_API_SURFACE.md, docs/06_PAGES_AND_USER_JOURNEYS.md, docs/08_SECURITY_AND_PRIVACY.md, docs/APPENDIX/OPEN_QUESTIONS.md (legacy contrast)  
- discovery/parsed/data_types.json (answer_card, Balance_coin, Gift_Coins, Getting_5_coins_for_completing, countCoinMadeIt fields), discovery/parsed/api_events.json (addAnswerCard, create_answer_card_list, 666/666_copy, deleteAnswerCard), discovery/parsed/workflows_all.json + element_definitions (scattered coin/answer logic, "steps_for_accruing_coins_"), discovery/parsed/app.json etc.  
- business/analysis/README.md (positions this as one of the parallel adversarial passes; outputs feed SYNTH + FINAL-BEST-PRACTICE-BLUEPRINT)  

**Mandate executed:** Full cycle (describe + happy/edge + harsh flaw exposure + self-critique) on 4+ variants. Deconstruct every named race. Max documentation, maximal skepticism. No hand-waving. No "union semantics will work out." Recommendations are specific, actionable, with status + concrete path. Never assume the current proposal is safe.

**Core Thesis (Adversarial):** The model described in business/01 + business/03 (the "current" for this analysis) is a thin optimistic sketch that directly collides with the risks it itself calls out in business/06 and business/07. "Last-write or union" is not a merge strategy; it is a bug invitation. Mutable per-attempt state + client-driven completion uploads + global coin reconciliation under offline multi-device conditions is the exact failure mode the requirements list as unacceptable. Event sourcing (or strict evented facts) is the only variant that survives the races without heroic merge code or lost/double-spend outcomes. CRDTs are formal but likely YAGNI here. Pure server-authoritative fights the locked offline decision. Recommendation: hybrid event-sourced facts (append-only AttemptEvent / CoinTransaction) + projected read model for QuestAttempt current state. This must be elevated from "edge case" to core of the Play & Progress bounded context before any client or server code is written.

---

## 1. Grounding: What the Documents Actually Say (No Paraphrase)

### From business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md (absolute path: /home/nabor/_projects/geohod/quests/business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md)
- QuestAttempt is Aggregate Root "per Player + Quest".
- "Links: Player, Quest (plus the snapshot version of the quest content at start time)."
- "Status: InProgress / Completed / Abandoned."
- "Current / last step position (or explicit pointer to last completed step)."
- "Total coins spent on hints during this attempt."
- "Wrong answer count (aggregate or per step)."
- "A player can have multiple QuestAttempts for the same Quest (replay allowed)."
- StepCompletion entity: "Links to QuestAttempt + GameStep (or step position + snapshot id). For answer steps: the value the player submitted... Client timestamp of completion (for offline). Server authoritative `is_correct`... Coins spent on hint for this step... For offline play, completions are created locally first, then synced."
- Invariants (v0.2):
  2. "Each QuestAttempt ... is bound to a specific quest version/snapshot. All validation of answers during that attempt uses only the acceptable answers present in that snapshot."
  3. "The client performs validation against its local snapshot. The server records the submitted values and the validation result from that snapshot; it does not override correctness for attempts on old versions."
  4. "When a player starts a new attempt ... they receive the latest published quest version at that time."
  5. "Multiple attempts are independent. Resetting progress affects only the selected attempt."
  6. "Coin spend for hints is per-attempt, per-step. Coins are earned via quest completions and gifts defined in steps."
- Open modeling question: "Whether 'continue' across attempts or devices requires merging state or just picking the latest local attempt on sync."

### From business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md (absolute path: /home/nabor/_projects/geohod/quests/business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md) — explicitly "The Highest-Risk Area"
- Locked: "Client fully validates ... No server re-validation of correctness on sync."
- "On sync / reconnect: Client uploads the attempt's StepCompletions for this snapshot version: Which step, Submitted value ..., Local is_correct ... Timestamp(s), Coins spent on hints for specific steps. Server **records** the submissions and local outcomes as facts about that attempt + that quest version. Server does **not** re-validate ..."
- "Server reconciles coin balance (master player coins = sum of earnings from completed quests/gifts minus spends). Local spends are applied."
- "Multi-device: Each device can have its own local snapshot + local attempt state. On sync the server merges by (attempt, step, version). Last-write or union semantics needed for coin spends and completions."
- Reset: "Reset progress on an attempt = clear its StepCompletions locally (and on next sync). The attempt record and grant survive."
- Continue: "resume the latest (or selected) in-progress attempt using its original local snapshot data + any synced state."
- Edge: "A completion that the server marks incorrect (or a hint spend that would overdraft coins) can cause the local attempt state to be corrected on next load."
- Remaining risks (self-critique in doc): "No server re-validation means the recorded `is_correct` is only as good as the client implementation... If we do not retain historical quest snapshots ... players may lose the ability to continue old attempts after clearing local data."
- "This model is simpler and directly satisfies ... It is also less robust for content quality over time."

### From business/06 + 07 + 08 (absolute paths)
- business/06_V1_REQUIREMENTS_AND_CUT_LIST.md:54: "Should Have: Reasonable error handling and recovery on sync conflicts or quest version drift."  
  Risks:98: "Sync logic has races → lost progress or coin overspend for real players."
- business/07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md:62: "Can a player start playing a quest from multiple devices offline and have the attempts merge cleanly?" (still open). Also calls out "When an answer is validated locally as correct but server says incorrect on sync" (even though 03/08 lock "no reval", the tension remains for player UX and correction).
- business/08_DECISIONS_LOG.md:7 (locked): "Client fully validates ... Server records submissions and the local validation outcome but performs **no re-validation** ... old attempts are bound to the version they started with." Trade-offs accepted: "Buggy or suboptimal answers ... are frozen ... The client implementation of matching becomes the source of truth..."

### Legacy (for contrast, not to copy): docs/02_DATA_MODEL.md + discovery/parsed/data_types.json + api_events.json
- Old: `answer_card` (not QuestAttempt) with fields: User, Page_constructor (step), Quest_name, Buy_hint (bool), Complited (bool), You_made_it (bool), Complited_quest (bool), Count_wrong_answers (number), del (bool). Lists on user: Answer_card, Getting_5_coins_for_completing (quest list, clearly dedup hack), Completed_quests.
- User has Balance_coin (global).
- Page_constructor has Gift_Coins.
- Quest has countCoinMadeIt.
- API/workflows: addAnswerCard, create_answer_card_list (with countCard/pageNumber/quest), 666 + 666_copy (take listAnswerCard/OneAnswerCard), deleteAnswerCard. 82 workflows on quest page + "steps_for_accruing_coins_" reusable. Scattered mutations, no versioning, no bundles, assumed always-online, scheduled processors for "accruing".
- This is exactly the "accidental complexity" business/09 deconstructs. The new model must not recreate mutable bag-of-flags + global mutations under a prettier name.

**Key locked constraints that any variant must respect (or explicitly reopen via 08 update):**
- Attempt bound to snapshot version at start/download time.
- Client is source of truth for is_correct on that version's attempts (no server override on sync).
- New attempts/downloads get latest published version; old attempts stay on theirs.
- Replay = multiple independent QuestAttempts (grants are not consumed, per business/02).
- Reset affects only the selected attempt (clear completions, keep attempt/grant).
- Coins: per-attempt spend tracking + master player balance reconciliation (earns from completions + step gifts).
- Full offline play + sync of progress/coins.
- Idempotent, eventually consistent.

---

## 2. The "Current" Model (Variant 1): Mutable Attempt State + Version Tag + Client-Driven Completions Uploaded for Recording

**Description (grounded, not invented):**
- QuestAttempt is a mutable record (aggregate root) carrying (or deriving) current position, status, aggregate spent_coins_this_attempt, wrong_answer_count, timestamps.
- Progress is represented by (mutable or upsertable) StepCompletion entities/rows per (QuestAttempt, step position + snapshot id).
- Client (PWA, IndexedDB/local state) holds the mutable view of the attempt for the pinned snapshot. All validation, hint deduct (local attempt or player coin cache), advance, gift claiming, wrong-count increment happen locally against the embedded snapshot data.
- On reconnect: client "uploads the attempt's StepCompletions" (which step, submitted value or confirmation, local is_correct, ts, coins_spent_on_hint). Server "records" them (likely as upserts keyed by attempt+step+version).
- Sync is client-driven for the recording payload. Idempotency assumed via (attempt, step, version) natural key or client ts + last-write.
- Coins: local spends recorded in the completion payload; server applies deltas to master player balance (earnings computed from completed attempts/gifts at sync time or via separate events). "Local spends are applied." Overdraft can "correct" local state later.
- Reset: client clears local StepCompletions for the attempt; on sync this propagates as deletes or a "reset" marker on the attempt.
- Continue: client (or server on load) selects an InProgress QuestAttempt by its pinned version, loads the matching local snapshot (or re-downloads if retained), resumes from its current/last step.
- Replay: create brand new QuestAttempt (new snapshot version at creation time if newer available).
- Multi-device: independent local mutable states; server does post-hoc merge "by (attempt, step, version)" using "Last-write or union semantics".
- Version tag: every attempt and completion carries the snapshot id it was started/validated against. Client must not apply a different snapshot's answers to an old attempt.

**Happy Path Cycle (Variant 1):**
1. Player has AccessGrant (business/02). Downloads quest → receives latest snapshot (vN) + embedded acceptable answers (protected form per future ANALYZE-01/02).
2. Client creates local QuestAttempt (or server on first sync) bound to vN.
3. Offline: player advances steps. For answer step: submit → client matches vs local list → sets is_correct, increments wrong count if fail. For physical: explicit confirm. For hint: deduct local, mark revealed. Gifts award local pending.
4. Complete quest: mark attempt Completed, pending earnings.
5. Online: upload batch of StepCompletions (idempotent by key). Server records (no reval), applies coin spends, computes/reconciles earnings into player balance, updates attempt aggregates if stored.
6. Later: "Continue" loads the same attempt + vN bundle (or re-dl). "Reset" clears completions locally + syncs clear. "Replay" = new attempt (possibly vN+1).

**Full Cycle + Harsh Exposure of Flaws (Variant 1):**
- **Simplicity advantage (weak):** Client state machine is straightforward (local object + persist on every step). No event log to manage. Sync payload is just "current completions set". Easy to implement "upload my progress".
- **Race-prone by design (fatal per requirements):** The model explicitly delegates merge to an undefined "last-write or union". business/03:120 admits this is needed but does not specify the algorithm, conflict UI, or invariants preserved. This directly triggers the business/06:98 failure mode ("Sync logic has races → lost progress or coin overspend").
- **Client is source of truth for outcomes on frozen versions (accepted trade-off that becomes a liability):** Any client bug in matching, wrong-count, or "did I already claim this gift?" is permanently recorded for all attempts on that snapshot. No server can save it (per lock). Analytics become the only mitigation.
- **Mutable overwrites lose causality:** If two completions for same (attempt,step) arrive, last ts wins → one device's work is silently discarded. Union of "completed steps" loses per-step details (which wrong answer was submitted on device A vs B? which hint was bought when?).
- **Attempt "current position" is racy mutable state:** If stored on the QuestAttempt row, concurrent devices advance it differently; last wins or requires extra merge rule not documented.
- **Reset is a destructive clear, not a first-class operation:** "Clear StepCompletions locally (and on next sync)" (business/03). This is a delete. In presence of concurrent offline progress it is non-atomic and non-idempotent across devices. No vector clock, no "reset at seq X".
- **Coin reconciliation is optimistic + corrective after the fact:** Local deducts happen with cached/stale balance view. Server applies all reported spends. "Hint spend that would overdraft" triggers correction on *next load*. This means a player can see negative or "you spent more than you had" after the fact, or have hint reveals retroactively revoked. Double-spend window exists between devices. Earnings timing (when is "quest completed" coin + gift coins actually credited vs. when spends are deducted?) is not specified beyond "sum of earnings ... minus spends". Old system used Getting_5_coins_for_completing list exactly to prevent double-earn; new model has no equivalent documented guard.
- **Version drift on continue is underspecified:** business/01 open question + business/03: "New attempts ... latest ... Old attempts ... original". What if the attempt record says v1 but the device only has v2 bundle cached, or vice versa? Re-dl requires historical snapshot retention (risk called out in 07/03). If retention not implemented, "continue" on cleared device silently upgrades to new version → answers may differ from what player saw/used before, violating "bound to snapshot".
- **Idempotency is assumed, not designed:** "idempotent sync of completions/coins" (task prompt) is stated as requirement but the payload and server write path in business/03 provide no explicit idempotency keys (e.g. client-generated completion UUID per action, device_id + local_seq). Natural key (attempt+step) works only for "one submission per step" assumption. If player can re-submit or if reset+replay on same attempt, it breaks.
- **Multi-device "same attempt" identity problem:** How do two devices even know they are operating on the *same* QuestAttempt instance vs. two different attempts for the same (player,quest)? If attempt creation is local-first, devices may create two QuestAttempt rows for what the player thinks is "my progress on Quest X". Merge then has to decide whether to treat them as one logical playthrough or keep separate. Not addressed.
- **No audit, hard to debug or "replay":** The title includes "Replay". Variant 1 has no replay capability beyond "look at current StepCompletions". You cannot reconstruct the exact sequence of submissions, wrong answers over time, or which device did what.
- **Self-critique (as required, harsher than the doc's own):** business/03 already self-critiques frozen bugs and snapshot retention. It understates the operational reality: PWA offline multi-device is not a nice-to-have; it is the primary play mode for location-based quests (play on phone while walking, later on tablet at home, or two family members? but grants per player). The "simpler" model pushes all the hard distributed-systems problems (causality, convergence, balance invariants under partition) into an unspecified "merge on sync" and "correction on next load". This is not robust. It will produce support tickets for lost progress exactly as business/06 warns. Maintainability will suffer: the sync/merge layer will accrete if-statements, special cases for "reset during sync", coin delta sign-flips, version pins, etc. — recreating the 1163-workflow spaghetti in a different language.

**Concrete status of Variant 1 in current docs:** It is the *only* described model. It is incomplete for the races it acknowledges. High risk. Not ready for implementation.

---

## 3. Deconstructed Races (Timelines + Failure Modes)

All scenarios assume: single Player, valid AccessGrant, same Quest. Devices A and B are both authenticated as that player, both have the quest downloaded (same or compatible snapshot version unless noted). "Attempt X" means a specific QuestAttempt aggregate identified by id (how the id is shared/created across devices is itself a sub-problem).

### Race 1: Two devices both advance the *same* attempt offline, then sync (concurrent progress + coin spend)
**Timeline:**
- T0: Both devices have synced state for Attempt X (v1), at step 3, player coin balance authoritative = 10, attempt spent=0.
- Device A (offline): completes step 4 (answer, local is_correct=true), buys hint on step 5 (local deduct 1 coin, reveal), advances to step 6. Local view: spent=1, completed up to 5.
- Device B (offline, parallel): also completes step 4 (perhaps different submitted text, local is_correct=true or false), buys hint on step 6 (deduct 1), completes step 7. Local: spent=1 (different step), completed up to 7.
- Device A reconnects first: uploads its StepCompletions (4,5). Server records (upserts), applies -1 spend. Balance now 9. Attempt current=6. Syncs back "OK, your view is authoritative".
- Device B reconnects: uploads (4,6,7 + its spend on 6). 
  - What happens to step 4? If last-write by ts: B's submission overwrites A's (possible different wrong-answer count or even different is_correct if one device had buggy snapshot?).
  - Step 5 from A is kept or dropped? "Union" of completed steps: now 4,5,6,7. Good?
  - Hint spends: two separate steps → total -2. Balance → 8. OK if union.
  - But if B also touched step 5? Or if attempt aggregate "total spent" is set to B's local 1 instead of summed? Lost or double-counted.
  - Device B's local balance was 10 (stale); it spent assuming that. After A sync, real was 9. B spent 1 → effective overdraft allowed.
- Outcome: Possible lost submission detail on step 4. Possible coin balance now 8 but one device still shows local 9. Next load "corrects". Player may have bought a hint they "couldn't afford" in global terms. Wrong-answer count may be from only one device's data. If "current step" was a mutable field on Attempt X, it ends up at max(6,7) or last-writer's value — arbitrary.

**Why current model fails:** No per-action identity or causal order. "Last-write or union" is ambiguous for per-step payload (submitted value is not a set-unionable thing; it is a LWW register with loss). No device_id or local sequence on the completion upload. Coin delta application is not a commutative CRDT op or a sequenced transaction; it is "apply the reported spends". Violates "no ... coin overspend".

### Race 2: Reset on one device while the other is actively playing the same attempt offline
**Timeline:**
- T0: Attempt X at step 8, both devices have local copies.
- Device A (online or syncs): Player chooses "Reset progress" on this attempt. Client clears all StepCompletions locally for X. On sync: server deletes or marks cleared all prior completions for X. Attempt status remains InProgress, current=1 or null. "The attempt record and grant survive."
- Device B (offline the whole time): Player has been playing from step 8 → 12, spent 2 coins on hints, submitted answers (some wrong). Local state advanced.
- Device B reconnects after (or during) A's reset sync.
  - If reset was a hard clear on server: B's upload of 8-12 completions either re-creates them (reset "lost") or is rejected because "attempt was reset". Player on B loses hours of offline work.
  - If reset is "soft" or just sets a reset_ts on the attempt: B's newer completions may still apply (union wins), so reset had no effect for the player who was playing. Or merge logic sees B's data as "post-reset" and keeps it, again defeating the reset from A.
  - If devices create *different* local "reset" markers: non-convergent.
- Player experience: "I reset on my phone so I could start fresh, but on tablet my old progress is back / gone / mixed."

**Why current model fails:** Reset is modeled as a destructive state mutation ("clear StepCompletions"), not an immutable operation with ordering. No happens-before or reset epoch. Concurrent offline progress has no defined semantics vs. reset. "Affects only the selected attempt" is true but useless when the attempt is shared across partitioned devices. business/03 does not specify the sync payload or server handler for reset.

### Race 3: Version drift + continue (or "the snapshot I played is not the one I can re-download")
**Timeline:**
- Device A: Starts new attempt Y on v1 (answers list A1,A2 for step 2). Plays offline to step 5, some answers submitted against A1/A2.
- Admin publishes v2 (fixes a wrong answer in the list for step 2; adds a step).
- Device B: Player wants to "continue" attempt Y. Device B has no local data (reinstall, or second device, or cleared cache). It asks server for "my in-progress attempts". Server returns attempt Y bound to v1. Client requests the bundle for v1.
  - If server retains historical snapshots (recommended in 03/07 but not mandated): gets exact v1 answers → can continue with same validation as before.
  - If not retained (common simplification): only v2 available. Client either (a) refuses continue ("version gone"), losing progress, or (b) downloads v2 and "continues" — but now step 2 matching uses new list. Player's prior local memory of "what was correct" no longer matches. Any new answers on device B use v2. On sync, the old completions from device A (recorded against v1) coexist with new ones against v2 on same attempt id? Or server rejects? Version drift on the *same* attempt record.
- Even without clear: Device A continues playing on v1 locally. Device B starts "new" but somehow links to same attempt. Mixed versions in one attempt's completions.

**Why current model fails:** The binding "each QuestAttempt ... bound to a specific quest version/snapshot" (business/01:155) is only as strong as the client's ability to obtain that exact snapshot later and the server's retention policy. business/03 acknowledges the risk but the model still says "continue ... using its original local snapshot data + any synced state" without specifying the re-hydration path or what happens on version mismatch during merge. "New attempts get new version" does not help existing attempt ids.

### Race 4: Coin reconciliation (earns + spends) from different devices / versions / attempts
**Timeline (multiple subcases):**
- Subcase A (earns double-claim): Device A completes quest on attempt Y (v1) offline → local pending +5 (completion bonus) + gift coin from step 10. Device B (same or different attempt on same quest) also reaches "complete" and claims the same bonuses locally. On sync both report "completed". Server adds +5 twice unless it has a "Getting_5_coins..." style guard per (player,quest) or per-attempt. Old system had the list exactly for this; new invariants say "coins earned via quest completions" but no dedup rule documented beyond "sum".
- Subcase B (spend overdraft across devices): Balance 5. Device A offline spends 3 on hint (local shows 2). Device B offline spends 3 on (different or same) hint (local shows 2). Both sync. Server applies -3 and -3 → -1. "Overdraft correction" on next load for both devices. Player saw two reveals they shouldn't have been able to afford simultaneously.
- Subcase C (earn vs spend interleaving + attempt boundaries): Device A completes attempt Y (earns +5, local balance +5), starts new attempt Z on same quest (newer version?), spends 2 on hints in Z. Device B spends 4 in Y before seeing the earn. Sync order determines whether spends in Y are covered by the earn from Y or not. If earnings are attributed to "quest complete" not "this attempt", global balance can be gamed or go negative across attempts.
- Subcase D (versioned earn rules change): v1 had 5-coin on complete; v2 changes gift amounts. Old attempt Y on v1 earns per v1 rules; new attempt earns per v2. Reconciliation must attribute earnings to the versioned source.

**Why current model fails:** Coin logic lives in the reconciliation on sync ("master player coins = sum ..."), but the inputs (which completions count as "completed" for earning, which gifts were claimed in which attempt/version, per-attempt vs global) are delivered via the same racy mutable completion uploads. No atomic "claim earn" event. Local balance is a cache that can be violated. Per-attempt spent is tracked but the invariant "Coin spend for hints is per-attempt, per-step" (business/01) does not prevent global overspend when multiple attempts or devices are involved. Old scattered mutations at least had explicit dedup lists; new model has none visible.

**Additional races (for completeness):**
- Player resets, then immediately starts playing again offline on same device before sync; sync of reset and new completions interleave.
- One device marks attempt "Completed"; another continues adding completions post-complete.
- Idempotency key collision or missing on retry of sync (e.g. network timeout after server applied but before client ack).
- Attempt creation race: two devices both decide "no local attempt, create new" for same (player,quest) → two attempts when player expected one.
- Physical confirmation steps + notes: two devices confirm same physical step with different notes; last wins, note lost.
- "Abandoned" status set on one device while other is still advancing.

These are not exotic; they are the direct consequence of "full offline PWA" + "multi-device" + "multiple attempts" + "coins" + "client validates" + "mutable state" + "no reval".

---

## 4. Variant 2: Immutable Event-Sourced Completions (Every Confirm/Answer Is an Append-Only Event; State Is Projection)

**Description:**
- Core: Do not mutate "current completions". Instead, every player action that advances progress is an immutable AttemptEvent (or domain event in Play context):
  - event_id (UUID, or (player_id, device_id, local_seq) for offline generation)
  - quest_attempt_id
  - snapshot_version (the pinned one)
  - step_position (or GameStep ref)
  - event_type: 'physical_confirmed' | 'answer_submitted' | 'hint_purchased' | 'gift_claimed' | 'step_advanced' | 'attempt_completed' | 'reset_requested' | ...
  - payload: { submitted_value?, local_is_correct?, coins_delta?, client_ts, note?, device_id, ... }
  - server_received_at, causal metadata if needed
- QuestAttempt row (or read model) becomes a *projection*: the current state (status, last_step, total_spent_this_attempt, wrong_count, completed_steps set, etc.) is the fold/reduce of all events for that attempt up to now (respecting any reset events).
- Step "completion" is no longer a single row that gets overwritten; it is the latest relevant event(s) for that step in the stream (or a materialized view).
- Sync: client maintains its local event log (append-only, even offline). On reconnect: POST /sync { pending_events: [...] } (idempotent by event_id — server ignores duplicates). Server appends unseen events (in causal or receive order), then client pulls events since its last known server seq / vector. Re-project local state from the merged log.
- Replay: literally replay the event stream for an attempt (filter by snapshot_version) to reconstruct exact sequence of answers, wrong counts over time, hint purchases, which device originated what.
- Reset: append a 'reset_requested' event (with reason, device). Projection logic: for "current progress view", ignore all events before the latest reset event (or treat post-reset as new sequence). History is preserved for audit/replay of the *prior* playthrough on the same attempt id. Or: reset can be modeled as "retire this attempt and auto-create a fresh one" but task distinguishes reset vs continue, so same-attempt reset event is better.
- Coins: every spend or earn is a coin_delta in an event (or separate CoinTransaction event linked to the attempt event). Authoritative player balance is a projection/fold over *all* coin events for the player (across attempts). Server can enforce at append time (if it has a recent balance projection) or accept and let a later "balance correction" event be emitted if overdraft detected on projection. Because events are additive and identified, double-claim of the same earn is deduped by event_id or by (attempt_id, earn_type, step) uniqueness.
- Version: every event carries the snapshot_version it was generated against. Projection for an attempt only folds events matching its pinned version.
- Idempotency: trivial — event_id is the key. Client can safely retry the entire pending batch.
- Merge from offline devices: just union the event sets (dedup by id), order by (client_ts, device_id, local_seq) or lamport timestamps or server append order + tiebreaker. All facts are kept; no loss.

**Handling of the 4 Races (Variant 2):**
- Race 1 (dual advance): Both devices append their events (step4 submit A, hint5 on A; step4 submit B, hint6 on B, etc.). Server has the full set. Projection for current state can choose policy: e.g. for a given (attempt,step), take the event with latest client_ts (LWW per step) or keep multi-value and surface "conflicting submissions on step X — pick one or view history". Coin deltas are summed exactly once each. No overwrite loss. Player (or UI) sees the union of activity.
- Race 2 (reset concurrent): Device A appends 'reset_requested'. Device B appends its later progress events. On merge, the projection for "current" starts fresh after the reset event; B's pre-reset events are still in the log (for "what did I do before I reset?"). If B's events have client_ts after the reset ts, projection can decide to treat them as post-reset (new play) or flag anomaly. Deterministic fold > ad-hoc clear.
- Race 3 (version drift): Events for attempt Y are all tagged v1. When re-hydrating, only v1 snapshot is used to interpret the events (for display/validation history). If v1 snapshot not retained, you can still show the *submitted values* and the *local_is_correct the client claimed at the time*, even if you cannot re-run the match. Continue on a device without the snapshot can at least show "this attempt used v1; you submitted X on step 2 (claimed correct)". New events after drift would be rejected or start a new attempt.
- Race 4 (coins): Every earn and every spend is a distinct, idempotent, attributable event. Projection for balance = sum(all + deltas) - sum(all - deltas). Dedup guards (e.g. "only one 'quest_completed_earn' event per attempt") are simple uniqueness on ingest. Overdraft can emit a correcting event or be prevented if the projector is consulted before append (for online) or accepted with audit flag for offline batches. Timing/ordering is explicit in the log.

**Full Cycle + Self-Critique (Variant 2):**
- Happy path: same as before, but every tap/answer/hint/claim appends an event locally; sync is event upload + pull + reproject.
- Replay: first-class (fold the stream, or "play back the answers in order").
- Robustness: dramatically higher for no-lost-progress (append never drops prior facts) and double-spend (events are the source; projections or constraints can be added without mutating history). Idempotent by construction.
- Auditability: perfect for analytics per version, debugging "player says they answered correctly but it shows wrong", support ("show me the exact sequence on device A").
- Maintainability: higher initial cost (event schema, local + server event store or log, projectors for QuestAttempt view + player balance + per-attempt aggregates, snapshotting of projections for query perf). But once built, the "merge logic" is "append + fold" — far less special-case code than Variant 1's inevitable if (reset && concurrent) branches. Event sourcing is a well-known pattern with libraries/tooling in most stacks (including Rust). Queries become "what is the state after these events?" rather than "what is the current row + did a sync happen?".
- Harsh flaws / skepticism:
  - Complexity tax: for a linear 20-50 step quest, do we really need full event sourcing? Yes, because the requirements include offline multi-dev + coins + replay + "no lost progress". The complexity is already there in the problem; Variant 1 just hides it until runtime.
  - Event ordering under partition: client_ts can be skewed (device clocks). Need stable tie-breaking (device_id lexical + local monotonic seq per device). Or accept that "latest" for LWW per step may be approximate. Still better than silent loss.
  - Projection lag / staleness: client and server must agree on the fold logic exactly (same code or spec). Drift in projector impl = different "current step" views.
  - Reset semantics still need design: does a reset event "tombstone" prior events for current view only, or do we prefer "reset always creates a fresh QuestAttempt and the old one is archived with its full event history"? Latter is cleaner for "multiple attempts are independent".
  - Storage: event log per attempt grows with every wrong answer retry + every hint. For v1 quests, negligible. Can snapshot the projection and prune old events if needed (with care for replay).
  - Migration/import: historical answer_cards must be turned into initial event streams (one 'answer_submitted' + 'complited' etc. per old card, with best-effort ts and is_correct inferred). Feasible per business/07 import desire.
  - "No reval" respected: the event carries the client's local_is_correct as a fact. Server never recomputes it from current quest content for recording purposes. (It *can* re-compute for analytics or "was this client buggy on v1?" using retained snapshot answers.)
  - Self-critique: Event sourcing can be over-applied (see "event sourcing is hard" memes). If we only ever query current state and never need time-travel, a simpler log of "changes" with compaction might suffice. But the task prompt itself says "immutable event-sourced completions (every confirm/answer is an append-only event; state is projection; easy replay/merge)" — it is the natural fit for the stated needs (Replay in the title, offline merge, audit of submissions per version). We should not reject it for "complexity" without measuring against the cost of debugging lost-progress bugs in production.

**Status for Variant 2:** Strong candidate. Directly addresses every race and the explicit "replay" and "idempotent sync" requirements. Requires updating business/01 (add AttemptEvent concept or treat StepCompletion as event-sourced) and business/03 (replace "uploads ... StepCompletions" and "clear StepCompletions" with event append + projection).

---

## 5. Variant 3: CRDT or Conflict-Free Progress Structures for Offline-First

**Description:**
- Represent the *progress state itself* (not the history) using CRDTs so that independent replicas (devices) can mutate their local copy and merge converges to the same state without coordination or last-writer loss.
- Examples for this domain:
  - Set of completed step positions: G-Set (grow-only set) or OR-Set (observed-remove, for reset support via tombstones or a separate "reset epoch" counter).
  - Per-step submission: map<step_pos, LWWRegister< {submitted, is_correct, ts, device} >> or Multi-Value Register if you want to keep conflicting answers and let app resolve.
  - Hint purchases: OR-Set of (step, hint) pairs (once bought, stays bought; reset can clear).
  - Attempt aggregates (spent_coins, wrong_count): PN-Counter (positive/negative counter) or a G-Counter per device summed on merge. For spent, since it is "sum of discrete hint buys", the set approach above is better than a raw counter (prevents double-counting the same buy).
  - Global player coins: separate PN-Counter or (better) a set of earn events + set of spend events, or a single balance CRDT updated by delta ops. But global is hard because earns/spends cross attempts.
  - Version pin + reset: a LWWRegister for "current version for this attempt" + a counter or version vector for resets.
- Merge: devices exchange full state or deltas (state-based or op-based CRDT); merge is commutative, associative, idempotent by construction. No central "last write".
- Sync with server: server can act as one replica (or just a durable store of the CRDT state). Clients push their local CRDT state (or ops), server merges into canonical, clients pull the merged.
- Client still does local validation against pinned snapshot for UX/offline.
- "Events" can be the *ops* that feed the CRDT (op-based CRDTs are basically event sourcing with mergeable ops).

**Handling of the 4 Races:**
- All four become "apply the ops from both sides; merge produces a single convergent state". For step submissions, if using LWW, one wins by ts/device; if MV-Register, both values are present in the map and UI must choose (or show "multiple submissions").
- Reset: modeled as a "remove all observed" op or increment reset counter that future adds are tagged with new epoch. Converges without the destructive race of Variant 1.
- Coins: if spends are adds to a "spent set" CRDT and earns to an "earned set", merge sums uniquely. Overdraft still possible if deltas are applied without a global balance check, but the structure itself doesn't lose or double-apply a single op.
- Version drift: the version is part of the CRDT state (LWW); conflicting version pins on same attempt id surface as conflict to be resolved (probably "this attempt is v1 only; ignore v2 ops").

**Full Cycle + Self-Critique (Variant 3):**
- Happy path: local CRDT mutations on every action; background or on-demand sync merges with server/other devices; projection or direct query of the CRDT gives current step/completions/spent.
- Robustness: excellent formal guarantees for convergence and no lost updates (within the CRDT model chosen). Perfect for "offline-first".
- Maintainability: **poor** for this problem unless using a mature CRDT lib that supports the exact structures (sets + LWW + counters + reset epochs). Implementing correct CRDTs from scratch is error-prone (see many papers on subtle bugs in "simple" sets). In a mixed client (PWA/TS or WASM) + server (Rust) world, you need equivalent impls or a shared protocol. State size: tombstones for removes (resets) can grow; need garbage collection strategy. Debugging: "why is step 5 showing as completed?" requires understanding the CRDT math, not just reading a list of events.
- Harsh flaws:
  - Overkill / YAGNI: Linear quests, small fixed number of steps (~dozens), human player (not high-frequency concurrent edits), "usually one device active at a time" — classic case where simple LWW + union + explicit conflict UI would work 99% of time, and CRDTs buy formal beauty at high cost.
  - Coins global balance is not naturally a pure per-attempt CRDT; you still need a reconciliation layer or a separate coin CRDT that crosses aggregates — reintroduces the hard parts.
  - "Easy replay" (task requirement) is weaker: CRDT state tells you the *final* converged values, not the ordered history of submissions or "I bought hint then answered wrong twice then reset". You would layer an op log anyway (making it event sourcing + CRDT merge).
  - Semantic conflicts remain: even a perfect CRDT cannot decide "which of these two different answers for step 2 should count for the player's score?" That requires domain policy (LWW, first, both-with-flag, prompt user). The hard part is policy, not the merge algebra.
  - Self-critique: CRDTs are the right tool for some systems (collaborative editing, distributed counters with no coordinator). For this bounded context they are likely a mismatch. A hybrid (events for history + CRDT or simple merge for the "live progress" read model) could work, but pure CRDT for attempt state adds accidental complexity on top of the essential (version pinning, offline, coins, no-reval). If the team has CRDT expertise and the lib story is clean, it could be viable; otherwise it is resume-driven design.

**Status for Variant 3:** Theoretically strong for pure offline convergence. Practically, probably not the highest-leverage choice here. Can be a future optimization or a sub-component (e.g. CRDT for the set of hint purchases).

---

## 6. Variant 4: Strict Server-Authoritative with Client as Cache (Respecting No-Reval for Answers)

**Description (tailored to locks):**
- Client is a cache + simulator for offline UX. It never "owns" the recorded truth.
- When online: *all* progress actions (answer submit, confirm physical, buy hint, claim gift, reset, complete) are sent to server as commands/intents. Server owns the QuestAttempt aggregate, performs the transition (validates access, version pin, etc.), appends or mutates the canonical state, returns the new state + any side effects (earns, reveals). Client updates its cache from the response.
- For full offline: client still runs the full local simulation against the pinned snapshot (to give immediate feedback, allow complete playthrough, local coin cache deduct). It queues the *sequence of commands* (with local seq, client ts, the exact submitted value + the local_is_correct *it computed*).
- On reconnect: client sends the queued command sequence for the attempt (idempotent via attempt + client_seq or command_id). Server applies them *in order* (or merges if multiple devices), using the commands' payloads.
  - For answer/physical: server *records* the submitted + the client's local_is_correct (per no-reval lock). It does *not* re-compute is_correct from live quest data. (If it retains the snapshot's acceptable list for that version, it *could* compute for its own analytics or to detect client drift, but does not override the recorded outcome for the player's attempt.)
  - For coins: server applies deltas against the *authoritative* current balance projection at apply time. If a queued spend would overdraft given prior applied ops, server can (a) reject the spend (client must handle "your hint buy was not granted on sync"), (b) apply and emit correction, or (c) apply all queued and let balance go negative with flag (undesirable).
- Attempt state on server is the source of truth; client polls or gets pushed updates (or on next explicit continue/load).
- Reset: explicit server command "reset attempt X". Server clears (or appends reset marker) atomically. Queued post-reset commands from other devices can be applied after or rejected with "stale".
- Version: server enforces that all commands for an attempt carry the matching snapshot_version; rejects drift.
- Continue: server returns the canonical current state for the player's attempts (with their pinned versions). Client fetches the corresponding snapshot bundle (historical if needed) and renders from server state.
- Idempotency: server-side, using command ids or (attempt, client_seq, device).

**Handling of the 4 Races (Variant 4):**
- Race 1: Server receives command streams from A and B (possibly interleaved by arrival). Applies sequentially in some total order (receive order + tiebreak by client seq). For same step, second submission may be "no-op" (already completed) or recorded as additional submission if policy allows. Coin spends are checked/applied against live balance at each step → second spend that would overdraft can be rejected or corrected immediately in the response to that device. No silent double-spend.
- Race 2: Reset command from A is applied on server. Later commands from B for the old sequence can be dropped or re-interpreted as new post-reset sequence (depending on whether they carry a "pre-reset" client view). Deterministic server ordering beats device-local clear.
- Race 3: Server owns the binding of attempt to version. On continue/load it returns the pinned version + current projected state. Client without the exact snapshot can be told "re-download v1 required" or "version not retained; progress metadata available but re-play validation not possible".
- Race 4: Server is the only place coins move. All earns and spends are applied through it (even if originated from queued offline commands). Balance is always consistent post-apply. Order of a batch of queued commands determines earn/spend interleaving (client can suggest order via seq nums).

**Full Cycle + Self-Critique (Variant 4):**
- Happy path: online = RPCs; offline = simulate + queue; sync = replay queue in order, receive corrections.
- Robustness for coins: best of the variants (central choke point for balance). Lost progress: lower, because server serializes and acks; client can re-send un-acked commands.
- "No reval" respected (if implemented as "record client's claim, do not override is_correct").
- Harsh flaws:
  - Fights the offline requirement: long offline sessions work for *simulation and local feedback*, but the recorded truth and any coin effects are "pending" until sync. Player may complete a quest offline, see "you earned 5 coins!", go offline again, and on later sync discover the earn was not granted or a spend was clawed back. This creates "pending vs authoritative" UI everywhere — exactly the tension the locked decision in 08 tried to remove by making client local-val the truth for the attempt.
  - Queue replay complexity: what if during the offline session the player did "reset then replay 10 steps"? The queue must replay the reset first. If server state has moved on (other device), the replay may partially fail. Need sophisticated "rebase" or conflict handling on the queue.
  - Latency for online play: every step submit is a network roundtrip (or at least a reliable queue flush). For a quest experience, this may be acceptable if backgrounded, but the "pure local validation + recording sync" in business/03 was chosen to avoid exactly this.
  - Still needs something like events or a log for the queued commands + applied history (otherwise "replay" of what the player actually did is lost).
  - If server *does* re-compute is_correct on apply (using retained snapshot answers), it violates the explicit "no re-validation ... client ... source of truth" lock and the "records the local validation outcome" language. To respect the lock, server must blindly trust (and store) the client's is_correct from the command payload — at which point we are back to trusting client code for permanent records, just with a server write path.
  - Self-critique: This is the "safest" for coin invariants and central control, and it maps well to "client as cache" architectures with reliable queues (e.g. Outbox pattern + server command handler). However, it tensions with the hard "full offline" + "client validates its version fully; no reval on sync" direction chosen after stakeholder input. It would require reopening or carefully interpreting the 08 decision. For pure robustness (no lost/double), it is attractive; for the product philosophy of "download and disappear into the city with your phone", it adds friction and "sync pending" anxiety that the simpler local model was meant to eliminate.

**Status for Variant 4:** Viable if we decide the "no reval" lock is primarily about not forcing a second validation round against *live* quest content (i.e. allow old-version outcomes), and we are willing to make the server the sequencer of recorded facts. Otherwise, it fights the current locked model. Can be combined with Variant 2 (server applies events from the queue in order).

---

## 7. Variant Comparison (Summary Table)

| Aspect                        | V1: Mutable + Client Upload (Current) | V2: Event-Sourced (Append + Projection) | V3: CRDT Progress State | V4: Server-Authoritative + Queue |
|-------------------------------|---------------------------------------|-----------------------------------------|-------------------------|----------------------------------|
| Lost progress on dual-device advance | High (last-write/ambiguous union)    | Low (append all; policy on fold)       | Low (convergent merge) | Low (server sequences)          |
| Double-spend / overdraft coins | High (optimistic local + post-correction) | Medium (additive events; can check on ingest or project) | Medium (delta ops)     | Low (server applies with current bal) |
| Reset concurrent with play   | High (destructive clear races)       | Low (reset event + epoch in fold)      | Medium (epoch CRDT op) | Medium (server command + queue replay) |
| Version drift + continue     | High (retention + client pin fragile)| Low (events carry version; history survives) | Medium (version in CRDT state) | Low (server owns binding)      |
| Replay / audit of submissions | None (current state only)            | First-class (fold the stream)          | Weak (final state)     | Medium (if log of applied cmds) |
| Idempotent sync              | Assumed (natural key)                | Trivial (event_id)                     | Trivial (CRDT merge)   | Good (seq/command id)           |
| Maintainability (merge logic)| Poor (will grow special cases)       | Good (append + deterministic fold)     | Poor (CRDT impl + GC)  | Medium (queue + conflict on replay) |
| Complexity for linear quest  | Low initial, high ongoing            | Medium (standard pattern)              | High (overkill)        | Medium-High (offline queue)     |
| Fits locked "no reval + client truth for version" | Yes (but racy)                       | Yes (client claim in event payload)    | Yes                    | Yes (if server stores claim, not recomputes) |
| "Easy replay/merge" (prompt) | No                                   | Yes                                    | Partial                | Partial                         |
| Storage / history bloat      | Low (current only)                   | Medium (events; snapshot projections)  | Medium (tombstones)    | Low-Medium                      |
| Cross-device "same attempt" identity | Fragile (local creation)             | Explicit (events reference attempt id) | Explicit               | Explicit (server id)            |

---

## 8. Recommendation for Robustness (No Lost Progress or Double-Spend) + Maintainability

**Primary Recommendation: Adopt a hybrid of Variant 2 (immutable events as the source of truth for all play actions) + projected mutable QuestAttempt read model for queries/UI. Treat coin movements as first-class additive events (CoinTransaction or deltas inside AttemptEvents). Make server the durable append point and projector. Client maintains local event log + projection for offline, pushes pending on sync, pulls and re-projects.**

**Why this over the others (rigorous):**
- Directly satisfies "replay" (in task title and business intent), "immutable event-sourced completions", "easy replay/merge", "idempotent sync of completions/coins".
- Eliminates the exact races deconstructed: append-only + explicit ids + deterministic projection = no silent loss, no ambiguous "last write", reset is a first-class observable event, version is carried per event, coins are summed from identified deltas with natural dedup points (e.g. unique earn per (attempt, type)).
- Preserves the locked decisions: client still computes and *records its local_is_correct* in the event for the pinned snapshot; server does not override it for the player's outcome. (Server *may* retain snapshots for its own projectors/analytics/migration/re-dl.)
- Addresses the explicit failure mode in business/06 and open question in business/07.
- Better maintainability long-term than V1's inevitable accreted merge code, and more practical than pure V3 CRDTs or V4's queue tension with the offline philosophy.
- Audit, analytics per version, support debugging, and future features (e.g. "rewind my attempt to before I bought that hint") become cheap.
- For coins specifically (cross-ref ANALYZE-04): earnings and spends become explicit, attributable, versioned, attempt-scoped events. Balance projection is a simple sum with guards at the points you choose (ingest for online, post-batch for offline). No more "scattered mutations" like the legacy answer_card + user.Balance_coin + Getting_5... list.

**Concrete required changes / updates (do not ship without):**
1. Elevate AttemptEvent (or "StepCompletionEvent") as a core entity in business/01 (alongside or replacing the mutable view of StepCompletion). Document its fields, uniqueness, projection rules for QuestAttempt state, reset semantics, coin delta rules.
2. Rewrite the sync section of business/03: replace "uploads the attempt's StepCompletions" and "clear its StepCompletions" with "appends its local pending AttemptEvents (idempotent by event_id); server merges into the attempt's event log; client pulls new events and re-projects." Add "last-write or union" is replaced by "append + policy-driven fold (document the exact policies for per-step LWW vs. multi-value, earn dedup, etc.)."
3. Mandate historical snapshot retention (at minimum the acceptable answers + step positions + gift coin values per version) for the lifetime of any in-progress or recently-reset attempts. This is not optional per the risks in 03/07. Cross-link to ANALYZE-02.
4. Add device_id + monotonic local sequence (per device per attempt) to all offline-generated events for ordering and origin tracking.
5. For coins: define CoinTransaction or delta events explicitly. Decide and document: per-attempt spend isolation vs. global balance; when earns are emitted (on 'attempt_completed' event? on specific gift events?); dedup keys for the "5 coins for completing" style bonuses (probably per (player, quest, version) or per attempt); handling of overdraft (reject at sync time with correction event, or allow with negative flag + UI).
6. Update invariants in business/01 and edge cases in business/03/07. Add "Sync and merge are via append-only events with deterministic server-side projection. No client-driven direct mutation of attempt aggregates."
7. For reset vs. continue: decide/document one of:
   - Reset appends event; "current progress" projection ignores pre-reset events for that attempt id (history preserved for replay of prior run).
   - Reset command creates a new QuestAttempt (fresh event stream) and marks the old one Abandoned/Reset. "Continue" only on non-reset attempts. This keeps attempts truly independent.
   Latter is cleaner for "multiple attempts are independent" (business/01:158).
8. Client architecture: local event store (or IndexedDB log) + pure projection function (same logic as server, or compiled from shared spec). On every local action: append event, re-project, persist. "Offline mode" banner while pending events > 0.
9. Server: append-only log (or table with attempt_id + event_id PK), projector(s) that maintain current QuestAttempt rows (or compute on read), balance projector. Idempotent append endpoint. Optimistic concurrency on attempt (etag or version) for non-offline paths.
10. Import/migration path (ANALYZE-09): convert historical answer_card data into seed events for new attempt records (one event per old card + inferred coins). Preserve as much "what the player actually submitted" as possible.

**Trade-offs accepted in this rec:**
- More upfront modeling and code for events/projectors vs. "just upload the current completions".
- Need to define the exact fold policies (e.g. "for a step, the submission with the highest client_ts wins for the 'current answer' view; all submissions are kept in the log for analytics").
- Player may still see temporary inconsistency between devices until full sync + re-project (inevitable in offline).
- If we later decide we *do* want server to sometimes correct is_correct (e.g. for a patched snapshot), the event model makes it possible (add a 'server_correction' event) without breaking the append-only log.

**Rejected alternatives (with why):**
- Stick with Variant 1 as written: directly contradicts the "sync logic has races" risk and the "multi-device merge cleanly?" open question. Will produce lost progress and support load.
- Pure CRDT (V3): formal guarantees not worth the impl/debug cost for this domain size and access pattern.
- Pure strict server (V4) without events: creates "pending authoritative" anxiety that fights the offline value prop; still needs a log for history/replay/audit.
- "Just use last-write + careful updated_at on every completion": still loses the non-latest submission details and the causal history. Not replayable.

**Status + Path Forward (as of this report):**
- **Current status in specs:** Variant 1 (optimistic mutable) is the only fleshed-out path. It is insufficiently specified for the multi-device/offline/coin/replay requirements it claims to support. ANALYZE-05 surfaces this as a critical gap (alongside the parallel ANALYZE-01/02/03/04). business/03's own self-critique and the risk list in 06/07 are evidence the authors knew it was fragile.
- **Immediate next (before code):** 
  1. Review this report in the master thread + cross-review subagents.
  2. Decide reset semantics (same attempt vs. new attempt on reset).
  3. Decide snapshot retention policy + minimal data kept per historical version (cross ANALYZE-02).
  4. Draft the AttemptEvent schema + projection rules + coin event rules (update business/01 + 03).
  5. Produce a small set of concrete sequence diagrams / state machine examples for the top 3 races using the chosen model.
  6. Only then: detailed design (aggregates, API surface for sync, client storage schema, TDD test cases for merge/fold/idempotency).
- **Dependencies:** ANALYZE-02 (versioning/snapshots), ANALYZE-04 (exact coin earning mechanics + timing), ANALYZE-03 (GameStep + completion kinds), ANALYZE-01 (protected answers in bundle). Migration (ANALYZE-09) needs the event mapping.
- **Risk if ignored:** We ship a "simpler" mutable model, real players on real devices with flaky connectivity lose progress or see coin weirdness, the "replay" feature is a checkbox that only does "start over", and we end up with the same class of scattered imperative sync logic we fled the Bubble app to escape.
- **Confidence in rec:** High for the direction (evented facts for play actions). Details of projection policy and reset modeling still need a decision pass, but the fundamental shift away from client-driven mutable completion uploads is required for robustness.

**Appendix A: Additional Open Questions Surfaced by This Analysis (for business/07 update)**
- Exact deduplication rules for earnings (per attempt? per (player,quest,version)? per gift step occurrence?).
- Policy for conflicting submissions on the *same* step from two devices (LWW by ts? keep all + flag for admin/player review? prompt on next continue?).
- Whether "replay" means "re-watch the sequence of my answers/hints in an old attempt" (event sourcing enables) or just "start a fresh playthrough".
- Treatment of physical confirmations + optional notes when multiple devices confirm the same step.
- How "abandoned" status interacts with later offline activity on the attempt.
- Clock skew handling and monotonicity requirements for client_ts in events.
- Whether the server projector should ever emit corrective events (e.g. "your spend on step 5 was reverted because balance was insufficient at the time of sync") and how that surfaces in the player UI / attempt history.

**Appendix B: Relevant Legacy Snippets (Why We Must Not Recreate)**
(See discovery/parsed/data_types.json:1122 (answer_card fields: buy_hint, complited, youmadeit, count_wrong_answers, ...), api_events.json:345 (addAnswerCard), 190 (create_answer_card_list), 568 (666 taking lists of cards), element_definitions:420 ("steps_for_accruing_coins_"), user fields for Balance_coin + Getting_5_coins_for_completing list. All mutable, non-versioned, workflow-driven.)

**End of Report.** This analysis is standalone and self-contained. It should be read alongside the source business/ files (absolute paths above) before any implementation of QuestAttempt or sync begins. Further reviewer subagents can be spawned against this artifact per the process in business/analysis/README.md.

---

*Generated by Grok Build subagent (ANALYZE-05) per explicit task. All claims traceable to the listed source files. Skepticism applied relentlessly.*