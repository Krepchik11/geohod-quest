# REVIEW: ANALYZE-05 progress-attempt-sync-variants.md (Chief Staff Engineer + Critical Analyst Cross-Review)

**Reviewer:** Grok Build subagent (Chief Staff Engineer + Critical Analyst).  
**Date:** 2026-06-09.  
**Scope:** Adversarial deconstruct/expose/rebuild/self-critique *of the report itself* + its recommendation (event-sourced + projection). Grounded strictly in: the full report + business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md (post-synthesis), business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md (v0.2), business/08_DECISIONS_LOG.md, business/04_CONTENT_MODEL..., FINAL-BEST-PRACTICE-BLUEPRINT.md, business/analysis/SYNTHESIS-NOTE-GAMESTEP-COINS-CONSTRUCTOR.md, business/analysis/gamestep-completion-variants.md, coins-economy-variants.md, constructor-authoring-variants.md, offline-model-variants.md, review-*.md (prior patterns), analysis/README.md (process), discovery/parsed/data_types.json (answer_card 9-field flag bag no submitted text; page_constructor.Gift_Coins + Page_type 14 vals incl questionnoanswer; user.Balance_coin + Getting_5...; quest.countCoinMadeIt), element_definitions.json (82 quest WFs + "steps_for_accruing_coins_" + Slide_* reusables), workflows + api_events (scattered mutations, no versions/offline), record_counts (21 quests, 556 steps). Extreme skepticism; no softening; all claims traceable to sources. No new files beyond mandated review. Short + ruthless + actionable.

---

## 1. Summary Agreement/Disagreement with Core Thesis and Rec

**Core thesis (report §1,22,329):** Current mutable QuestAttempt + StepCompletion upload + "last-write or union" (business/03:49,120 + 01 open Q) is a "thin optimistic sketch" directly colliding with business/06:98 ("Sync logic has races → lost progress or coin overspend"), 07:62 (multi-device merge open), 08 locked (client local no-reval + snapshot binding). Event sourcing (immutable AttemptEvent append + deterministic projection for QuestAttempt state) is the only variant that survives without heroic merge or double-spend/lost outcomes. CRDT YAGNI; pure server fights offline lock. Rec: hybrid event-sourced facts (AttemptEvent / CoinTransaction) + projected read model. Elevate to core of Play & Progress before code.

**Agreement (strong, grounded):** 
- Races deconstruction (§3: 4 main + additional) exactly matches locked risks (concurrent advance/coin spend on same attempt; reset concurrent with play; version drift + continue/re-dl; coin earn/spend interleaving + double-claim via old "Getting_5..." hack). Cross with coins (ANALYZE-04 races: overdraft, versioned gift drift, reset-after-earn, import inconsistency), offline (ANALYZE-01: multi-dev long-offline, retention for re-dl, plain client judge permanence, sync partials), GameStep (ANALYZE-03: completion kinds physical_confirmed vs answer_submitted with submitted + local_is_correct; gift claims on specific steps), constructor (ANALYZE-07: publish snapshots exact frozen rules/amounts/answers), synthesis/blueprint (events/facts over mutations; snapshot freeze; client local + server record facts + corrections). Report's Variant 1 exposure of "mutable overwrites lose causality", "attempt current position racy", "reset destructive clear", "idempotency assumed not designed", "multi-device same attempt identity problem", "no audit/replay" is precise and matches 03:120 ("last-write or union"), 01:180 open, 06 risk. Variant 2 handling of races (append all; reset event + epoch in fold; version carried per event; additive coin deltas with dedup) is correct and superior.
- Rec direction (events as source, projection for state, server durable append + projector, client local log + reproject) aligns with synthesis (elevate events), blueprint §6/10 (event-sourced progress + facts for coins/sync), prior reviews (events win for merge/audit/idempotency in coins/offline), locked "sync record+reconcile" (03:46-56). "No reval" respected (client local_is_correct carried as fact). "Replay" title + requirement satisfied literally. Better maintainability than V1 accreted merge (report §2.116, AN05 self-crit).
- Status assessment (report §367-378): Variant 1 is "the only described model" but "incomplete for the races"; high risk; requires updates to 01/03 before code. Correct.

