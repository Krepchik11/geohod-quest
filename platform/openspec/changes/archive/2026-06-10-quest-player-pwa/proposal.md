## Why

The Quest Constructor MVP (4-template picker, pre-fills, AnswerListEditor + live match, gates, explicit Publish stub using serialize, "Save + open in real player as test user" stub) now exists and produces frozen QuestSnapshots per the immutable model. However, the player target is missing: the ctor's save+test is a dead alert, there is no /quest route, and the frozen snapshot + facts model cannot be exercised or validated against real goldens (e.g., synonym answers like "МИХАЙЛО ПУПИН", gift of 5 coins on happy-with-gift playthrough, 4 templates, projections). Without the real player PWA we cannot prove that "hard to publish bad" works in actual UX, that hints are *only* via wrong-answer popup, that local append-only facts + re-projection match goldens exactly (client-authoritative offline), or that the ctor's "test in real player" link functions. Per PLAN Phase 3, after constructor comes the Player / Quest experience (PWA) to close the loop. Why now: ctor MVP complete, shared-model-goldens in place, build green; this is the immediate validator for snapshots before sync/backend slices.

## What Changes

- Add real Quest Player PWA at `/quest` (supporting `?golden=<id>` or future serialized snapshot load) that renders the 4 templates from frozen snapshots/goldens, exercises full flows (physical confirm uniform + optional note, answer with live shared validation, wrong->immediate "Spend X for hint?" popup *only*, navigator button only on physical-ish steps, gift/terminal bonus_animation+voice stubs, any-page "Оставить отзыв" menu appending FeedbackReport fact with step context).
- Local append-only facts log (using exact shared Fact shapes) + deterministic re-projection for balance/revealed/completed (must reproduce happy-with-gift expected_facts and balance=5 exactly); persist to localStorage for reload/resume; "simulate disconnect" toggle + "simulate sync" banner (no real backend yet).
- Small focused components (per react.md): discriminated step renderers, PhysicalConfirmButton, AnswerForm (imports isAnswerCorrect 100%), WrongHintPopup, NavigatorButton, FeedbackMenu (global, any step), CoinDisplay, OfflineBanner, etc. No god components.
- Update landing (app/page.tsx) status text + add live link to `/quest?golden=mystery-fortress-v1`; update ctor (app/constructor/page.tsx) saveAndTest to live target the player URL (enabling the stub per ctor's own spec) and flag/call out its current isMatch duplication.
- Extend shared Fact union additively (for 'feedback_reported' etc. to support any-page per SPEC/TECH/ctor-req) + minimal projector updates; add TDD replay test (actions -> facts -> project match vs goldens, fidelity checks).
- **Non-changes (YAGNI per PLAN/explicit cuts)**: no real backend sync/append/corrections endpoint (local log + project + simulate banner is fine; full facts backend is subsequent slice), no real AccessGrant/checkout, no high-fidelity live preview (save+real-player-test is the validation), no branching, no advanced normalization.
- No **BREAKING** changes.

## Capabilities

### New Capabilities
- `quest-player-pwa`: The offline-first PWA quest player experience. Renders linear 4 GameStep templates (first_screen, task_no_answer/physical, task_with_answer, continue/terminal) from frozen QuestSnapshots (loaded from goldens or future bundles); local validation (strict import of isAnswerCorrect); physical confirms + answer submits; hints *exclusively* via wrong-answer popup spend (append hint_purchased); navigator (only on task_no/physical, using supporting data); gift claim + terminal bonuses (with anim/voice); global menu "Оставить отзыв" on every page (incl. mid-quest) appending FeedbackReport facts with step context; append-only local facts + re-project for state/balance/revealed/completed (exact fidelity to goldens like happy-with-gift); offline indicator + localStorage persist/replay; "complete quest" emits attempt_completed + final bonus. Proves ctor-produced snapshots in real UX and enables "Save + open in real player as test user". (Creates `specs/quest-player-pwa/spec.md`)

### Modified Capabilities
(none)

## Impact

- **Frontend routes/UI**: New `frontend/app/quest/page.tsx` (player); updates to `frontend/app/page.tsx` (landing card links + current-status text now mentions player MVP linking ctor test); updates to `frontend/app/constructor/page.tsx` (make saveAndTest live + note on DRY violation in its test match).
- **Shared model**: Small additive updates to `frontend/lib/shared-model.ts` (Fact union for feedback etc. to satisfy any-page reqs; projectors remain pure/compatible); `frontend/lib/goldens.ts` usage (no change).
- **Tests/TDD**: New or extended `frontend/lib/__tests__/*` (replay simulator for goldens playthroughs exercising player actions, wrong->hint, navigator, feedback, projection fidelity; must pass before "complete").
- **Other**: Updates to status/docs references; no backend changes (YAGNI); quality gates (npm run build/lint in frontend, test via tsx) will be enforced in tasks.
- Enables ctor's "real player test" requirement (per quest-constructor spec) and PLAN "Player / Quest experience (PWA)" bullets + SPEC (4 templates, hints only via popup, facts, bundle offline, FeedbackReport any-page, 4-role media, supporting additive).
- Follows all principles: TDD (goldens-driven replay), SOLID/DRY (import shared 100%, no dupe logic, small comps), KISS/YAGNI (local facts first, goldens for demo, no premature sync), react.md (RSC shell + 'use client' only for interactivity, extract focused components, no barrels, explicit), blueprint invariants (frozen snapshots, client auth, append facts).

This is the foundation proving the model works end-to-end in the player before deeper slices.
