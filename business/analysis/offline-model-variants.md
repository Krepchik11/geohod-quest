# Offline PWA Snapshot & Validation Model — Exhaustive Adversarial Analysis (ANALYZE-01)

**Subagent:** Chief Staff Engineer + Relentless Critical Analyst  
**Date:** 2026-06-09  
**Scope:** Solely the Offline PWA Snapshot & Validation Model (cross-references to QuestAttempt/sync, versioning/publishing, coins, migration, GameStep only where they directly intersect the validation/snapshot/sync surface).  
**Inputs (read in full + attacked):**  
- `business/00_PRODUCT_VISION_AND_SCOPE.md`  
- `business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md`  
- `business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md` (locked v0.2 position)  
- `business/07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md`  
- `business/08_DECISIONS_LOG.md`  
- `business/09_WHY_THE_QUESTIONS.md`  
- `business/02_COMMERCE_ACCESS_AND_COUPONS.md`, `04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md`, `05_ROLES...`, `06_V1...`, `README.md`, `analysis/README.md` (for context/parallel slices)  
- `discovery/parsed/data_types.json` (answer_card full fields, page_constructor 36 fields incl `answer_for_exercise_list_text` "Answer", `gift_coins_number`, `page_option_page_type`, `hint1_`, `next_page_`, language explosion, `quest_name_constructor` with `publish_on_the_site_boolean`, `statusquest_option_status_quest` (Published/Test/Project), `page_list_...`, `countcoinmadeit_number`, user `balance_coin_number` + `getting_5_coins_for_completing_list_...`)  
- `discovery/parsed/workflows_all.json`, `workflows_sample.json`, `api_events.json` (addAnswerCard, create_answer_card_list, correctAnswerFirstTravel/correctAnswerRepeatTravel, require_confirm, scheduled/"666" family, answer_card mutations)  
- `discovery/parsed/option_sets.json` (page_type incl "questionnoanswer", status_quest, etc.), `element_definitions.json` (reusable "steps_for_accruing_coins_", Slide_Congratulations, etc.), `pages.json` (quest page 82 workflows)  
- Cross: old `docs/` (02_DATA_MODEL.md, 03_DATA_MANAGEMENT.md, 05_WORKFLOWS..., 10_MIGRATION_MAPPING.md etc.) treated strictly as historical noise + source of old behavior for attack, not gospel.  
- Hard requirements (re-attacked, never accepted at face): full offline PWA play; ~5MB quests; **client MUST validate locally against downloaded snapshot/version**; **NO re-validation of correctness on sync**; new attempts get latest published version; old attempts frozen to their snapshot; sync = recording only + coin reconciliation + analytics **per version**.  
- Constraints (re-attacked continuously): TDD, SOLID, DRY, KISS, YAGNI; highest readability/maintainability; extreme skepticism (every approach, including locked v0.2 and ideas herein, is flawed until proven otherwise via deconstruct/expose/rebuild cycle).

**Process followed (internal + documented):**  
1. Deconstruct (exhaustive edges/races/bottlenecks/violations from locked + old).  
2. Expose (harsh flaws, including self-critique of prior conclusions).  
3. Rebuild (≥3 distinct approaches; for *each*: clear description of data model/bundle/client/server/versions/sync/error recovery; *then* full deconstruct its edges, expose its flaws harshly, rebuild a superior variant, self-critique variant).  
4. Synthesize & Recommend (compare all, including locked as baseline; select best-practice/hybrid; rigorous why + how it improves on locked v0.2 under constraints).  
5. Documentation (this self-contained report).

**Guiding skepticism (re-stated):** Previous "locked" conclusions (e.g., plain strings acceptable, freezing is "intentional", client-as-judge is ok for v1, simple confirmation for physical) were re-attacked with fresh eyes + full discovery data. Old Bubble behavior (mutable-in-place content, server-only via workflows assuming connectivity, answer_card as bag-of-flags per user+page_constructor+quest with no explicit submitted value in schema, scattered coin logic, no attempts/versions/bundles, dupe page/page_constructor + quest/quest_name_constructor, 1163 workflows/444 SetCustomState, "questionnoanswer" page_type) is evidence of *what to never repeat*, not a template. No approach (locked or proposed) is sacred.

---

## Executive Summary: Current Locked (v0.2) vs. Recommended

**Current locked position (business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md v0.2 + 08_DECISIONS_LOG):**  
Client downloads a self-contained ~5MB snapshot bundle containing full GameSteps + *plain list of acceptable answer strings* (from page_constructor.answer_for_exercise_list_text) for answer steps + version id + integrity hash. All validation (answer membership for "question" steps; explicit player confirmation for "questionnoanswer"/physical steps) is **purely local** against that bundle for the lifetime of attempts started from it. Server records submitted values + the *client-computed is_correct* + coins_spent + ts per (attempt, step, version) as immutable facts on sync. **No server re-computation or override of correctness.** New attempts/downloads always bind to the latest published quest snapshot at that instant. Old attempts + their bundles stay frozen (even if answers later deemed buggy by author). Physical steps = simple "I did it" tap (honesty assumed). Sync = recording + coin master-balance reconciliation (earnings from gifts/completions minus spends) + per-version analytics. Bundle enables full offline (narrative/advance/gift/video/terminal/hint-coin-spend/geo-display). Re-download of exact old snapshot required for cleared clients with in-progress old attempts (implies server snapshot retention).

**Self-critique of locked (fresh attack):** It directly satisfies the stakeholder "full offline + client local + no reval + new gets latest + old frozen" mandate. It is *simpler* than any two-phase model. However, it bakes in permanent client bugs as recorded truth, permanently freezes author errors for early adopters, requires non-trivial snapshot retention + publishing/versioning machinery (itself under parallel ANALYZE-02), offers zero tamper-evidence on the "is_correct" claim (plain strings + JS/IndexedDB fully client-controlled), has underspecified multi-device merge and coin races, treats physical honesty as free, and still carries forward some v1 requirement text contradictions (e.g., 06_V1 still mentions "server re-validation on sync" in one bullet — inconsistency). Old system had *none* of this (zero offline, mutable content, server workflows, no versions, answer_card flags only, no submitted values persisted for analytics). Locked is a *necessary first cut* but not robust or maintainable long-term.

**Recommended (after full cycle below):** A **hybrid of normalized content-addressable immutable step/answer entities (Approach 2 refined) + receipted/tamper-evident local claims with hashed acceptable sets + append-only event-sourced local progress + explicit server snapshot manifest retention policy + deterministic per-(attempt,version,step) merge on sync (Approach 3 elements)**.  