**Disagreement (targeted, not wholesale):** 
- Overstates "event-sourced wins, only survivor" vs tensions with locked "no reval + client local truth" (08:7-17, 03:20: "server records... local... does not override"; report itself notes §227 "respected" but projection lag + client/server fold drift = effective re-val risk for UX/corrections). Event sourcing is robust but risks overkill for "linear 20-50 step quest" (report §221 self-crit "can be over-applied"; storage bloat for retries/wrongs/hints per attempt; projection lag on every load for "current step" view). CRDT dismissed as YAGNI correctly (report §261), but report under-weights that simple per-(attempt,step,version) LWW + union + explicit conflict note (with full log retained for audit) could suffice 99% for low-concurrency human play + "usually one device active" without full append-every-action machinery. Server-authoritative tension with full offline (report V4 §297) is real but event hybrid still creates "pending vs authoritative" for coins (03:90 "local spends applied"; corrections on next load) and progress (projection must match exactly or player sees drift across devices). Reset modeling left open (§349: epoch vs new attempt) — report leans "same attempt" for history but locked 01:158/03:104 "multiple attempts independent"; "reset only selected" favors new attempt id for cleanliness (avoids epoch in every projection). "Why event-sourced wins" section strong on races but weak on "storage for linear quests" (negligible per report but grows with wrong-answer retries + hints + multi-device logs; snapshot projections + prune needed). Overall thesis direction correct; "only" and "elevate immediately" slightly overstated for v1 internal team scale (21 quests).
- Blueprint/SYNTHESIS already converged on "progress/earnings are append-only facts/events" + "client local projection + server authoritative" (blueprint §16, §6; synthesis §57). Report's rec is confirmatory but not novel post-prior slices.

**Overall:** Report survives as high-quality adversarial output (full cycle, max docs, self-crit, grounded in 01/03/06/07/08 + discovery + legacy contrast). Core rec direction confirmed/adjusted (events + projection as core, but pragmatic hybrid with per-step LWW policy + explicit epoch/reset as new-attempt default + no full CRDT).

---

## 2. Specific Suggested Refinements

**Exact event schema (aligned with coins events from ANALYZE-04 V3 + GameStep completion kinds from ANALYZE-03 + locked 03/01/08):**
Use narrow append-only facts (not broad "events domain" per 06 cut; call CoinFact/AttemptFact or RewardFact/SpendFact/CompletionFact per coins review pattern; tie 1:1 where possible to StepCompletion for spends/gifts). Client generates offline with (device_id + local_monotonic_seq + attempt_id + client_ts + prev_hash optional for chain).

```ts
// Conceptual (server append-only table or log; client local log for pending)
type AttemptFact = {
  fact_id: string; // client-generated uuid or (player+device+local_seq) for offline
  quest_attempt_id: string;
  snapshot_id: string; // pinned version (locked binding)
  step_position: number; // or GameStep ref + snapshot step_version
  fact_type: 'physical_confirmed' | 'answer_submitted' | 'hint_purchased' | 'gift_claimed' | 'attempt_completed' | 'reset_requested' | 'step_advanced';
  payload: {
    submitted_value?: string; // answer_submitted (exact as typed; for analytics)
    local_is_correct?: boolean; // from client vs snapshot.completion (locked no-reval; always true for physical)
    coins_delta?: number; // signed; for hint/gift (cross-ref coins)
    note?: string; // optional for physical
    device_id: string;
    local_seq: number; // monotonic per device per attempt
    client_ts: string; // for display/approx order; primary order = server append + device+seq
  };
  server_received_at?: string;
  // For coins unification: fact_type 'hint_purchased'/'gift_claimed' also emits/links to CoinFact
};

// CoinFact (unify with AttemptFact or separate narrow ledger per coins rec + synthesis)
type CoinFact = {
  fact_id: string;
  player_id: string;
  attempt_id?: string; // attribution (per-attempt spends; global earns)
  quest_id: string;
  snapshot_id: string; // frozen amount source
  step_position?: number;
  fact_kind: 'GIFT' | 'COMPLETION_BONUS' | 'HINT_SPEND' | 'LEGACY_CREDIT' | 'CORRECTION';
  amount: number; // signed
  frozen_amount_source: number; // copy from snapshot GameStep.supporting.gift.coins or fixed bonus
  idempotency_key: string; // attempt_id + step_position + kind (+ snapshot for versioned)
  created_at: string;
};
```

