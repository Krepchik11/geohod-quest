# quest-player-pwa

## Purpose
The offline-first PWA quest player experience (from quest-player-pwa change). Renders the linear sequence of 4 primary GameStep templates (first_screen, task_no_answer, task_with_answer, continue) from frozen QuestSnapshots (loaded via ?golden= or future serialized bundles). Delivers uniform physical confirmation (w/ optional note), answer tasks using exact shared isAnswerCorrect against snapshot's acceptable, hints available *ONLY* via immediate wrong-answer popup (spend coins to append hint_purchased + reveal), navigator button ONLY on physical-ish steps when supporting.navigator present (opens geo + appends fact), global "Оставить отзыв" affordance on every step/page (appends feedback_reported w/ step_position context), append-only local facts using exact shared Fact shape + deterministic re-projection (projectBalance, projectState) that MUST exactly match goldens (e.g. happy-with-gift path using real synonym "МИХАЙЛО ПУПИН", gift_claimed +5 at step 2, final bal=5, no lost/double), localStorage persist keyed by golden for reload/resume with identical state/projection, terminal step appends attempt_completed + bonus, offline indicator + sim disconnect/sync (local-only, banner, no real net calls in sim mode). Implemented via 10 small focused components (RSC shell + 'use client' only for state, no barrels, 100% import shared-model no dupes), YAGNI (local facts + goldens for fidelity proof; shapes ready for future backend sync). Proves the ctor's "Save + open in real player as test user", client-authoritative offline contract, and PLAN Phase 3 player PWA slice. (Purpose derived from proposal "New Capabilities" section + delta spec's 9 reqs; created agent-driven via openspec-sync-specs logic during archive of quest-player-pwa.)

(Existing purpose unchanged; this delta adds grant eligibility requirements additively.)

## ADDED Requirements
(unchanged from prior; see archived or synced openspec/specs/quest-player-pwa/spec.md for full prior ADDED around reconnect, offline, goldens fidelity, etc.)

## MODIFIED Requirements

### Requirement: Local append-only facts + deterministic re-projection exactly matches goldens (incl. gifts, balance, revealed)
All player actions SHALL append immutable facts using the exact shared Fact shape and types (physical_confirmed, answer_submitted, gift_claimed, hint_purchased, attempt_completed, feedback_reported, ...). Gifts from supporting.gift SHALL be auto-claimed (append gift_claimed with frozen coins_delta) when the step is reached/after prior completion if not already claimed. On any append, the player SHALL re-project via imported projectBalance(facts) and projectState(facts) from shared-model. The resulting facts and projections for the happy-with-gift replay (or equivalent actions on mystery snapshot) SHALL exactly equal the golden's expected_facts, expected_final_balance, and revealed state. Local facts SHALL persist to localStorage (keyed by golden/snapshot) and restore on reload to resume at last step with identical projection. Real reconnect (when !simOffline) SHALL upload current facts, apply returned corrections (if any) to the log, re-project, and persist; the final projection after apply SHALL match the server's authoritative projected (or golden when no corrs). Attempt creation/eligibility and first fact append for a quest SHALL require a valid lifetime AccessGrant for that quest (or free quest flag); "owned" status MAY be surfaced from grants for replay/resume; eligibility checks SHALL reuse snapshots for version binding and facts for post-grant usage/attempts (additive; no change to existing fact shapes, projectors, or golden fidelity).

#### Scenario: Replay happy-with-gift actions (incl. real synonym + gift at 2) produces exact match
- **WHEN** player (or replay test) performs actions equivalent to happy-with-gift (physical 0 with note, submit "МИХАЙЛО ПУПИН" on 1, reach/claim gift on 2, physical 3) against the mystery snapshot
- **THEN** emitted facts exactly match the golden's expected_facts array (incl. gift_claimed at position 2 with +5, answer_submitted with real value, attempt_completed at 3, no hint facts); projectBalance(facts) === 5; projectState matches completed/revealed; after reload from LS the state and balance are identical with no lost/double facts.

#### Scenario: Wrong answers + hint spend + feedback do not break projection fidelity
- **WHEN** player submits wrong on an answer step, spends on hint popup (append hint_purchased neg delta), appends feedback mid, then completes with gift
- **THEN** final projected balance accounts for all deltas (gifts positive, hint negative) exactly; revealedHints includes the spent step; no overdraft; facts log is append-only and re-projection on reload matches.

#### Scenario: Post-reconnect with corrections still yields goldens fidelity + authoritative projection
- **WHEN** happy facts built, reconnect returns corrections (e.g. balance_corrected + delta from overdraft scenario in facts-sync spec)
- **THEN** corrs appended (normalized), project after apply matches the projected.balance from response, goldens happy subset still present and correct, LS post-sync roundtrip preserves full log incl corrs.

#### Scenario: Post-grant attempt on published snapshot (after marketplace buy) produces goldens facts + eligibility passes
- **WHEN** grant created (via marketplace checkout/coupon/free) for the quest/snapshot, player opens player for that golden (or from owned link), performs happy-with-gift actions
- **THEN** eligibility check passes (grant or free flag present); emitted facts exactly match golden expected (incl "МИХАЙЛО ПУПИН" + gift +5); projectBalance=5; reconnect/corrections/LS unchanged; no grant required for prior non-commerce goldens in demo (additive).

#### Scenario: No grant on non-free quest blocks eligibility (warning or gate) while free/paid-with-grant identical
- **WHEN** player loads /quest for non-free quest with no prior grant (no marketplace buy), or grant check fails
- **THEN** eligibility false (banner "Access required - visit marketplace" or first append/advance blocked); free quest (source FreeQuest grant or flag) or paid-with-grant allows full identical flow (facts emission, projections, popup, navigator, reconnect, goldens match).

### Requirement: Offline indicator, simulate disconnect, and local-only persistence for replay
The player SHALL display an offline/pending banner when in simulated-offline mode or when local facts exist (or during/after real sync with pending). A "simulate disconnect" toggle SHALL prevent real sync and force local-only. "Simulate sync" (when not disconnected) SHALL perform real reconnect (POST pending facts batch, apply corrections if returned, re-project to authoritative, update banner) or fall back to sim message if simOffline. All state (facts, current step, attemptId for demo) SHALL survive full page reload via localStorage and produce identical projection/behavior post-reload. Real network is used only for reconnect when !simOffline; sim mode never performs fetches. (Eligibility gate additive: offline play still requires prior grant for the quest in non-sim; sim toggle preserves for testing.)

#### Scenario: Play offline, reload, simulate reconnect
- **WHEN** player plays several steps (incl. gift claim + wrong+spend), enables simulate disconnect, reloads the page, then disables disconnect and triggers "simulate sync"
- **THEN** on reload the exact step, facts, balance, and revealed state are restored from LS and projections match pre-reload; banner indicates offline during sim; sync sim shows message but does not alter local facts or require backend; full flow remains playable end-to-end with no server dependency.

#### Scenario: Real reconnect after offline play clears pending and applies authoritative state
- **WHEN** player plays with facts pending, !simOffline, triggers reconnect (real POST), server returns accepted + possible corrections + projected
- **THEN** local facts updated only with corrections (no dups), banner updates to synced/corrected, UI balance/revealed match authoritative projected, LS now contains post-sync state, continued play or re-reconnect is idempotent.

#### Scenario: Grant eligibility preserved across offline/reconnect/LS roundtrip
- **WHEN** marketplace buy creates grant (owned), play offline (facts pending), reload (LS restore), disable sim, real reconnect (with grant check on resume)
- **THEN** eligibility remains true post-restore/reconnect (no re-grant needed); facts + projections + corrections match goldens/authoritative; banner/owned status consistent.

(These deltas + added eligibility reqs/scenarios are directly testable via extended player-replay.test.ts (goldens + grant mock + eligibility asserts + mock apply), frontend build/lint, cargo grant tests, and manual "Save + open in real player" + marketplace "buy/get free/coupon 100%" exercising grant -> attempt -> offline toggle -> sync against live backend contract. They map 1:1 to the marketplace-grants proposal/design, archived facts-sync + prior player contracts, PLAN Phase 3 Commerce + AccessGrant, and current implementation while remaining additive. Existing non-grant reqs (reconnect, offline, fidelity, 4-templates, popup-only hints, etc.) unchanged. Full grant/attempt/coupon/free goldens TDD contract in marketplace-grants spec.)

## REMOVED Requirements
(none)

## RENAMED Requirements
(none)