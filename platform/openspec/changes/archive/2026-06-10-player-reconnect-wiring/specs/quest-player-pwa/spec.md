# quest-player-pwa

## Purpose

The offline-first PWA quest player experience (from quest-player-pwa change). Renders the linear sequence of 4 primary GameStep templates (first_screen, task_no_answer, task_with_answer, continue) from frozen QuestSnapshots (loaded via ?golden= or future serialized bundles). Delivers uniform physical confirmation (w/ optional note), answer tasks using exact shared isAnswerCorrect against snapshot's acceptable, hints available *ONLY* via immediate wrong-answer popup (spend coins to append hint_purchased + reveal), navigator button ONLY on physical-ish steps when supporting.navigator present (opens geo + appends fact), global "Оставить отзыв" affordance on every step/page (appends feedback_reported w/ step_position context), append-only local facts using exact shared Fact shape + deterministic re-projection (projectBalance, projectState) that MUST exactly match goldens (e.g. happy-with-gift path using real synonym "МИХАЙЛО ПУПИН", gift_claimed +5 at step 2, final bal=5, no lost/double), localStorage persist keyed by golden for reload/resume with identical state/projection, terminal step appends attempt_completed + bonus, offline indicator + sim disconnect/sync (local-only, banner, no real net calls in sim mode). Implemented via 10 small focused components (RSC shell + 'use client' only for state, no barrels, 100% import shared-model no dupes), YAGNI (local facts + goldens for fidelity proof; shapes ready for future backend sync). Proves the ctor's "Save + open in real player as test user", client-authoritative offline contract, and PLAN Phase 3 player PWA slice. (Purpose derived from proposal "New Capabilities" section + delta spec's 9 reqs; created agent-driven via openspec-sync-specs logic during archive of quest-player-pwa.)

## ADDED Requirements

### Requirement: Real reconnect uploads pending facts and applies server corrections + authoritative projection
The player SHALL support real (non-sim) reconnect: when !simOffline and "simulate sync" clicked (or equivalent), collect current local facts (the append-only log), POST them as batch {facts: Fact[], snapshot_id: goldenId} to /api/attempts/{attemptId}/facts (attemptId demo-derived and consistent for the golden), then on success append any response.corrections (normalized to shared Fact shape) to the local facts log, re-project via imported projectBalance/projectState, persist via LS, and update UI (balance, revealed, banner). The authoritative projected from response SHALL be consistent with re-projection after apply. This enables "on reconnect" per PLAN without losing local actions.

#### Scenario: Happy reconnect with no new server facts applies 0 corrections and preserves projection
- **WHEN** player completes happy-with-gift actions (physical 0, "МИХАЙЛО ПУПИН" answer at 1, reach gift at 2, terminal at 3) producing exact expected_facts + bal=5 locally, enables no sim, triggers sync (facts sent to live endpoint for demo attempt)
- **THEN** response.accepted may be 0 or 4 (idemp), corrections=[], projected.balance===5 and completed match golden; local facts unchanged in count (or +0), re-project still bal=5, banner clears to synced state, LS roundtrips the same facts post-sync.

#### Scenario: Overdraft correction from stale local is applied, re-projection converges to authoritative
- **WHEN** (simulating multi-device): local has stale facts with bal=5, player offline does hint_purchased (overdraft), then reconnects and syncs the batch; server has prior facts making authoritative lower bal, emits balance_corrected corr in response
- **THEN** local appends the correction fact (with +delta), re-project gives authoritative bal (no negative), banner shows "balance corrected" or similar, goldens-driven replay with injected corr asserts final project authoritative + LS post-apply matches.

### Requirement: Error on reconnect keeps all local facts authoritative (no loss) and surfaces status
On network error, timeout, or non-2xx during real sync POST, the player SHALL keep the entire local facts log and current projection unchanged (client remains authoritative), set error state in banner ("sync failed, still offline"), and allow continued play + future reconnect attempts. No facts are dropped.

#### Scenario: Network failure during sync of pending facts
- **WHEN** player has pending facts (e.g. 4 from happy), !simOffline, clicks sync, but backend unreachable or returns error
- **THEN** facts array length and content identical pre/post, projectBalance still 5, UI allows further appends (e.g. more feedback), banner indicates error + "local authoritative", next successful reconnect can send the accumulated log (idemp safe).

### Requirement: Simulate toggle and "simulate sync" still fully functional as offline force
The "simulate disconnect" checkbox and "simulate sync" button SHALL continue to work exactly as before when simOffline=true (force local-only, no real POST even if clicked, show sim message). Real sync path is only taken when !simOffline. Toggle can be used mid-play or post-reconnect.

#### Scenario: Force offline via toggle, play, attempt sync (stays sim), disable and do real reconnect
- **WHEN** simOffline enabled, play several steps + gift, click "simulate sync" (no net), then disable toggle, click sync (now real)
- **THEN** during sim no fetch occurs, banner "Offline — local only", facts persist in LS, on disable + real sync the pending (incl prior) are uploaded, corrections (if any) applied, projection authoritative, sim path never did real calls.

### Requirement: Goldens fidelity and replay contract preserved after reconnect + corrections
All reconnect paths (real or via replay harness) SHALL produce final facts + projections that match goldens (happy-with-gift exact including gift timing/synonym + bal=5) or injected corr scenarios from facts-sync spec. The replay test SHALL cover "offline pending -> reconnect apply -> authoritative final" + LS roundtrip post-sync for happy + edges + overdraft corr. Existing replay paths (no sync) remain green.

#### Scenario: Replay test extended covers reconnect corr apply + goldens match post-sync
- **WHEN** replay harness builds happy facts from golden actions (exact match pre-sync), simulates reconnect by applying mock response with 0 or 1+ corrections (e.g. balance_corrected from overdraft), re-projects, serializes to LS json, restores + re-projects
- **THEN** facts include any corrs, projectBalance/projectState match the authoritative projected from mock (or golden if 0 corrs), LS roundtrip identical, no lost original facts, all prior asserts (incl "МИХАЙЛО ПУПИН" +5) still pass.

### Requirement: attemptId for reconnect is consistent per golden (demo) and roundtrips LS
The player SHALL use (and persist in LS with facts/stepIdx) a stable attemptId per golden (e.g. `demo-${goldenId}`) for the /facts POST target. This allows repeated reconnects and "Save + open in real player" from ctor to target the same logical attempt for idempotent/correction testing. Reloads resume the same attemptId.

#### Scenario: Reload mid-quest then reconnect uses same attemptId
- **WHEN** play to step 1 (facts in LS + attemptId), reload, continue play + facts append, trigger real reconnect
- **THEN** the POST uses the resumed attemptId (not regenerated), server sees prior facts for dedup, corrections (if any) applied to the resumed log, projection correct.

## MODIFIED Requirements

### Requirement: Local append-only facts + deterministic re-projection exactly matches goldens (incl. gifts, balance, revealed)
All player actions SHALL append immutable facts using the exact shared Fact shape and types (physical_confirmed, answer_submitted, gift_claimed, hint_purchased, attempt_completed, feedback_reported, ...). Gifts from supporting.gift SHALL be auto-claimed (append gift_claimed with frozen coins_delta) when the step is reached/after prior completion if not already claimed. On any append, the player SHALL re-project via imported projectBalance(facts) and projectState(facts) from shared-model. The resulting facts and projections for the happy-with-gift replay (or equivalent actions on mystery snapshot) SHALL exactly equal the golden's expected_facts, expected_final_balance, and revealed state. Local facts SHALL persist to localStorage (keyed by golden/snapshot) and restore on reload to resume at last step with identical projection. Real reconnect (when !simOffline) SHALL upload current facts, apply returned corrections (if any) to the log, re-project, and persist; the final projection after apply SHALL match the server's authoritative projected (or golden when no corrs).

#### Scenario: Replay happy-with-gift actions (incl. real synonym + gift at 2) produces exact match
- **WHEN** player (or replay test) performs actions equivalent to happy-with-gift (physical 0 with note, submit "МИХАЙЛО ПУПИН" on 1, reach/claim gift on 2, physical 3) against the mystery snapshot
- **THEN** emitted facts exactly match the golden's expected_facts array (incl. gift_claimed at position 2 with +5, answer_submitted with real value, attempt_completed at 3, no hint facts); projectBalance(facts) === 5; projectState matches completed/revealed; after reload from LS the state and balance are identical with no lost/double facts.

#### Scenario: Wrong answers + hint spend + feedback do not break projection fidelity
- **WHEN** player submits wrong on an answer step, spends on hint popup (append hint_purchased neg delta), appends feedback mid, then completes with gift
- **THEN** final projected balance accounts for all deltas (gifts positive, hint negative) exactly; revealedHints includes the spent step; no overdraft; facts log is append-only and re-projection on reload matches.

#### Scenario: Post-reconnect with corrections still yields goldens fidelity + authoritative projection
- **WHEN** happy facts built, reconnect returns corrections (e.g. balance_corrected + delta from overdraft scenario in facts-sync spec)
- **THEN** corrs appended (normalized), project after apply matches the projected.balance from response, goldens happy subset still present and correct, LS post-sync roundtrip preserves full log incl corrs.

### Requirement: Offline indicator, simulate disconnect, and local-only persistence for replay
The player SHALL display an offline/pending banner when in simulated-offline mode or when local facts exist (or during/after real sync with pending). A "simulate disconnect" toggle SHALL prevent real sync and force local-only. "Simulate sync" (when not disconnected) SHALL perform real reconnect (POST pending facts batch, apply corrections if returned, re-project to authoritative, update banner) or fall back to sim message if simOffline. All state (facts, current step, attemptId for demo) SHALL survive full page reload via localStorage and produce identical projection/behavior post-reload. Real network is used only for reconnect when !simOffline; sim mode never performs fetches.

#### Scenario: Play offline, reload, simulate reconnect
- **WHEN** player plays several steps (incl. gift claim + wrong+spend), enables simulate disconnect, reloads the page, then disables disconnect and triggers "simulate sync"
- **THEN** on reload the exact step, facts, balance, and revealed state are restored from LS and projections match pre-reload; banner indicates offline during sim; sync sim shows message but does not alter local facts or require backend; full flow remains playable end-to-end with no server dependency.

#### Scenario: Real reconnect after offline play clears pending and applies authoritative state
- **WHEN** player plays with facts pending, !simOffline, triggers reconnect (real POST), server returns accepted + possible corrections + projected
- **THEN** local facts updated only with corrections (no dups), banner updates to synced/corrected, UI balance/revealed match authoritative projected, LS now contains post-sync state, continued play or re-reconnect is idempotent.

(These deltas + added reconnect reqs/scenarios are directly testable via extended player-replay.test.ts (goldens + mock apply), frontend build/lint, and manual "Save + open in real player as test user" exercising offline toggle + sync against live backend contract. They map 1:1 to the wiring design, proposal, archived facts-sync contract, PLAN Phase 3, and current implementation while remaining implementation-free. Existing non-offline reqs unchanged.)