- Projection for QuestAttempt (read model): fold facts in (fact_id, server append order, device+local_seq tiebreak) → {status, last_step, total_spent_this_attempt (sum |hint_purchased|), wrong_count (increment on answer_submitted where !local_is_correct), completed_steps set (latest per step by policy), ...}. Reset: see below.
- Server append: idempotent by fact_id (ignore dups on retry). Client: append locally, re-project, upload pending tail on sync; pull new, append to local log, re-project.
- Aligns: GameStep completion (ANALYZE-03: physical_confirmed always "correct"; answer_submitted carries submitted + local_is_correct from snapshot.completion.acceptable match); coins (ANALYZE-04 V3: facts on StepCompletion record using snapshot amounts; per-attempt spends; global projection); locked 03:46-52 payload (enrich with fact_id/seq); 01:150 CoinTransaction ER; synthesis "events as accounting primitive".

**Reset modeling:** Prefer "reset as new attempt" (locked 01:158 "multiple attempts are independent"; 03:104/107 "reset clears... the attempt record and grant survive"; report §349 notes latter cleaner). On reset: client marks current attempt Abandoned/Reset (or append 'reset_requested' fact with epoch), creates *new* QuestAttempt bound to *same* snapshot (or latest if policy), copies grant. History preserved on old attempt id (full facts for replay/audit). "Continue" only on non-reset InProgress. Alternative (if "same attempt replay" desired): append 'reset_requested' + epoch counter; current projection ignores pre-latest-reset facts (history in log for "what did I do before reset?"). Document choice; "reset only selected" (01:5) favors new id to avoid polluting one aggregate. Cross offline: local clear + new local attempt; sync appends reset fact + new facts.

**Projection policies per step type (from GameStep ANALYZE-03 + refined shape in 01 post-synth):** 
- Per (attempt, step_position, snapshot): for current view, LWW by (client_ts + device lexical + local_seq) for 'answer_submitted'/'physical_confirmed' (report §209; keep all in log for analytics). Multi-value only if policy (flag conflict for player/author review on next continue). Gift/terminal: emit once (idemp via key including snapshot/step). Hint: once per step (unique on attempt+step). Wrong count: aggregate from all answer_submitted !local_is_correct in log (or per-step latest). "Current step": max position with completion fact (post-reset epoch). Deterministic fold must be *identical* client/server (golden tests from real quests per coins/offline recs). Version: only fold facts matching attempt's pinned snapshot.

**Coin events cross-ref (ANALYZE-04 V3 + blueprint §2):** Unify AttemptFact 'hint_purchased'/'gift_claimed' with CoinFact (or emit linked CoinFact on authoritative StepCompletion record). Per-attempt spends 1:1 with StepCompletion.coins_spent_on_hint; earnings global projection but attributed. First-only bonus/gifts: unique on (player, quest, 'COMPLETION_BONUS' or step) or existence check before emit (not per-attempt to prevent farming). Snapshot-frozen amount in fact (from bound GameStep.supporting.gift at publish via constructor). Offline: client projects from snapshot gift/hint defs + local facts; server authoritative on sync + corrections (03:90,112). Matches synthesis: "earnings emitted on StepCompletion record (using bound snapshot's gift amounts)"; "per-attempt spends on StepCompletion; earnings global projection with per-quest first-only".