Key improvements over locked v0.2:  
- Storage on server deduped across versions (YAGNI full monolithic copies for small quests today, but enables future partial updates/branching without explosion).  
- Hashed (salted per version) acceptable answers in bundles + client-generated receipts (hash chain of (submitted, claimed_is_correct, step_ref, version, nonce)) provide *some* post-facto audit/tamper detection without violating "no re-val of correctness" or requiring server to hold secrets that break offline. Plain strings are rejected for v1+ as too naive.  
- Local progress as append-only events (not just final map) enables superior conflict-free merge on multi-device/offline-long-play + reset semantics + replay for TDD.  
- Explicit invariants + retention policy + migration path for legacy answer_cards (synthetic legacy snapshots capturing the answer list *as it existed at the time of the old card's last mutation*).  
- Error recovery, quota, and coin reconciliation made first-class with clear compensation actions.  
- Dramatically higher maintainability/readability: aggregates are crisp (QuestSnapshotManifest, StepVersion, AnswerSetVersion, QuestAttempt bound to snapshot, StepCompletionFact, CoinReconciliationEvent); no scattered flags like old answer_card; client bundle is a pure value object.  
This still obeys *every* hard requirement (client local val against its snapshot; no correctness re-val on sync; new=latest, old=frozen; sync=record+reconcile+analytics-per-version). It is more robust than locked while remaining KISS for the ~5MB linear case. It enables property-based tests and TDD from day 1.

The rest of this report documents the full adversarial cycle that led here. No prior conclusion was accepted without re-attack.

---

## 1. Deconstruct: Exhaustive Edge Cases, Race Conditions, Bottlenecks, Best-Practice Violations

**Sources attacked:** Locked 03 + 01 invariants + 07 risks/open + 08 decisions + 09 "why not copy" + discovery data_types/workflows (answer_card as 9-field bag: user, del, Buy_hint, Complited, You_made_it, Complited_quest, Count_wrong_answers, Page_constructor, Quest_name — *no submitted answer text field visible*; page_constructor has 36 fields incl language explosion + answer_for_exercise_list_text + Gift_Coins + hint/next self-refs + Page_number + Page_type with "questionnoanswer" etc.; quest_name_constructor mutable via publish_on_the_site + statusQuest; user Balance_coin + Getting_5_coins list + countCoinMadeIt; create_answer_card_list + addAnswerCard API events + correctAnswer* + require_confirm + "steps_for_accruing_coins_" + 82 quest-page workflows + 1163 total imperative SetCustomState/ChangeThing; zero "offline"/"snapshot"/"bundle"/"PWA" mentions; dupe page vs page_constructor + quest vs quest_name_constructor).

**Categories (exhaustive, not filtered for "likely"):**

### Versioning & Snapshot / Freeze Semantics
- Admin publishes corrected answers/new steps mid-player's 3-day offline play on vN → old attempt stays on vN frozen answers/outcomes (intentional per locked, but "buggy quest version can never be fixed").
- Player completes quest on vN (buggy answers), later author fixes in vN+1; recorded analytics per version show "wrong" correct answers used.
- Version granularity: whole-quest snapshot vs per-step? (open in 01). If per-step, drift within one "version" of attempt?
- New attempt after old one: must get strictly latest published at *start* time, even if player has old bundle cached.
- Re-download exact old snapshot after app clear / reinstall / storage purge for an *in-progress* old attempt: requires server to retain historical full snapshots (or reconstructible manifests) forever (or until attempt abandoned). If not retained → player cannot continue old attempt offline (only view server-recorded facts?).
- Quest unpublished/archived after some players downloaded: existing grants + frozen attempts must still allow play/re-dl of that snapshot.
- Import of old non-versioned answer_cards (from discovery): old cards were created against whatever the live page_constructor.Answer list was at mutation time via server workflow. No historical answer lists persisted. How to assign a "snapshot" on import? Synthetic "legacy-v0-<quest>-<import-time>"? Or map to nearest published? is_correct derived from old Complited/Count_wrong flags? Submitted values lost forever in old data (schema didn't store them).
- Concurrent publish while players downloading: what snapshot do they get? (race on "latest").
- Snapshot id stability: if using timestamp or hash(content), how to handle "re-publish same content" idempotency?

### Multi-Device, Offline Duration, Sync Races & Merge
- Two devices, same player, same quest, *both offline for days*: Device A starts attempt A1 on v1 (downloaded), plays to step 7 (answer correct per v1), spends 3 coins on hint. Device B starts *new* attempt B2 on v2 (if it came online briefly and got latest) or same v1. Or both on same attempt? (attempt sharing not specified).
- Same attempt continued on two devices offline: completions on A for steps 1-5, on B for 5-9 (overlap on 5 with conflicting submitted answer or coin spend). On sync (A first, then B): merge by (attempt, step_pos, version)? Last-write-wins on ts? Union for completions? Sum/min for coins (risk overspend)?
- Long offline (3+ days): client local clock skew vs server; client_ts used for order?
- Flaky reconnect mid-sync: partial upload of completions succeeds for steps 1-3, 5 fails; retry must be idempotent (no duplicate coin deduct on server).
- Sync while playing (background): new local completion arrives after partial sync started.
- Reset progress on attempt while offline on one device; other device has local progress; sync order?
- Coin reconciliation races: earnings (gift step or quest completion "5 coins" or per-step Gift_Coins) recorded locally + spends; two devices spend more than master balance in overlapping offline windows → server must detect overdraft on reconcile and ? (reject spend? correct local state on next load per 03? "A completion that the server marks incorrect (or a hint spend that would overdraft coins) can cause the local attempt state to be corrected on next load").
- Player has cached balance from prior sync; spends offline; another quest awards coins via its sync in between.
- "Master player coins = sum of earnings from completed quests/gifts minus spends" — but per-attempt spends vs global? Old was global on user; new model must decide (per locked: per-attempt coin spend/earn tracked, master reconciliation).

### Client Validation, Bundle Integrity, Tamper, "Protected"
- Plain strings in bundle (locked decision): trivial for attacker with dev tools / rooted device / patched PWA / localStorage edit / proxy to make *any* input "correct" for that frozen version. Client matching bug (e.g., bad "contains", unicode, case) permanently records wrong is_correct for all players on that version.
- Bundle hash: verified on initial download/load? What if corrupted mid-storage (quota pressure, OS clear)?
- Re-download after clear: client must re-verify hash/integrity of historical snapshot.
- "Protected representation" open question in 07 (hashed? encrypted?); locked 08 chose "plain multiline" for constructor + "plain strings" in bundle + "basic membership" for MVP. Cheating "deprioritized".
- Client must implement the *exact* matching rules that were used to author the snapshot (to avoid drift between "what author thought correct" and recorded).
- Storage quota hit *mid-quest* (after partial media cache or during download of 5MB + images/videos): partial bundle? Can player continue with what they have? UX for "quest too big", "clear other quests"?
- Service Worker / Cache API / IndexedDB failures on low-end devices; bundle too big for some browsers' per-origin quotas.
- Offline play with no prior login? (auth question in 05/07): can local attempt be "claimed" later on sync? (strongly discouraged per 05).

### Physical Steps ("honesty without proof"), Confirmation, "questionnoanswer"
- Player taps "I found it / I performed the action / Done" for a physical step without ever going there (or from wrong location). No geo proof (display-only per locked). Accepted as v1.
- "require_confirm" in old API/events — old had some confirmation mechanic; new simplifies to uniform "player_confirmed" for all physical (no subtypes).
- Undo a mistaken physical confirm: only via full attempt reset (per 03).
- Physical step + hint coin spend: reveal geo (display) even if player never visited.
- Mixed physical + answer in sequence; player can skip physicals dishonestly to reach answers.

### Coins, Gifts, Earnings, Spends (intersection with validation model)
- Gift step awards coins locally (per snapshot); on sync, server must credit master balance exactly once per (attempt, gift_step, version) even on retry.
- "5 coins for completing" (old user.Getting_5_coins_for_completing list + quest countCoinMadeIt + workflows): per-attempt? First completion only? Per version? How to prevent double-award on reset/replay or multi-device.
- Spend > available (local cached balance lies because of other-device spend): server rejects on reconcile; local state corrected later.
- Coin balance visible in offline? Cached snapshot of master or per-attempt delta only?
- Old scattered: Balance_coin on user, Gift_Coins on page_constructor, workflows "steps_for_accruing_coins_", correctAnswer* events that presumably awarded. New must centralize in reconciliation events.

### Sync Protocol, Recording, Analytics, Error Recovery
- Server records *submitted value* (for answers) even if "wrong" per local — for author analytics per version. Good.
- What if on sync the server detects the snapshot_id the client claims no longer exists or hash mismatch? (client tampered bundle or import error).
- "Local is_correct" vs server view: per locked, server trusts it; but 07 still asks "when an answer is validated locally as correct but server says incorrect on sync (author changed..., or hash mismatch), what does the player see...".
- Partial quest complete offline → sync → later continue on latest version? No: attempt is bound to its version forever.
- Attempt "Completed" flag set locally (via terminal step or explicit); sync records it for that version.
- Reviews post-completion: tied to attempt + version?
- Background sync + "you are offline / sync pending / conflicts" UI (should-have in 06).
- Idempotency keys for sync payloads (device + attempt + last_synced_seq or similar).
- Client clears local data mid-sync or after partial; progress must be recoverable from server facts on re-auth + re-dl of correct snapshot for that attempt.
- Multi-attempt per player/quest: each bound to (possibly different) snapshot.

### Migration / Import / Historical Fidelity (cross to ANALYZE-09)
- Old answer_card records (no version, no submitted text, flags + wrong count + hint bought) must be turned into QuestAttempt + StepCompletionFacts bound to *some* snapshot. How to reconstruct the exact answer list that was live when that card was last mutated? (discovery data doesn't retain history; only current page_constructor state at export time).
- Old "Complited_quest" / You_made_it on cards vs per-attempt status.
- Old no explicit attempts: reconstruction may collapse multiple answer_card sets into synthetic attempts or one "legacy attempt" per user/quest.
- Coins from old: user.Balance_coin + historical spends from Buy_hint on cards → initial master balance + historical tx log?
- "Importing historical grants + attempt history (including old step completions) from the Bubble data is desirable" (07/08 locked yes).

### Other Best-Practice / Non-Functional Violations
- No explicit aggregates in old (answer_card + user lists + page lists = implicit progress; 47 types sprawl).
- Scattered logic (violates DRY/SOLID; coins, validation, completion all over 82+ workflows + reusables + scheduled).
- Mutable content (violates "changing published should not retroactively break" from 01).
- No offline design at all (violates hard PWA req).
- Assumed always-connected for critical paths (addAnswerCard etc.).
- UI state in DB (old user had 30 fields of junk).
- No invariants documented for old progress (e.g., "at most one answer_card per user+page+quest?").
- Storage: 5MB "comfortable" but accumulated quests + videos + many players' devices + low-end Android quota pressure + "clear site data" nukes everything.
- Cheating/physical honesty: accepted trade-off, but "model must support offline without turning client into untrusted oracle for paid content" (00 vision) is in tension with plain client-only validation.
- TDD/SOLID/DRY/KISS/YAGNI: locked model is thin on protocol details, making it hard to TDD the sync/merge/reconcile without further invention; old was the anti-pattern (imperative everything).
- Bottlenecks: full bundle re-dl for every old attempt on every clear (bandwidth for users on mobile); server storing N versions × 5MB for popular quests over years; sync payload size for long quests with many wrong answers recorded.
- Race on first download + first attempt creation (grant check + snapshot selection).
- Player buys grant, downloads v1, starts attempt, immediately loses connectivity for days; meanwhile admin publishes v2 with price change or unpublish? Grant survives (per 02).
- Terminal step + review + "You_made_it" coin award timing (old workflows had specific order).

**Bottlenecks / violations summary:** Old system: accidental complexity (dupe types, 1163 workflows, no versioning/offline, scattered everything, answer_card as mutable flag bag with lost data). Locked v0.2: deliberate simplification that accepts "freezing bugs + client-as-oracle" but underspecifies the hard parts (merge, retention, protection, recovery, migration reconstruction) and still has internal doc contradictions. Both violate long-term maintainability and robustness under the exact constraints given.

---

## 2. Expose: Harsh List of Every Flaw

**In the current locked v0.2 model (03 + 08 decisions):**
- Freezing buggy answers is "intentional" but makes content quality decay over time for early players; authors have no path to "fix for everyone who started on vN" without forcing replay on new version (which changes the experience).
- Client is *sole judge* of is_correct for the version; any bug in the (deferred normalization + membership) implementation is permanently recorded truth for analytics, stats, player "completion" sense, and potentially future features (badges?).
- Plain strings + no receipt/tamper evidence: trivial local edit makes paid content "solved" dishonestly; contradicts spirit of "server remains source of truth for final correctness" (even if we record the lie).
- Snapshot retention is "ideally" needed but not decided; without it, "re-download after clear" for old attempts is broken → violates "old attempts frozen to their snapshot" playability.
- Multi-device merge and coin overdraft correction are hand-waved ("last-write or union"; "local state corrected on next load") — no precise semantics, no idempotency model, no compensation actions documented. Race conditions will cause lost progress or negative coins in practice.
- Physical "honesty" accepted but reduces magic; "questionnoanswer" old type existed precisely because some steps had no answer but still needed tracking.
- "Protected representation" question from 07 was answered with "plain" in 08 — weakest possible choice for a paid offline experience.
- Still carries legacy contradictions (06_V1 mentions server re-val in one place).
- No first-class modeling of "the validation rules for a version" as a first-class value that can be hashed/referenced independently of full content (hurts DRY if answers are the only varying part).
- Assumes client can always store full 5MB + media reliably; no progressive download or "core steps first" strategy.
- Sync is "recording only" but then immediately adds coin reconciliation (which *is* authoritative adjustment) + "corrections" — blurs the "no re-val" line.
- Migration path for old answer_cards (no versions, no submitted values) is left as risk in 07; importing will either lose fidelity or require synthetic snapshots that don't match any real historical publish event.
- YAGNI? The model is minimal but the *implications* (retention, publishing mechanics per ANALYZE-02, client storage layer, merge) add hidden complexity that will violate KISS if not designed up front.
- Readability: the 03 doc is narrative but lacks crisp invariants, state machine for attempt+sync, or error taxonomy.

**In the old Bubble implementation (discovery + docs as historical):**
- Zero offline/PWA/bundle/versioning support whatsoever — all paths (addAnswerCard, create_answer_card_list, correctAnswer*, quest page 82 workflows) assumed live connectivity to server that always had the *current* page_constructor answers.
- Mutable-in-place content (publish_on_the_site + statusQuest + direct edit of page_constructor.Answer lists) means past playthroughs could silently change semantics if answers were edited post-play.
- answer_card is a classic "bag of flags" (del, Buy_hint, Complited, You_made_it, Complited_quest, Count_wrong_answers) mutated imperatively by dozens of workflows — violates every SOLID/DRY principle; no clean StepCompletion aggregate.
- No storage of the *player's submitted answer text* (from schema extract) — only outcome flags + wrong count. Analytics on "what players actually entered" were impossible or hacked elsewhere.
- Duplicated types (page == page_constructor in data; quest == quest_name_constructor) purely for Bubble editor limitations — 47 types sprawl, most dead (events).
- Coin economy scattered across user.Balance_coin, page_constructor.Gift_Coins, quest.countCoinMadeIt, user.Getting_5_coins_for_completing list, "steps_for_accruing_coins_" reusable, correctAnswer events, scheduled workflows — unmaintainable.
- "require_confirm" hints at physical confirmation, but implemented in the same imperative mess.
- 1163 workflows, 444 SetCustomState (UI state machines in DB), ignored privacy rules on critical paths (per 09), unknown plugins, "666" scheduled copy-paste — the anti-pattern for everything we claim to value (TDD/SOLID etc.).
- Progress model had no "attempt" root; it was user + lists of answer_cards + completed_quests lists. Reset/continue/replay semantics were whatever the 82 workflows did on the quest page.
- Validation always server-side (via workflows triggered from client input) — the exact opposite of the new hard req for local client val.
- No integrity, no bundles, no hashes, no version binding. Changing a published quest *did* affect everyone.

**In naive ports or "just make the old work offline":**
- Porting answer_card + workflows directly would embed all the scattering, dupe types, mutable content, and lack of offline design.
- Adding "offline mode" flag + local caching of current answers without explicit snapshots/versions would violate "old attempts frozen", "new gets latest", and "no re-val on sync".
- Treating client local val as "provisional" (to be overridden on sync) directly contradicts the locked stakeholder direction.
- Ignoring the need for historical snapshot retention would break replay of old attempts after clears.

**Accepted trade-offs so far (re-attacked):**
- "Frozen buggy answers" — accepted to enable offline; harsh cost to content quality and author iteration.
- "Client is the judge" — accepted; harsh cost to recorded truth and cheat resistance.
- Physical honesty — accepted for v1; harsh reduction in "real-world" magic for location quests.
- Plain strings for now — accepted; harsh for security/audit.
- These are *not* proven optimal; they are the minimal cut that satisfies the "full offline + no reval" mandate. Every one is a flaw until alternatives (within the mandate) are exhausted.

**Cross-cutting:** The model still has open questions from 07 that directly impact it (protected rep, multi-device merge, storage UX, legacy import complexity, "when locally correct but server says no"). Versioning/publishing (ANALYZE-02) and QuestAttempt/sync (ANALYZE-05) are sibling concerns; any design here must compose cleanly or the whole is flawed.

---

## 3. Rebuild: Three Distinct Approaches + Full Internal Cycle for Each

I designed and attacked three meaningfully different families. They all obey the hard requirements (client local validation against its downloaded snapshot/version; *no* server re-computation/override of is_correct on sync; new attempts bind to latest published at start time; old attempts frozen; sync = record submissions + client-claimed outcomes + per-version analytics + coin reconciliation). They differ in representation of "the snapshot", protection/integrity, server storage model, local progress representation, merge strategy, and tamper evidence.

For each: (a) clear description, (b) deconstruct its specific + general edges/races, (c) expose flaws harshly, (d) rebuild a superior variant, (e) self-critique the variant.

### Approach 1: Monolithic Immutable Snapshot Bundles (Closest to Locked v0.2 Baseline)

**Description:**
- **Data model for bundle/snapshot:** Server (on publish) materializes a full QuestSnapshot record: {id: uuid or questId:seq, quest_id, version_num (incrementing), published_at, serialized_content: {steps: [{pos, kind: 'physical'|'answer'|'narrative'|'gift'|'video'|'terminal', ...all text/media/geo/hint refs, acceptable_answers: string[] (plain from constructor) }], ...}, media_manifest: [{url_or_embed, hash}], integrity_hash: sha256(whole), total_size_bytes}. Snapshots are immutable once published.
- **Client does:** Authenticated download (server checks AccessGrant or free) of the *current latest* snapshot for a quest → stores the entire bundle (or extracted steps + answers) in client storage (e.g. IndexedDB key = `snapshot:${snapshot_id}`) + a local QuestAttempt record bound to that snapshot_id (with current_step, completions map or list, local_coin_delta, status). For answer steps: on submit, exact/contains membership against the *local copy of acceptable_answers* → immediate feedback + set is_correct_local + wrong_count++. Physical: on explicit confirm tap → player_confirmed=true (no is_correct beyond that). Hint spend: deduct local, reveal. All purely local. On reconnect: collect pending local completions/events for that (attempt, snapshot_id), POST idempotent sync payload (player, grant proof or session, snapshot_id, attempt_local_id or server attempt_id, list of {step_pos, submitted (or null), player_confirmed, is_correct_local, coins_spent_on_hint, client_ts, ...}, net_coin_delta_from_this_sync, ...). 
- **Server records:** On sync: locate/create QuestAttempt (player, quest, snapshot_id). For each completion: INSERT or upsert (idempotent by (attempt_id, step_pos, snapshot_id, client_ts or seq)) a StepCompletionFact {submitted, player_confirmed, is_correct: the_value_from_client, coins_spent..., completed_at_client, synced_at, version_snapshot_id}. *Never* re-compute is_correct from submitted using live content. Record VersionedAnalyticsEvent (wrong answers submitted against this snapshot). Reconcile: apply coin earnings (from gift steps in the completions or terminal "made it") and spends to a CoinLedger or player master balance (idempotent via sync batch id or attempt+seq). Return to client: confirmation + any corrections (e.g. "this spend overdrafted; your local delta adjusted") + latest known master coin balance.
- **Versions handled:** Publish action (constructor) creates a *new* immutable snapshot (full copy of current authored state). Attempts started after publish get the new id. Old attempts retain pointer to their snapshot id; client must have (or re-dl) the bundle for that id to play/validate offline.
- **Sync protocol:** Push-only facts from client (client is source of play truth for its version). Idempotent upserts. Optional background sync. Error: 409 conflict on version? 404 snapshot unknown → client must re-dl or treat as fatal for that attempt. Client retries with backoff + dedup key.
- **Error recovery:** On next online load of attempt: if server has facts newer than local, merge (prefer server for coins? union for completions). If local has unsynced, push. On clear: re-auth, list player's attempts (with their snapshot_ids), offer re-dl of required snapshots (server serves historical ones), replay facts into local bundle state for offline resume. Quota: client can evict old bundles for *completed* attempts (keep facts?); warn on download if remaining quota low.

**Deconstruct its edges/races (applied to this approach):**
- All the general list above apply. Monolithic = every version is a full ~5MB copy on server + full re-dl for every historical attempt after clear (bandwidth pain for users with many old attempts or long-lived quests).
- Multi-device overlap on same attempt+version: last ts wins on StepCompletionFact upsert → lost work if clocks skew or slow sync.
- Coin race: two devices each spend 10 on different hints while offline; master had 15 → after both sync, server sees net -20 → overdraft correction must "correct local state" (what does client show? retroactively mark a hint un-revealed? ugly).
- Version drift during long offline: player has v1 bundle + local progress; v2 published; player cannot "upgrade" the in-progress attempt (frozen per rules); if they want v2 answers they must start *new* attempt (new snapshot).
- Import legacy: must synthesize a snapshot_id + full answer lists by... snapshotting the *current* page_constructor state at import time and back-porting the old flags as is_correct? But that snapshot may not match what the old cards actually validated against.
- Bundle corruption / hash fail on re-dl or load: client cannot validate locally → stuck or falls back to "read-only synced facts" mode (no new offline progress?).
- Plain strings: easy tamper (edit IndexedDB answers list or monkey-patch matcher).
- Storage pressure:  N versions × 5MB on server (popular quest over years) + client side multiple quests.
- Publish race: two admins publish nearly simultaneously → two snapshots; which is "latest"? Client download sees one or the other.
- Re-dl of very old snapshot: if media files were deleted from storage, bundle incomplete.

**Expose flaws harshly (this approach):**
- It is basically the locked v0.2 with more words; inherits every self-critique in 03 (frozen bugs, client judge, retention requirement). Monolithic copies are the simplest to describe/implement for v1 but the least YAGNI for storage and the least DRY (same step content duplicated across versions if only one answer changed). No protection beyond a hash that client itself can ignore after load. Merge is last-write, which is the weakest possible for concurrent offline progress (violates "highest maintainability"). Import path is still underspecified and will produce "fake" snapshots that never existed in the publishing history. Error recovery "correct local state" is hand-wavy and will lead to confusing UX (hints disappearing after sync). It satisfies the letter of the hard reqs but not the spirit of robust, elegant design under TDD/SOLID constraints. Bottleneck on re-downloads and server bloat is accepted without mitigation.

**Rebuild a superior variant of it (A'):** 
Make snapshots *content-addressable at the step level inside the monolithic wrapper* for minor dedup, add an append-only local EventLog per (local_attempt, snapshot) (events = AnswerSubmitted {step, value, ts}, HintSpent {step, ts}, PhysicalConfirmed {step, note?, ts}, ...), change sync to upload the *log tail since last_sync_seq* (server replays the log into facts but still records the client's claimed is_correct without re-computing it; the log gives deterministic order for merge). Add explicit SnapshotRetentionPolicy (keep all snapshots that have ≥1 in-progress or recently-completed attempt; allow admin "prune old completed" with warning that re-dl will be impossible). For protection: embed *salted hashes* of the acceptable strings (salt = random per snapshot, delivered in bundle; client checks input_hash(salt+trim(input)) in the list of pre-hashed). Receipt on sync: include log_event_hash_chain (prev_hash + event) so server can detect some client-side reordering or omission on retry. For import: during migration, for each distinct "last mutated" set of answer lists observed across old cards for a quest, synthesize one LegacySnapshot + backfill the cards as facts against it (using old Complited etc. for is_correct). On multi-device: use the event log + vector clocks or simple seq per device for better merge (union unique events, conflict on same (step, type) by latest ts + device priority or manual). Coin: every coin-affecting event carries a "delta" and a "source_event_id"; server applies in log order, detects overdraft per reconciliation window and emits a CompensationEvent that client must apply (e.g. "hint on step 4 was not affordable; it is now unrevealed locally").

**Self-critique of the superior variant (A'):** 
This is better: event sourcing improves merge determinism and replayability (huge for TDD and "exactly once" coin awards), salted hashes + receipt raise the bar for casual tampering and give audit trail without violating no-reval (server can later *detect inconsistency* between submitted and claimed_is_correct by re-hashing if it has the salt, which it does since it created the snapshot). Retention policy is explicit. Import has a concrete (if ugly) path. Still, it is "monolithic wrapper around slightly better internals" — server still stores near-full copies per version (only intra-snapshot step dedup helps little if steps rarely shared). The compensation UX for overdraft/hint-unreveal is still complex and may violate KISS for players. Adding event log + vector clocks + hash chains increases conceptual surface (more to TDD, more to document, more client code for log maintenance). For ~5MB linear quests with low concurrency, the extra machinery may be overkill (YAGNI violation). It improves on baseline but does not address the fundamental storage duplication or the "client fully trusted for outcome" root issue. If a sibling analysis (versioning) makes per-step immutable natural, this variant's monolithic assumption becomes a dead end.

### Approach 2: Content-Addressable / Normalized Versioned Entities + Manifest Assembly (Deduplicated Snapshots)

**Description:**
- **Data model for bundle/snapshot:** On publish (or step edit that is published), the constructor produces *immutable* StepVersion entities: {step_version_id: content_hash( pos, kind, all_text_RU, media_hashes, geo?, hint_content?, acceptable_answers: string[] or their hashes, gift_coins?, ... ) }. AnswerSetVersion can be further split if desired ( {answer_set_id: hash( list of strings or their per-answer hashes ), strings or hashes} ). A QuestSnapshotManifest is a small record: {snapshot_id, quest_id, version_num, published_at, step_sequence: [ {pos, step_version_id, answer_set_version_id?} ], overall_manifest_hash, total_estimated_size }. The "bundle" the client downloads is the manifest + the *referenced step blobs* (or a single tarball of them for atomicity) + media. Client stores the assembled local view keyed by snapshot_id (or by the step_version_ids for sharing across snapshots). Server stores the StepVersion and Manifest rows (deduped by hash); actual blobs can be in object storage keyed by hash.
- **Client does:** Download = GET manifest for latest (or specific) snapshot_id → fetch the (few) missing step_version blobs by their ids (cacheable by hash across quests/versions) → assemble in-memory or local "playable quest for vX" with the acceptable data from the blobs → same local validation as Approach 1 against the assembled data. Local attempt still bound to snapshot_id (or directly to the manifest hash for purity). Progress same (or event log). Sync payload includes the snapshot_id + the step_version_ids used for the steps (for precise recording).
- **Server records:** Same facts as Approach 1, but StepCompletionFact can reference step_version_id (or pos + snapshot) for finer analytics ("this wrong answer was against step_version Z which had these exact answers"). Coin reconciliation identical. Historical manifests allow exact re-assembly of any old bundle from the referenced immutable step versions (no need to store "full quest copy" per snapshot if steps are shared).
- **Versions handled:** Publish creates new Manifest pointing at (possibly new, possibly reused) step_version_ids. A step that didn't change reuses its prior step_version_id. New attempts get the latest manifest/snapshot. Old attempts keep their manifest id; client can re-assemble from server by requesting the manifest + its step blobs (even years later).
- **Sync protocol & error recovery:** Same push facts, but with richer refs. On re-dl for cleared client: request manifest by the attempt's snapshot_id → client reconstructs the exact playable data (incl exact answer lists that were live for that version) from the immutable pieces. If a referenced step_version blob is missing (storage GC error), fatal or degraded (cannot validate new answers offline for that attempt). Integrity: manifest_hash + per-blob hashes. Quota: client can share cached step_version blobs across many snapshots/quests (big win for storage pressure).
- **Other:** Constructor/publishing (cross ANALYZE-02/07) must emit the immutable versions + manifest. Media still hashed/cached by content.

**Deconstruct its edges/races (specific + general):**
- General list applies (version drift, multi-dev, coins, physical honesty, import, quota mid-quest, etc.).
- Hash collisions (theoretical for content hashes; use strong hash).
- Step that is edited *after* some manifests reference it: old manifests keep old step_version_id (immutable); new manifest gets new id. Good.
- During long offline on vN manifest: new step versions published; player cannot "hot-swap" a single step into their in-progress attempt (frozen).
- Re-assembly on re-dl: must be deterministic (same manifest + same step_version_ids → identical local validation rules and UI content). Media URLs or embedded must resolve offline.
- Import legacy: even harder — must synthesize not only a manifest but also StepVersion and AnswerSetVersion rows that capture the exact answer lists that were effective for each old answer_card at the time of its creation/mutation. Since old data has no history, may need to group old cards by "effective answer set at card time" (impossible precisely) or snapshot current state into legacy versions and note "approximate".
- Publish of a quest with 50 steps: creates up to 50 new step_version rows + 1 manifest (or fewer if reuse). Overhead for tiny changes.
- Client must implement assembly from manifest + blobs correctly, or local validation data will be wrong for that snapshot (mismatch with what server thinks the snapshot contained).
- If two publishes happen with identical content: dedup should produce identical manifest id (good for idempotency).
- Multi-device: same as before, but now facts can be recorded against step_version_id which is stable across snapshots.
- Storage GC: if server prunes unreferenced step_version blobs, old manifests that still have attempts become unloadable → breaks frozen old attempts.

**Expose flaws harshly (this approach):**
- For ~5MB quests with infrequent publishes and mostly linear small changes, the dedup benefit is marginal (most steps will be new versions on any publish that touches answers or content); the machinery (content hashing every field, assembly logic on client and server, blob management, GC safety) is *added complexity* that violates KISS/YAGNI for v1. It pushes complexity into the publishing path (ANALYZE-02) and client bundle loader. Re-assembly on re-dl is elegant in theory but another place bugs can cause "my old attempt now has different answers than when I played it" (even if server records are consistent). Import fidelity is arguably worse because we are inventing step_version history that never existed. The "client assembles" step introduces a new failure mode (assembly bug → wrong local validation for a snapshot) not present in the monolithic "download the exact bytes the server used". It still has the core "client fully trusted for is_correct + plain or lightly protected answers" problem. It is more "future-proof" for branching or large content but over-engineered for the current scope. Still requires retention of manifests + referenced versions (similar problem, just factored).

**Rebuild a superior variant of it (B'):** 
Keep the normalized immutable StepVersion / AnswerSetVersion / Manifest core (good for DRY and future), but for v1 *materialize a "fat bundle" at download time* (server assembles the monolithic payload from the normalized pieces and signs/hashes the result; client stores the fat bundle or the pieces + manifest; on re-dl server re-assembles from the still-retained normalized store). This gives dedup on server storage + simple "download bytes" for client (no assembly bug on critical path for play). Add per-snapshot "answer_set" as a first-class small entity (so only answers change in many publishes). For protection: every AnswerSetVersion carries a *per-version salt*; the fat bundle (and normalized answer set) contains the list of `hash(salt + canonical(answer))` instead of plaintext. Client, to validate, computes the same and checks membership. On sync, client includes in the receipt: the submitted plaintext + claimed_is_correct + hash_of_submitted_under_salt (so server, which knows the salt from the snapshot, can verify that the client's "is_correct" claim is consistent with the submitted value *under that version's rules* — without the server re-running the full "is this the correct answer for the quest today", only "did you apply the rules you were given?"). This is *not* re-validation of correctness against live; it is consistency check of the client's claim for the frozen snapshot. For merge: use the event-sourced log from A' (upload log entries that reference the step_version_id). For import: create legacy StepVersion/AnswerSet rows by taking the answer lists from the *old page_constructor records as exported* (or from any surviving answer_card context) at migration time, synthesize manifests for "batches" of old playthroughs that likely shared the same live content, and attach the old answer_card-derived facts to those legacy manifests. Add a "snapshot provenance" field ( "published-2026-05-12" vs "legacy-import-2026-06-09-from-bubble-answer-cards" ). GC safety: never GC a step_version or answer_set that is referenced by any manifest that still has live attempts or is marked "retain for migration". Client quota: prefer storing by content-hash (step_version blobs) so shared steps across quests/versions are single copy.

**Self-critique of the superior variant (B'):** 
This is a clear improvement: server storage is normalized (better long-term), client gets simple bytes or cached pieces, the consistency receipt (without correctness re-val) gives post-sync audit power that the locked model lacks (server can flag "client claimed correct for this submitted but the salted hash doesn't match any in the frozen answer set" — useful for analytics or later anti-cheat without breaking the "no re-val" rule). Event log + normalized refs improve merge and recording. Import has the best possible fidelity given the source data (still lossy because old submitted values are gone and historical answer lists aren't versioned in Bubble). The "materialize fat bundle at dl time from normalized" is a pragmatic compromise that avoids client assembly bugs on the happy path while keeping dedup. However, it still adds significant surface (hashing, versioning entities, assembly-on-server, salt management, provenance) compared to pure monolithic. For v1 with small number of quests and infrequent publishes, this may still feel like over-engineering (YAGNI). The receipt consistency check is a *partial* mitigation of the "client is judge" problem but does not prevent a motivated client from lying about is_correct if it also lies about the hash (or omits the receipt field). Physical honesty and freezing problems remain. It composes better with sibling versioning analysis than pure monolithic. Overall stronger than A' for maintainability and storage, but the complexity tax must be paid in the content/publishing layer.

### Approach 3: Receipted Local Validation + Tamper-Evident Local Event Log + Server Passive Recorder (Focus on Verifiability + Merge)

**Description:**
- **Data model for bundle/snapshot:** Similar to locked or 2, but answers in the bundle are *always* represented as salted hashes (salt delivered with the bundle, generated at snapshot creation; or per-answer nonces). Bundle/manifest also includes a "validation rules version" or simple matcher descriptor ( "exact-membership-v1" for MVP). The snapshot id or manifest hash is the root of trust for the attempt.
- **Client does:** Same local play + validation (compute hash of canonical input, check membership in the provided acceptable_hashes list). *Additionally*, maintain an append-only, hash-chained local EventLog for the attempt (each entry: {seq, type: 'answer'|'physical'|'hint'|'gift'|'advance', step_pos or step_version, payload (submitted or note), claimed_is_correct (for answer), coins_delta, client_ts, prev_hash, entry_hash = h( prev + canonical(entry) ) }). The log is the source of truth for local state (can replay to current completions map + balances). On any completion: append event, update local view. For sync: upload the log tail (since last acked seq) + current snapshot_id + attempt binding + a "receipt" per relevant event or a root receipt (final_log_hash after the batch). Server does *not* need to re-execute the validation rules for correctness.
- **Server records:** On receipt of log tail: verify the hash chain is contiguous and untampered from the client's last ack (detects some client-side edits or replays). For each answer event, record a StepCompletionFact with the submitted, the client's claimed_is_correct, *and the client's provided receipt hash for that event* (or the computed consistency hash using salt if provided). Still *do not override* the is_correct. Record the events for full audit trail per version. Apply coin deltas from the events in log order (detect overdraft windows). Return acked seq + any compensation events (which client appends to its log as special "server_correction" entries, forcing local replay/adjustment).
- **Versions handled:** Same binding of attempt to snapshot at start. Old frozen attempts have their log + the snapshot they were started with. New attempts get latest snapshot (and start a fresh log for that new attempt).
- **Sync protocol & error recovery:** Log-based sync is naturally idempotent and merge-friendly (multiple devices can append events; server orders by the provided client seqs + device id or by arrival with tie-break; on conflict for same seq/step, keep both or latest by ts + emit correction). On reconnect after long offline or multi-dev: client sends its current log head; server replays/ merges into the authoritative fact log for that (player,quest,snapshot,attempt); client pulls any server-side events since its last head and appends them (forcing local replay of state, including corrections). For cleared client + old attempt: re-dl the snapshot bundle (using historical manifest), then pull the full authoritative event log from server for that attempt/snapshot and replay it locally to reconstruct exact progress + coin deltas + which hints were bought. This gives excellent recovery. Quota: logs are small (text + ts); bundles can still be evicted for old attempts after facts are on server (replay on demand).
- **Protection:** The combination of salted hashes in bundle + hash-chained client log + server-stored receipts (incl submitted + claimed outcome + hash) allows:
  - Client to validate fully offline.
  - Server (and later auditors) to detect "this client claimed is_correct=true for this submitted, but the submitted's hash under the snapshot's salt is not in the acceptable set for that frozen snapshot".
  - Tamper evidence on the *sequence* of decisions (missing events, reordered).
  - Still no server re-computation of "would this be correct on the live quest today".
- Analytics per version is richer (full event log).

**Deconstruct its edges/races (specific + general):**
- General list (version drift frozen, physical honesty, storage quota, import, publish races, etc.) all apply.
- Log growth: for a 100-step quest with many retries on answers, log can have hundreds of entries; still tiny vs 5MB bundle.
- Hash chain break on client (corruption, malicious edit): on sync server rejects the tail; client must resync from server head or start "degraded" (facts only).
- Multi-device log merge: device A has events seq 1-10, device B has 1-7 + 11 (from its clock); server must linearize without losing events. Possible duplicate "same logical action" (two "confirmed physical step 3" from two devices). Need canonicalization or last-wins + note conflict.
- Clock skew in client_ts inside events: used only for display/analytics, not primary order (seq + device is primary).
- Long offline + many devices: log tails become large on first sync; bandwidth.
- Salt delivery: salt must be in the bundle the client downloaded for that snapshot; if client lost the bundle but has partial log, re-dl must get the *same* salt for consistency checks.
- Import legacy: synthesize snapshot (with some salt for its answer sets), synthesize a linear event log from the old answer_card flags and counts (e.g., for each card that was Complited, emit a "physical or answer" event with claimed_is_correct from the flag, no submitted since lost, fake increasing seqs and ts from card created/modified dates). Attach to a legacy attempt. Lossy but best effort.
- Overdraft correction: server emits correction events into the log; client replays and may "un-reveal" a hint or adjust displayed balance. UX still potentially jarring.
- Client must faithfully maintain the log (append-only, correct prev_hash). Bug here = lost local progress or broken chain on sync.
- "No re-val" is preserved, but the consistency check on receipt is a new server-side computation (of the hash match) — is this "re-validation of correctness"? No, because it uses the *frozen snapshot's* answer set, not live. But it is server *judging the client's claim*. This may be in tension with the strictest reading of "NO re-validation of correctness on sync".

**Expose flaws harshly (this approach):**
- The log + receipt + consistency machinery is the most complex of the three (more code, more state machines, more things to get wrong in TDD, more to explain to maintainers). It may violate KISS/YAGNI for the MVP scope where "cheating is deprioritized" and multi-device concurrent offline play is rare. The "is this a re-val?" philosophical line is blurry and could be attacked by stakeholders ("you said no server re-val, but now server is checking the client's is_correct claim"). Hash chain maintenance on every local action is easy to get subtly wrong (off-by-one, reset handling). For physical steps, the log helps audit "player claimed done at ts" but doesn't add proof. Import is still fundamentally lossy (no old submitted values). The approach shines for auditability and merge but adds client-side persistence complexity (IndexedDB + log + replay) that the simpler map-of-completions in 1/2 does not. Still inherits freezing, physical honesty, and "client can lie if it also forges a consistent receipt" problems (a determined attacker with the salt can choose a submitted that hashes to a correct one and claim accordingly, or just patch the matcher). Server must retain full event logs + manifests + salts for all historical attempts that might be replayed — storage growth different from but not obviously better than blobs.
- It is elegant for robustness and debugging ("replay the exact sequence of offline decisions"), but the cost in complexity and the risk of over-promising tamper resistance (while still trusting client for the outcome itself) makes it suspect under the relentless skepticism mandate.

**Rebuild a superior variant of it (C'):** 
Adopt the log + hash chain + receipt core (its strengths for merge, recovery, and audit are real), but *simplify ruthlessly for v1*: make the local "state" a simple replayable log of *only the mutating events* (answer submits, physical confirms, hint spends, gift accepts, resets); narrative/advance steps are implicit in "current pos" derived on replay. Salted hashes + consistency receipt *only for answer events* (cheapest place it adds value). Do *not* do full consistency check on every sync for MVP if it risks being called "re-val" — make the receipt optional/audit-only (server always records whatever client sends for is_correct, stores the submitted + receipt blob for later offline analysis by authors; consistency check is a background analytics job, not on the sync critical path). For merge: use a simple "last seq wins per (attempt, step, event_type)" with full log retained for audit; on conflict emit a "ConflictNote" event rather than complex compensation. For import: create minimal synthetic logs (one event per old answer_card that contributed to progress). Bundle can be plain strings or lightly hashed; the log/receipt is the main "tamper evidence" layer. Add a first-class "AttemptLogHead" on the server per (attempt, snapshot) so clients can always resume from a known good server head after corruption or clear. On client, the log is the *only* local persistence for progress (completions map is a derived view that can be rebuilt by replay on load — excellent for TDD and "exactly the same state on every device after sync"). For physical honesty, the log at least gives a timestamped claim per attempt/version for authors to review in analytics. Error recovery: after any sync error or clear, "replay from server log head + re-dl snapshot if the head references steps not locally known". This variant *drops the on-sync consistency enforcement* to stay unambiguously compliant with "NO re-validation", keeps the log for its merge/recovery/audit superpowers, and treats the receipt as "nice-to-have evidence" stored for authors rather than a gate.

**Self-critique of the superior variant (C'):** 
This is the most robust for the hardest edges (multi-device long-offline, clears, replays, audit of what the player actually did) and best enables TDD (property: "replaying the authoritative log for an attempt against its snapshot always produces the same completions map and coin deltas as the server facts"). By making consistency audit-only/background, it dodges the "re-val" accusation while still giving authors the data to notice suspicious patterns ("player submitted 'foo' and claimed correct, but 'foo' salted hash not in the set for v3 of this quest"). The "log as source of truth, map as derived" is classic event sourcing done right (SOLID, testable, replayable). However, even simplified, maintaining a correct hash-chained log on the client (across app restarts, background kills, multiple tabs if web, storage quota evictions) is non-trivial and a new class of bugs not present in the "just store the final map" models. For the common case (one device, mostly online or short offline, honest players), the log is mostly overhead (YAGNI for many players). It does not solve freezing or physical honesty. It still requires the snapshot/manifest machinery from the other approaches for the bundle itself. The best parts (log + replay + audit trail) can and should be *hybridized* into the other approaches rather than standing alone as the full model. Complexity is still higher than a KISS final map + last-write sync, even if justified by the edge cases.

---

## 4. Synthesize & Recommend

**Comparison of all (including locked v0.2 as baseline "Approach 0"):**

We have four to compare: Locked (0), Refined Monolithic + log (A'), Normalized + fat-bundle + receipt (B'), Receipted log + audit-only (C').

- **Robustness (edges, races, recovery, tamper/audit):** C' > B' > A' > 0. Log + replay wins for multi-dev, clears, deterministic state. Receipts/consistency (even audit-only) > nothing. Normalized helps long-term retention/GC safety.
- **Offline fidelity & simplicity for client play:** All similar (full data at dl time or assembled). 0/A' easiest "download bytes and use". B' adds assembly (mitigated by fat materialize). C' adds log replay on every load (but derived map is fast).
- **Server storage & bandwidth (re-dl of old):** B' best (normalized + GC-safe manifests). 0/A' worst (full copies + full re-dl). C' similar to B' if using manifests.
- **Client storage pressure:** B'/C' win via content-hash sharing of steps + ability to evict bundles and replay from server logs/facts. 0/A' worse for multiple historical attempts.
- **Complexity / conceptual load (KISS/YAGNI/readability/maintainability):** 0 simplest (but incomplete). A' adds log (moderate). B' adds normalization + provenance (higher, but in content layer). C' highest (log everywhere + hash chains + replay). All proposed are more complex than the thin locked narrative because they actually specify the missing protocol/merge/recovery pieces.
- **Cheat resistance / audit / "client not untrusted oracle":** C' (receipts + stored evidence) and B' (salted + consistency) > A'/0 (plain or basic hash). None are strong (client-controlled device); all respect the "no re-val correctness on sync" rule.
- **Migration / import of old answer_cards:** All hard; B' and C' slightly better because they have richer "versioned answer sets" and "event logs" to map legacy flags into. 0/A' can synthesize monolithic legacy snapshots.
- **Composition with siblings (versioning/ANALYZE-02, attempts/ANALYZE-05, coins/04, migration/09):** B' and C' compose best (immutable versions + logs + manifests are natural for attempts and publishing). 0/A' are more "monolithic blob" which may fight fine-grained versioning.
- **TDD/SOLID/DRY/KISS/YAGNI enablement:** Event-sourced log (C' elements) + crisp aggregates (Manifest, StepVersion or Snapshot, Attempt bound to snapshot, CompletionFact, CoinReconciliationEvent, Event) are highly testable (replay properties, idempotent sync) and DRY (one log, many views). Normalization (B') is DRY for content. All proposed > old Bubble mess and > thin locked (which leaves too many "how" underspecified for TDD).
- **Long-term maintainability & evolution (branching, external authors later, richer anti-cheat, partial bundles):** B' + C' elements win (immutable pieces + full audit log + receipts make evolution safer without breaking old frozen attempts).

**Selected recommendation: Hybrid "B' + C' core" (Normalized immutable content + manifests for snapshots + fat-bundle materialization at download for client simplicity + append-only hash-chained event log as the local + sync source of truth for progress/coins + salted-hashed acceptable answers in bundles + audit-only consistency receipts stored per fact + explicit retention/provenance policy + deterministic replay/merge on sync).**

**Rigorous why (re-attacked against all flaws and constraints):**
- It satisfies *every* hard requirement without compromise (client does full local val against the data from *its* snapshot/manifest at the time it was downloaded; server records the client's claimed is_correct without ever overriding it using live content or re-executing "is this correct today"; new attempts bind to latest manifest; old are frozen to theirs; sync records + reconciles + per-version analytics).
- It directly attacks the worst flaws exposed in locked v0.2 and the deconstruct: storage duplication and re-dl cost (via normalization + manifests + ability to evict bundles); weak tamper/audit (salted hashes + receipts as evidence, even if audit-only); underspecified merge/recovery (log + replay + server heads + corrections as events); migration lossiness (richer structures to map legacy into); lack of invariants (we define them below).
- It improves maintainability/readability over locked and massively over old: clear aggregates (no answer_card bag-of-flags, no scattered coin workflows); event log enables "replay the attempt exactly" for debugging, TDD, and "what the player actually did" analytics; normalization is DRY for content that legitimately evolves; logs are append-only (good for SOLID, eventual consistency).
- Under KISS/YAGNI: the hybrid takes the *minimal* pieces that address the top risks (multi-dev offline, clears, audit, storage, import) while keeping the common path (download assembled/fat bundle, play with local map derived from log or simple state, push on sync) simple. For v1 linear ~5MB quests we can start with fat bundles + optional log (log can be added without changing the snapshot model). It does not invent branching or real-money or photo-proof.
- TDD/SOLID/DRY/KISS/YAGNI/long-term: Property-based tests fall out naturally ("for any log of events on a snapshot, replay produces same final state and same facts as server recorded"; "sync is idempotent and convergent"; "new attempt snapshot_id is always a published manifest >= any prior for that quest"; "re-dl + replay of authoritative log for an old attempt reproduces the exact is_corrects and submissions that were synced"). Aggregates have single responsibility. No dupe types. Content is immutable where it must be (freezes old attempts safely). Evolution paths (richer matchers later, partial bundles, external authors with their own snapshot provenance) are open without breaking invariants.
- It is *not perfect* (still accepts freezing and physical honesty as v1; receipts are not a full anti-cheat; complexity is higher than the absolute minimum narrative in 03; requires coordination with sibling analyses). But after attacking locked, old, and the three pure approaches + their rebuilds, this hybrid survives the most scrutiny while staying practical. Pure 0/locked is too fragile for the edges; pure C' is too heavy for the happy path; pure B' lacks the merge/recovery power of the log.

**How it improves specifically on the locked v0.2 position:** Adds the missing protocol (log-based sync with acks/heads), protection layer (salted + receipts as evidence), storage/GC model (normalized manifests), recovery story (replay from server), migration path (synthetic but structured legacy), and testability (replay properties) *without* violating any locked decision or hard req. The "client local, no re-val, frozen old, latest for new" remains exactly as mandated. The self-critiques in 03 (frozen bugs, client judge, retention) are mitigated but not eliminated (as required by the mandate); they are now explicit with better tooling around them (analytics per version + receipts + provenance).

---

## 5. Full List of Analyzed Edge Cases/Races + How Each Approach (and Recommended Hybrid) Handles Them

(Condensed; exhaustive list from Deconstruct section applied to 0/locked, A', B', C', and recommended hybrid. "Hybrid" = B'+C' as recommended.)

- **Admin publishes vN+1 while player deep in long offline on vN attempt:** All: old attempt frozen to vN (per hard req). Hybrid: player can start new attempt on vN+1; old vN bundle/manifest remains re-dl-able via its manifest + versions.
- **Multi-device both fully offline, overlapping progress on same or different attempts:** 0/A': last-ts upsert, coin overdraft possible, lost work on overlap. B': similar + step_version refs help analytics. C'/Hybrid: log tails uploaded, server linearizes (seq + device), emits conflicts as events, client replays authoritative head on next load. Best convergence.
- **Coin spend races across devices/offline windows leading to overdraft:** All detect on reconcile. 0/A'/B': "correct local state" (hints may un-reveal). C'/Hybrid: correction events appended to log, explicit replay shows the adjustment with audit trail.
- **Import old non-versioned answer_cards (no submitted values, only flags + wrong counts):** All lossy. 0/A': synthesize legacy monolithic snapshot(s) from current or grouped old data, map flags to is_correct on facts. B': synthesize StepVersion + AnswerSet + legacy Manifest + provenance="legacy-import". C'/Hybrid: same + synthetic minimal event log from card dates/flags (one event per card). Hybrid gives richest future analytics on the imported data.
- **Physical step "honesty" (tap done without doing the thing):** All accept (per hard req + physical = confirmation only). Hybrid at least timestamps the claim in the log per (attempt,version) for author review in analytics.
- **Storage quota hit mid-download or mid-quest (media or bundle):** All: client must handle partial (warn, allow continue with cached, offer to evict other quests). Hybrid: content-hash sharing (B') + ability to evict full bundles and replay progress from server logs/facts (C') reduces pressure; still need good UX.
- **Re-download after clear / reinstall for in-progress old attempt:** 0: requires full historical monolithic snapshots retained. A': same. B': re-assemble from retained manifests + step versions (or fat bundle). C'/Hybrid: re-dl snapshot + pull authoritative event log for the attempt and replay locally. Hybrid best (small logs, exact reconstruction).
- **Client bug in matching or bundle corruption:** All record whatever client claims (per no-reval). Hybrid: salted hashes + receipts (even audit-only) allow *later detection* that "submitted X claimed correct but hash not in the frozen set for this snapshot" → valuable for authors without overriding the record.
- **Flaky network, partial sync, retries:** All need idempotency. Hybrid: log seq + acked heads make it natural and convergent; duplicate events are no-ops or noted.
- **Attempt reset while offline (one or more devices):** All: local clear of completions for that attempt. Hybrid: reset event in log; on sync it clears server facts for that attempt (or marks superseded) while preserving the attempt and snapshot binding + coin history up to reset.
- **New attempt gets latest; old stays frozen even across clears:** All (hard req). Hybrid enforces via attempt → snapshot/manifest binding; re-dl uses the bound id.
- **"5 coins for completing" or gift awards double-counted or missed on replay/reset/multi-dev:** Hybrid: awards are events in the per-attempt log; server applies exactly once per event id/seq on replay; Getting_5 equivalent is "has this completion event been processed for award" in the ledger.
- **Player tampers bundle to make everything correct for their frozen version:** 0/A': trivial (plain strings or weak). B'/C'/Hybrid: requires also forging consistent receipt hashes under the salt (harder for casual, still possible for determined + they still only affect *their* attempt's records).
- **Snapshot retention / GC accidentally deletes data needed for old attempts:** 0/A': broken re-dl. B': GC must respect manifest refs + "has attempts" flag. C'/Hybrid: same + event logs retained for attempts; manifests reference versions that must be kept.
- **Version/publish race on "latest" at download time:** Server transaction or seq num on publish; client gets a specific snapshot_id/manifest at the moment of successful download + attempt creation.
- **Old answer_card had no submitted text; analytics poor:** Hybrid (and B'/C') record submitted when available (new system); for import, note "submitted unknown, only outcome".
- **Clock skew, client_ts vs server:** Use for display only; primary order from log seq + sync arrival + device id.
- **Quest unpublished after download:** Existing attempts + grants + snapshot re-dl still work (per commerce invariants).
- **Media (short videos) not cacheable or too big in 5MB:** Per 04/06: cache what fits; reference or progressive if needed; client warns.
- **Login required for already-downloaded?** Per 05: prefer login at download/first play; local-only play for downloaded discouraged (hard to associate later).
- **Branching (future, out of v1):** Manifests + step versions + logs compose naturally (future conditional steps in sequence or graph); frozen attempts stay linear on their snapshot.

**Summary:** The recommended hybrid handles the *most* of these cleanly and with auditability/recoverability; pure locked (0) handles the fewest beyond the happy path.

---

## 6. Trade-off Matrix (High-Level)

| Dimension                  | Locked v0.2 (0) | Refined Monolithic (A') | Normalized Manifest (B') | Receipted Log (C') | Recommended Hybrid (B'+C') |
|----------------------------|-----------------|--------------------------|---------------------------|--------------------|-----------------------------|
| Offline fidelity (client val) | Full           | Full                    | Full (w/ assembly or fat) | Full + replay     | Full (fat or pieces + replay) |
| No re-val on sync          | Yes            | Yes                     | Yes                       | Yes (audit-only)  | Yes (audit-only)           |
| New=latest, old=frozen     | Yes            | Yes                     | Yes                       | Yes               | Yes                        |
| Multi-dev / long-offline merge | Weak (last-ts) | Better (log)            | Better (refs)             | Best (log + heads)| Best                       |
| Recovery after clear       | Re-dl full     | Re-dl full              | Re-assemble or fat        | Re-dl + replay log| Best (replay + normalized) |
| Storage (server/client)    | Worst (copies) | Bad                     | Best (dedup + GC)         | Good              | Best                       |
| Tamper evidence / audit    | None           | Basic hash + log        | Salted + receipt          | Best (chain + receipts) | Best                    |
| Complexity (KISS)          | Lowest (but incomplete) | Medium                 | Medium-High               | Highest           | Medium-High (pragmatic)    |
| Migration fidelity         | Low            | Low-Medium              | Medium                    | Medium-High       | Highest possible given source |
| TDD / testability          | Low (underspec) | Good (log replay)      | Good                      | Excellent (properties) | Excellent                |
| Long-term evolution        | Poor           | Medium                  | Good                      | Good              | Best                       |
| Cheat resistance (v1)      | Lowest         | Low                     | Medium                    | Medium-High       | Medium-High                |
| Fits ~5MB linear v1        | Yes            | Yes                     | Yes (overhead)            | Yes (overhead)    | Yes (start simple)         |

---

## 7. Recommended Invariants for This Area (to be codified in code, tests, and docs)

These must hold for the chosen model (hybrid) and are the bar any implementation or future change must meet. They derive from the hard requirements + the deconstruct/expose.

1. Every QuestAttempt (or equivalent) is immutably bound at creation/start to exactly one QuestSnapshot / Manifest (identified by snapshot_id or manifest_hash). All local validation, coin deltas, and completions for that attempt use *only* the rules and content from that bound snapshot.
2. The client performs *all* validation of answer correctness and physical confirmations using only its locally-held copy of the bound snapshot's data. The server never re-computes or overrides `is_correct` (or equivalent) for a completion using any data newer than or different from the snapshot the attempt is bound to.
3. When a player initiates a new attempt (or the system creates one on first download/play), the bound snapshot is the latest published manifest/snapshot for that quest at the exact moment of attempt creation/download authorization.
4. Sync is append-only recording of submissions, client-claimed outcomes (is_correct etc.), and coin-affecting events from the client's log for that (attempt, snapshot). Server applies them as facts; reconciliation of coins is a separate idempotent ledger operation that may emit correction events but does not rewrite play outcomes.
5. Old attempts and their snapshots remain playable and re-downloadable (via manifest + referenced immutable pieces or retained fat bundle) for the lifetime of the attempt (or until explicit abandonment + retention policy allows prune). New publishes never affect them.
6. The acceptable answers (or their salted hashes) for answer steps are part of the snapshot data delivered to the client at download time for that version; they are sufficient for the client to perform the (MVP basic membership) validation entirely locally.
7. All coin-affecting actions (spends on hints, earnings from gifts or completions) are represented as events in the per-attempt log for the bound snapshot. Master balance is the result of deterministic replay/reconciliation of all such events across all attempts for the player. Double-award or overdraft is prevented by event identity and ordering.
8. Physical/"no-answer" steps are completed solely by explicit client-side player confirmation action (player_confirmed). There are no acceptable answers for them in any snapshot. Their "correctness" is the fact of the confirmation claim.
9. On any re-dl or replay from server facts/logs for an old attempt, the reconstructed local state (completions, is_corrects as originally claimed, coin deltas, revealed hints) must be identical to what was synced at the time (modulo later corrections emitted as events).
10. Snapshot manifests/versions and their answer data are immutable once published/created. Changing authored content produces a new manifest/version.
11. Sync payloads and server recording are idempotent with respect to retries and multi-device delivery order (convergent via log seq / event identity).
12. Legacy imported answer_card data is attached to synthetic "legacy-..." snapshots/manifests with provenance metadata; their is_corrects are derived from the historical flags (not re-computed); submitted values are recorded as "unknown" where not available.
13. Client bundle/manifest for a snapshot is self-describing (contains its id, hash, the exact data needed for validation and play of attempts bound to it). Integrity (hash) is verified on load/use where possible.
14. (Cross-cutting) AccessGrant (or free) is required to obtain any snapshot for play; grants are lifetime and independent of versions/attempts.

These invariants enable the TDD properties and make the area maintainable. Violating any is a bug or a requirements change requiring updated decisions.

---

## 8. Open Questions / Risks (Remaining After This Analysis — to feed siblings + stakeholder)

- Exact salt strategy and "consistency receipt" details (per-version? per-answer-set? delivered how? optional for v1?). Does including the consistency check on the critical sync path count as forbidden "re-val"?
- Precise retention policy + GC rules + admin tooling for pruning (when can a snapshot/manifest + its versions + its attempt logs be deleted?).
- How "version" / publish exactly increments and what constitutes a publish-worthy change (any step edit? only answers? explicit "publish version" button?). (Primarily ANALYZE-02.)
- Multi-attempt sharing or "continue across devices" semantics beyond independent attempts + log merge. (ANALYZE-05.)
- Exact coin economy triggers and "5 coins for completing" equivalent in the new event model (per attempt? per quest ever? first completion per player per quest per version?). (ANALYZE-04.)
- Migration fidelity targets: do we require *any* historical submitted answers, or is "outcome + wrong count + hint bought" sufficient? How much manual mapping of old page_types to new GameStep kinds?
- Storage quota UX and "evict which quests" policy on client; progressive or on-demand media within the bundle.
- Whether physical confirmations should carry optional free-text note (old had some) and whether that note is part of the synced fact.
- Auth at download vs. offline play of already-cached (05).
- If/when we ever want to relax "no re-val" for specific cases (e.g., critical security fixes) without breaking the frozen-attempt promise.
- Performance: log replay cost on every app load for long attempts; size of full event history over years.
- Cheating model: what (if any) additional client hardening or server heuristics are acceptable in v1 vs. post (given "deprioritized").

These must be resolved before implementation; they are *not* closed by this analysis.

---

## 9. How the Recommended Model Enables TDD, SOLID, DRY, KISS, YAGNI + Highest Readability/Maintainability

- **TDD:** The invariants are directly testable as properties (replay log → same state and same facts; sync idempotent and convergent; new attempt always latest; re-dl + replay reproduces historical claimed outcomes; coin ledger never negative without explicit correction events; etc.). Event sourcing makes "given this sequence of offline actions on this snapshot, when synced the server records X" a pure function easy to unit/property test. Sync can be tested with fake clocks, injected partitions, duplicate deliveries. Client bundle loading + local validation is a pure function of (snapshot bytes, input) → (is_correct, feedback).
- **SOLID:** Single-responsibility aggregates (Snapshot/Manifest owns the validation rules for attempts bound to it; Attempt owns its log and binding; StepCompletionFact is an immutable record; CoinReconciliation is its own concern). Open/closed via new event types or matcher versions in future snapshots without breaking old. Liskov etc. via the immutable value objects. Interface segregation: client only needs "validate against this local snapshot data"; server only needs "record these facts for this snapshot".
- **DRY:** Normalized step/answer versions (B') mean answer lists or step content are not duplicated on server. One event log serves local state, sync, recovery, audit, and coin calc. One set of facts serves recording, analytics per version, and replay. No dupe types like old page/page_constructor.
- **KISS:** Happy path is still "download the data for the version, play locally with immediate feedback, push your log on reconnect, get corrections if any". The extra machinery (logs, manifests, receipts) is isolated and justified by the deconstructed edges (not premature generality). Start with fat bundles + simple map + log for mutating actions only.
- **YAGNI:** We do not build two-phase, provisional, server-oracle, real-time geo enforcement, photo proof, branching, multi-language, external authors, or complex anti-cheat. We do not retain full old Bubble workflows or 47 types. We add only what is required to make the hard offline + frozen + no-reval rules robust and evolvable. Event log can be "just the final map" initially if log overhead proves unnecessary after measurement.
- **Readability & maintainability:** Crisp conceptual model with explicit invariants, provenance, and audit trail. Future developer (or the parallel synthesis) can read the invariants + this report + the log replay rules and understand exactly why a given completion has a particular is_correct for a particular version. No scattered 82 workflows or bag-of-flags. Changes to matching rules are versioned inside snapshots (old attempts unaffected). High test coverage via properties reduces regression fear.

---

## 10. Suggested Conceptual Test Cases / Property-Based Checks

(For the recommended hybrid; implementable in code once types exist; also useful as acceptance criteria.)

1. **Snapshot binding:** For any player with grant, `start_new_attempt(quest)` or `download_for_play(quest)` returns a snapshot S that is the current latest published manifest for quest at that instant; the created Attempt is bound to S forever.
2. **Frozen old:** After a publish creates S2 > S1, any existing attempts bound to S1 remain bound to S1; their local validation continues to use S1's answer data even if S2 has different answers.
3. **Replay determinism:** For any finite sequence of local events E1..En (answer submits with values, physical confirms, hint spends, gift accepts, resets) on a given snapshot S, replaying the sequence against S's data always produces the identical final completions map, is_correct claims (per the local rules at the time), revealed hints, and net coin delta.
4. **Sync idempotency & convergence:** Uploading the same log tail (or overlapping tails from two devices) any number of times, in any order, with any interleaving of network failures, results in exactly the same set of StepCompletionFacts and CoinLedger entries on the server (modulo correction events, which are also deterministic).
5. **New attempt latest:** After publish of S_new, the next `start_new_attempt` for any player binds to S_new (or later); it never binds to an older one.
6. **Re-dl + authoritative replay:** For any attempt A bound to S with a set of synced facts F, after clearing all client state, re-downloading S's bundle/manifest + pulling the authoritative log/events for A and replaying produces a local state whose derived completions/is_corrects/coins exactly match F (plus any corrections applied since).
7. **Coin non-negative with corrections:** After any sequence of spends and earnings across attempts/devices (offline or not), the master balance after reconciliation is >= 0; any negative window produces explicit correction events in the affected attempt's log rather than silent negative.
8. **Legacy import:** After importing a set of old answer_cards for quest Q (with their Complited/You_made_it/Count_wrong/Buy_hint), the resulting synthetic legacy snapshot(s) + facts have is_correct derived only from the historical flags (never re-computed against current content), and the attempt is marked with provenance "legacy-bubble-import".
9. **No re-val:** For any synced completion with submitted V and claimed is_correct C against snapshot S, even if a later publish S2 would make V "correct" or "incorrect" under S2's answers, the recorded is_correct for the original fact remains C (and analytics are queryable by S).
10. **Integrity:** Any bundle/manifest served for snapshot S has a verifiable hash/integrity value that the client checks on receipt and on load; corrupted data is rejected before local validation is attempted.
11. **Physical only confirmation:** For any step whose kind in the bound snapshot is physical/"questionnoanswer"/no-answer, the only way it appears completed in local state or server facts is via an explicit player_confirmed event/flag; there is never an acceptable_answers list or is_correct computation for it.
12. **Attempt independence:** Resetting or completing one attempt for (player, quest, S) has no effect on any other attempt for the same (player, quest) even if bound to the same S.
13. **Sync records submitted + outcome:** Every answer completion fact persisted on sync contains both the exact submitted string (or null) *and* the client's claimed is_correct for that snapshot's rules.
14. **Per-version analytics:** Wrong answers (and all submissions) are queryable grouped by the snapshot/version they were made against; mixing across versions is impossible in the data model.

Additional fuzz/property ideas: generate random quest snapshots + random valid/invalid answer sequences + random offline interleavings + random device partitions + random clears/re-dls; assert all invariants and replay equalities hold after "sync".

---

## 11. Conclusion & Next Steps for This Slice

This analysis attacked the Offline PWA Snapshot & Validation Model from every available angle (business locked docs, discovery of the old non-offline non-versioned answer_card + mutable page_constructor system, hard requirements, constraints, and self-generated alternatives). The locked v0.2 is a necessary simplification that satisfies the stakeholder mandate but is fragile on the edges that were deconstructed. The recommended hybrid (normalized manifests + event-sourced logs + salted protection + audit receipts + replay recovery) is the most robust, maintainable option that still obeys every constraint and improves on the baseline without scope creep.

**Short status:** ANALYZE-01 complete. Full adversarial cycle executed. Report produced.

**Path to report:** `business/analysis/offline-model-variants.md`

This slice is ready for cross-review against sibling ANALYZE-02 (versioning/publishing/snapshot retention), ANALYZE-05 (QuestAttempt/sync), ANALYZE-09 (migration), ANALYZE-04 (coins), etc., and for the main SYNTH-001 synthesis. Further iteration (more questions to stakeholder on the open items, concrete quest walk-throughs, or attacks on this report) is expected and welcomed — no model is final until it survives all scrutiny. 

---

*End of report. All paths absolute from workspace root. Code snippets / invariants / tests would live in the implementation phase after business stabilization.*