**Multi-device "same attempt" identity solution:** Explicit attempt_id (server-generated or client-proposed with server dedup on (player, quest, snapshot) + first-fact). On first local action or download: client requests/creates QuestAttempt id (bound to snapshot at creation time per 01:4). Devices share via server "my in-progress attempts" list (per snapshot). Local-first creation risks dups (report §179); server assigns canonical id on first sync fact, clients adopt. "Same logical playthrough" vs independent: policy on list (player sees "in-progress on vN" as one; reset creates new). Vector or (device+seq) for merge ordering. Cross offline: re-dl snapshot + pull facts for that attempt_id.

**Version drift handling with historical snapshots (from offline ANALYZE-01 + AN02):** Attempt always carries snapshot_id (immutable bind at start/download per 01:158,03:61). Events/facts carry it too. On continue/re-dl (cleared device): server returns attempt + its snapshot_id; client requests exact historical manifest/bundle (retention policy: keep all with >=1 in-progress/recent attempt; AN02 locked indefinite for active). If not retained: degrade to "view server facts only" (submitted values + claimed local_is_correct preserved; no new local validation/offline play). New events post-drift rejected or force new attempt. Projection filters to matching snapshot. Cross constructor: publish snapshots exact frozen GameStep (incl completion data + supporting amounts) for that version.

**Other:** Idempotency trivial via fact_id. Ordering: server append + (device_id + local_seq) tiebreak (client_ts display only; clock skew from long offline). Projection lag: client shows "sync pending" + last known projected; corrections via pull + replay (03: "local state corrected on next load"). Storage: facts + snapshot projections (prune old facts after projection snapshot if replay not needed; retain for audit/replay per title). CRDT: reject pure (YAGNI per report).

---

## 3. Updated Edge/Race Handling Matrix (Incorporating Cross-Slice Races)

| Edge/Race (from report §3 + cross) | Report V1 (mutable) | Report V2 (event+proj) | Cross-Slice Impact + Refined Handling (this review) |
|------------------------------------|---------------------|------------------------|-----------------------------------------------------|
| Dual-device advance same attempt + coin spend (report Race1; coins AN04 multi-dev spend; offline AN01 72; gamestep gift claims) | High (last-write/ambiguous union; overdraft allowed; lost submission detail) | Low (append all; sum deltas exactly; policy on fold per step) | Coin overdraft + GameStep gift claims: facts union by (attempt,step,snapshot); gift earn idemp via (attempt+step+'GIFT'+snapshot); spend per StepCompletion 1:1. Physical confirm + navigator (client req if known, e.g. geo display only): 'physical_confirmed' fact with note; no proof; timestamp for audit. Projection sums per-attempt spends; global coin proj authoritative on sync. Correction event if overdraft detected (un-reveal if policy). |
| Reset concurrent with play (report Race2; 03:107 "clear locally"; 01 "independent") | High (destructive clear races; reset lost or defeated) | Low (reset event + epoch in fold; history preserved) | Reset as new attempt (preferred): old attempt facts frozen (replayable); new attempt id gets fresh facts on same snapshot. Or epoch: current proj ignores pre-reset. Offline: local clear + new local attempt; sync appends reset fact. Cross coins: banked rewards (prior facts) survive; new attempt can earn only per policy (gifts? no on replay for same snapshot). |
| Version drift + continue/re-dl (report Race3; offline 64,122 "historical snapshots"; 01:4 "old frozen") | High (retention fragile; mixed versions on same attempt id) | Low (events carry version; history survives; only v-matching facts fold) | Historical snapshots mandatory (AN02/01): re-dl exact for in-progress old (manifest + content-addressable or fat). Drift on same attempt: reject new facts or force new attempt. Projection: filter facts by attempt's snapshot_id. Constructor publish: new snapshot id with frozen GameStep (completion + supporting.gift/hint amounts). |
| Coin earn/spend interleaving + double-claim (report Race4 + subcases; coins 134,168 "Getting_5" dedup; gamestep terminal/gift) | High (optimistic local; post-correction; no dedup guard) | Medium (additive + dedup by key; overdraft correction event) | Gift claims on GameStep steps (AN03/04): emit on authoritative StepCompletion for step with supporting.gift (amount from *that* snapshot). Completion bonus: unique (player,quest,'COMPLETION_BONUS'). Per-attempt vs global: spends per-attempt (StepCompletion + QuestAttempt.total); earns global proj (attributed via attempt). Offline long-play: local project from bundle snapshot amounts; server uses same on record. Import: LEGACY_CREDIT fact only (no backfill from opaque old WFs). |
| Additional (report §175-182 + cross): physical + coin cross; multi-attempt reset re-earn; attempt creation race; post-complete activity; idemp retry; clock skew | Mixed (destructive or lost) | Strong (append + policy + keys) | Physical confirm + navigator/geo (if client req known from offline): fact carries note + ts; no is_correct beyond confirm (AN03). Multi-attempt: independent; reset only selected (new id or epoch). Creation: server canonical id on first fact. Post-complete: ignore or flag. Idemp: fact_id. Skew: seq primary. |
| Cross-slice specific (coin overdraft + gift claims; physical with client navigator): | N/A (pre-cross) | Good base | Unified facts (AttemptFact + CoinFact link); projection policies per gamestep kinds (AN03: physical always correct on confirm; answer carries submitted + local_is_correct); offline fidelity requires exact client fold match server (golden from real quests). |

Matrix summary: V2 base survives; refinements (new-attempt reset default, per-step LWW + full log, unified coin/attempt facts with snapshot keys, mandatory retention + exact historical re-dl) close remaining gaps from cross (AN01 retention/multi-dev, AN04 versioned gifts/import, AN03 completion kinds + gift timing, 03/01 locked).

---

## 4. How This Affects Constructor, Offline, Coins, GameStep + Main Synthesis Confirmation/Adjustment

**Constructor (ANALYZE-07 + 04 + blueprint §3):** No events logged *from authoring* (authoring produces content snapshot, not play facts; per "no" in task). But authoring *must support* step types/data that generate these events on play: GameStep completion {mode, acceptable?, allow_note?} (physical_confirmed vs answer_submitted with submitted + local_is_correct facts); supporting.gift {coins, narrative} (gift_claimed fact on completion record, amount frozen); hint {cost} (hint_purchased fact). Publish: serialize exact shape (answers list from structured editor or paste helper; gift coins number per step); snapshot id/version for binding. Pre-publish gates: catch physical+acceptable, 0 answers, etc. (strengthened per review-constructor). "Test in real player" exercises real attempt/fact emission/coin events. Old mapping: page_constructor Page_type + Answers + Gift_Coins → completion.mode + acceptable + supporting.gift. Maintain small readable code (no god; typed drafts → snapshot). Bundle gen: direct from publish state (plain acceptable for answer steps per locked).

**Offline (ANALYZE-01 + 03 locked):** Local event log + projection *must match server exactly* for offline fidelity (client appends on every action, re-projects for UI/"can buy?"; on sync uploads pending tail + pulls/replays authoritative; corrections as facts appended to local log forcing replay). Bundle includes snapshot GameStep data (completion + supporting amounts frozen) for local projection of earns/spends + validation. Retention: historical snapshots/manifests for re-dl of old attempts (exact for frozen rules). Sync: record+reconcile via facts (enrich 03:47 payload with fact_id/seq/device); no re-val (local_is_correct carried). Multi-device: log merge (seq+device). Quota: evict bundles for completed; replay from server facts + re-dl snapshot for old in-progress. Matches locked "client fully validates... no server re-val... local spends applied... corrections on next load".

**Coins (ANALYZE-04 + blueprint §2):** Unify AttemptFact (hint_purchased/gift_claimed) with CoinTransaction/CoinFact events (or emit linked on StepCompletion record). Per-attempt spends: 1:1 on StepCompletion (coins_spent_on_hint + revealed); total on QuestAttempt. Earnings: global projection (sum facts); first-only dedup via unique (player,quest,kind) or existence. Snapshot-frozen: amount in fact from bound GameStep (constructor enters; publish snapshots). Offline: local project from bundle snapshot defs + local facts; server authoritative + corrections. Reset: banked facts survive; new attempt per policy. Import: synthesize facts (legacy_credit only; audit deltas vs old Balance; no auto-adjust). Matches synthesis "immutable step-reward events projected"; "per-attempt spends; global proj with per-quest first-only". No scalar mutation ever.

**GameStep (ANALYZE-03 + 01 post-synth):** Events for each completion kind (refined shape): 'physical_confirmed' (payload: note?, always local_is_correct=true); 'answer_submitted' (submitted_value, local_is_correct from client match vs snapshot.completion.acceptable). Gift/hint/terminal as supporting → 'gift_claimed'/'hint_purchased' on qualifying completion record (amount from snapshot supporting). Projection policies: LWW per step for current view; all facts retained for audit/replay per version. "Exactly one primary" + supporting validated at authoring (constructor gates). Rich content primary differentiator (addresses "no difference" physicals). Versioned in snapshot at publish. Migration: old Page_type (questionnoanswer→physical_confirmed path; question*→answer_submitted) + Answers + Gift_Coins → completion data + supporting.

**Confirmation or adjustment for main synthesis (elevate events; update invariants in 01/03):** 
- **Confirm + elevate:** Events/facts as core of Play & Progress context (per blueprint §16 "progress/earnings are append-only facts/events"; synthesis "elevate to core"; report thesis). QuestAttempt/StepCompletion become *projections* (read models) of the fact log (not mutable source). Sync = append facts + reconcile (record+reconcile). This unifies coins (CoinFact), progress (AttemptFact), GameStep completions (per kind). Makes "replay" (title), idempotent merge, audit, versioned analytics, correction protocol first-class. Cross all slices converge here.
- **Adjustments to invariants (update 01 + 03 + 08):** 
  - Add: "All play progress and coin movements are immutable facts (AttemptFact / CoinFact) append-only per (attempt, snapshot). QuestAttempt and player balance are deterministic projections/folds of facts. No direct mutation of aggregates for progress/coins."
  - "Client local validation outcome (local_is_correct, player_confirmed) is recorded as fact; server never overrides for player outcome on that snapshot (records submitted + claim)."
  - "Snapshot binding: every fact and projection carries/ filters by attempt's pinned snapshot_id. Historical snapshots retained for active attempts (re-dl exact)."
  - "Reset: affects only selected attempt (clear its facts for current projection; either new attempt id or explicit reset epoch in fold; banked rewards survive)."
  - "Multi-device same attempt: canonical attempt_id assigned; facts union by id + (device+seq); projection deterministic."
  - "Per-attempt coins: spends tracked per attempt (on its facts/StepCompletion proj); earnings global projection with dedup (player+quest+kind). All from snapshot-frozen GameStep supporting at publish time."
  - "Sync: idempotent append of facts (keyed); client pulls and re-projects; corrections emitted as facts."
  - "Projection policies: per-step LWW for current view (policy explicit, e.g. latest ts+device); all facts for audit/replay/analytics per version."
- Update 03 sync section: replace "uploads StepCompletions... clear" with "appends local pending facts (idemp by fact_id); server merges log; client pulls + re-projects." 01: add AttemptFact/CoinFact aggregates; refine QuestAttempt as projection.
- Blueprint/SYNTHESIS: already directionally aligned ("events over mutations"); this hardens with exact schema, reset policy, per-kind events, cross-matrix, invariant text. No contradiction; elevates as requested.

This review confirms the report's direction while providing the actionable schema/policy/matrix/impacts to lock before code (per report §369-375 path).

---

## Self-Critique of This Review

- **Strengths:** Applied full cycle to *the report* (deconstruct its races/deconstruct for missed cross like long-offline versioned gifts + physical+coin + import inconsistencies from AN01/04/09 + discovery flag-bag no-submitted; expose tensions with locked "no reval/client truth" + overkill/YAGNI + reset ambiguity + projection lag even while confirming V2 wins; rebuild concrete 5th refinements + schema + policies strictly respecting *all* locked snapshot binding/client local no-reval/per-attempt coins/multiple attempts/reset-only-selected/offline-full/sync-record+reconcile + cross from prior slices; updated matrix with explicit cross examples; affects sections with constructor/offline/coins/gamestep mappings; synthesis confirmation + exact invariant text for 01/03). Grounded absolutely (every bullet paths to report lines + 01/03/08 text + discovery fields/WF counts + prior reviews/synthesis/blueprint). Concise + actionable (schema, policies, matrix, updates). Matches prior review patterns (review-gamestep/review-coins structure: missed in deconstruct, flaws in variants, rebuild refinements, cross, synthesis rec, self-crit, status+path). Extreme skepticism (attacked "only survivor", "elevate immediately", storage for linear, CRDT YAGNI consistency, server tension with offline, reset modeling). No broadening.
- **Weaknesses:** As single-pass review (parallel to report), relies on read/grep of sources without re-exporting raw 556 steps (impossible from parsed; probes 404 per discovery + reports note this; "Mystery of the Fortress" only concrete physical). "Long-play" + "navigator from client req" extrapolated (real for PWA location quests per 03/00 but unmeasured usage). Schema is conceptual (not executable); exact DB/log choice (table vs event store) deferred. Reset policy recommendation (new attempt default) is strong opinion grounded in "independent" language but stakeholder could choose epoch. No new tool runs for code (none exists pre-impl); all pre-code analysis. Over-indexed on robustness (small team/21 quests may tolerate lighter LWW+union + scalar+tx for coins if events prove heavy post-measure; report self-crit "if scale tiny... simpler could suffice" applies). Process fidelity high but "5th hybrid" is refinement on report's V2, not pure invention.
- **Process:** Tool-assisted (prior list_dir/reads/greps on all mandated + cross; this pass targeted greps for "event|Attempt|reset|projection|sync" + full re-reads of key sections). Stayed in workspace boundary. Output per task (concise review report to exact path with required bullets + cycle applied + self-crit + status+path). Feeds main synthesis (elevate events; update 01/03 invariants).

---

**Status:** COMPLETE. (Report's ANALYZE-05 survives with refinements; core thesis direction confirmed; actionable schema + matrix + impacts + invariant text provided for lock in 08 + propagate to 01/03 + blueprint. Parallel review per analysis/README + task.)

**Path forward (from report §369 + this + cross):** 
1. Main thread + stakeholder review this + report; decide reset (new attempt vs epoch), projection policies (LWW explicit), exact fact schema framing ("CoinFact ledger" narrow). 
2. Lock in business/08_DECISIONS_LOG.md (expand with event core + invariants + cross refs). 
3. Update business/01 (add AttemptFact/CoinFact aggregates + projection language + refined invariants) + business/03 (rewrite sync to facts append + reproject; add retention policy + local log contract). 
4. Propagate to blueprint (elevate Play & Progress events) + SYNTH-001. 
5. Draft sequence diagrams for top races (concurrent advance+coin; reset; version drift re-dl) using chosen model. 
6. Only then: detailed design (aggregates, sync API with fact payloads, client IndexedDB log+projector, TDD tests for idemp/fold/merge using golden real quests). 
7. Dependencies: AN02 (historical snapshot retention/manifests), AN04 (coin facts unification), AN03 (per-kind events), AN01 (local log fidelity + bundle shape), AN07 (constructor emits supporting for facts), AN09 (import synthesizes facts from old cards).

**Risk if ignored:** Ship mutable + union (report V1), real players lose progress/see coin weirdness on multi-device/offline (06:98 failure mode), "replay" is checkbox only, recreate scattered imperative sync (old 82 WFs + answer_card bag). Events + projection is the least-bad that respects locked while hardening the highest-risk area (03 "highest-risk").

All claims directly traceable to workspace sources. The report's work was solid; this tightens for implementation without invalidating its cycle or deconstruct. Ready for decision.