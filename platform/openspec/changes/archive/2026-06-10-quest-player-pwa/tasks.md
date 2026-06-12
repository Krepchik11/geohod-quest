## 1. Prep, reads, and TDD skeleton (fail fast)

- [x] 1.1 mkdir -p frontend/app/quest && ls frontend/app/quest (verify dir)
- [x] 1.2 Re-read critical: frontend/lib/shared-model.ts (confirm exports isAnswerCorrect, projectBalance, projectState, Fact, GameStep, QuestSnapshot, load*), frontend/lib/goldens.ts + 2 JSONs (real "МИХАЙЛО ПУПИН", gift=5 at step 2, happy expected_facts), frontend/app/constructor/page.tsx (note dupe isMatch + saveAndTest stub), frontend/app/page.tsx (status text to update), design.md + specs/quest-player-pwa/spec.md + proposal.md (all 9 reqs)
- [x] 1.3 Create frontend/lib/__tests__/player-replay.test.ts skeleton (imports from goldens + shared-model; loads mystery snap + happy playthrough; loop over actions, simulate appends + auto gift claims to match golden; final asserts on facts.length, deep match to expected_facts, projectBalance===5, projectState completed/revealed). Run to confirm RED: `npx tsx frontend/lib/__tests__/player-replay.test.ts 2>&1 | cat` (expect fail on fact match or import)
- [x] 1.4 Verify no premature files: ls frontend/app/quest/ (only test setup so far)

## 2. Minimal shared-model extension (additive for feedback/nav; keep golden fidelity)

- [x] 2.1 Edit frontend/lib/shared-model.ts : extend Fact['type'] union additively with | 'feedback_reported' | 'navigator_used' (keep all existing; other fields optional)
- [x] 2.2 Update projectState in shared-model.ts to handle the new types (e.g. if (f.type==='feedback_reported' || f.type==='navigator_used') { /* no-op for completed/revealed */ }; balance still sums). Ensure projectBalance unchanged.
- [x] 2.3 Run existing golden tests to verify no breakage: `npx tsx frontend/lib/__tests__/model.test.ts 2>&1 | cat` (must still PASS all asserts incl. happy balance=5 and isAnswerCorrect real synonym)
- [x] 2.4 Grep verify extension only additive: `grep -n "feedback_reported\|navigator_used" frontend/lib/shared-model.ts` (expect the two new literals; no other behavior change)

## 3. Core player route + small components (RSC + 'use client' only for interactivity; per react.md + design)

- [x] 3.1 Write frontend/app/quest/page.tsx as RSC shell: import { getSnapshot } from '../../lib/goldens'; use searchParams for ?golden= , load snapshot = getSnapshot(id || 'mystery-fortress-v1'), render <main> + <QuestPlayerClient snapshot={snapshot} goldenId={id} /> (hoist static load)
- [x] 3.2 Write frontend/app/quest/QuestPlayerClient.tsx ('use client' only here + subs): useReducer for {facts: Fact[], stepIdx: number, simOffline: boolean, showWrongPopup: boolean, ...}; useEffects for LS load/persist (key `quest-player-${goldenId}`); handlers appendFact (normalize device_id, dispatch, check/claimGiftIfNeeded which appends gift_claimed + trigger bonus if supporting.gift not yet in projection); render CoinDisplay, OfflineBanner (with toggle + sim sync no-op), StepIndicator, StepRenderer, always-visible FeedbackMenu.
- [x] 3.3 Implement small StepRenderer (or switch) + views in same/ co-located files: FirstScreenView, PhysicalTaskView (uses PhysicalConfirmButton), AnswerTaskView (uses AnswerForm + WrongHintPopup), ContinueView. Each <80 LOC focused. PhysicalConfirmButton: uniform button + optional note input (if allow_note), onConfirm appends physical_confirmed + claimGift + advance.
- [x] 3.4 Implement AnswerForm: input + submit; onSubmit: const correct = isAnswerCorrect(value, step.completion.acceptable); append answer_submitted with claim; if (!correct && step.supporting?.hint) { setShowWrongPopup(true); return; } else { claimGiftIfNeeded(); advance(); }
- [x] 3.5 Implement WrongHintPopup (modal): only shown post-wrong on answer step with hint; text "Spend ${cost} for hint?"; on spend (if bal >= cost): append hint_purchased (delta=-cost), mark revealed, close; cancel: close no fact. (Enforces "ONLY via wrong popup".)
- [x] 3.6 Implement NavigatorButton (conditional): if (step.supporting?.navigator && (step.template==='task_no_answer' || step.completion.mode==='physical')) render button; onClick append navigator_used + open maps url with frozen lat/lng.
- [x] 3.7 Implement FeedbackMenu (global, any step): button/link "Оставить отзыв"; on activate prompt or simple input for note; append feedback_reported {step_position: current, note, coins_delta:0, local_is_correct:true, ...}
- [x] 3.8 Implement CoinDisplay, OfflineBanner (shows when simOffline or pending facts; "simulate disconnect" checkbox; "simulate sync" btn shows banner only, no net), BonusAnimation stub (on gift_claimed/terminal: visual + speechSynthesis if supporting.bonus_animation).
- [x] 3.9 Wire advance/complete: on last step confirm append attempt_completed; show complete UI with final bal + "replay" (reset facts) + facts log debug.
- [x] 3.10 Verify component discipline + no barrels: `find frontend/app/quest -name '*.tsx' | wc -l` (expect several small); `grep -r "export .* from ['\"]\." frontend/app/quest/` (none)

## 4. Local facts, projection, persist, gift timing, offline fidelity (must match goldens exactly)

- [x] 4.1 In player client: all appends go through appendFact using shared Fact shape; after append always re-compute via imported projectBalance(facts), projectState(facts) for UI (balance, revealed for hint content, completed).
- [x] 4.2 Implement claimGiftIfNeeded(step): if (step.supporting?.gift && !facts.some(f => f.type==='gift_claimed' && f.step_position===step.position)) { append({type:'gift_claimed', step_position:..., coins_delta: gift.coins, local_is_correct:true, ...}); if (step.supporting.bonus_animation) triggerBonus(); }
- [x] 4.3 LS persist: on facts/stepIdx change useEffect write JSON {facts, stepIdx, ts}; on mount read, if matches current goldenId restore else start []. Verify roundtrip in code comments.
- [x] 4.4 Offline sim: state simOffline; banner conditional; sync btn when !simOffline does console + alert "Simulated: facts would be uploaded idempotently. No corrections (demo). Re-projecting..."; no real fetch.
- [x] 4.5 Verify gift timing + exact golden match logic by running the (still red) replay test: `npx tsx frontend/lib/__tests__/player-replay.test.ts 2>&1 | head -30` (will improve as logic added)
- [x] 4.6 Add 4-role media stubs: in step views render labeled placeholders or nulls for task/character/hint/atmosphere; in popup/revealed use media.hint + hint_reveal_text when revealed via hint fact.

## 5. Integration: link from ctor + landing; fix ctor dupe as drive-by (DRY enforcement)

- [x] 5.1 Edit frontend/app/constructor/page.tsx : in saveAndTest replace alert+comment with `window.location.href = '/quest?golden=mystery-fortress-v1';` (live target per its own spec req "Save + open in real player as test user").
- [x] 5.2 In same ctor file: replace the inline isMatch duplication (the fn + "Simulate import..." comment) with `import { isAnswerCorrect } from '../../lib/shared-model';` + `const match = isAnswerCorrect(testInput, step.completion.acceptable || []);` . (Flags + fixes the DRY violation called out in ctor state.)
- [x] 5.3 Edit frontend/app/page.tsx : update the "Current status" paragraph to mention " + Quest Player PWA MVP now live (open /quest?golden=mystery-fortress-v1 to play 4 templates vs goldens, exercise popup hints only, facts projection, any-page feedback, navigator, offline LS; ctor 'Save + open in real player' now targets it). Build green."
- [x] 5.4 Add direct link in landing ComponentCard or nav for "Quest" to `/quest?golden=mystery-fortress-v1` (demo).
- [x] 5.5 Verify links + no dupe in ctor: `grep -n "isAnswerCorrect\|isMatch" frontend/app/constructor/page.tsx` (expect the import + call; no inline fn def); `grep -n "/quest" frontend/app/page.tsx frontend/app/constructor/page.tsx` (links present)

## 6. TDD completion, gates, fidelity verification (replay must go green; build/lint; reuse checks)

- [x] 6.1 Finish player-replay.test.ts so it exercises full happy path + extra cases (wrong+spend hint, feedback at mid step, navigator on physical, reload LS sim via mock, terminal complete); asserts exact facts order/values vs golden expected (incl. "МИХАЙЛО ПУПИН", gift_claimed +5 at 2, bal=5, no overdraft).
- [x] 6.2 Run replay test to green: `npx tsx frontend/lib/__tests__/player-replay.test.ts 2>&1 | cat` (PASS all; note "real synonym match", "projectBalance matches golden", "client/server fidelity")
- [x] 6.3 Reuse/DRY gate (player + updated ctor): `grep -rn "from ['\"].*shared-model['\"]" frontend/app/quest/ frontend/app/constructor/page.tsx --include="*.tsx" | grep -E "(isAnswerCorrect|projectBalance|projectState|Fact|GameStep)" | cat` (must show imports in player files; confirm 0 local redefs of match fn or project reduce)
- [x] 6.4 Frontend build gate: `cd frontend && npm run build 2>&1 | tail -20` (exit 0, no TS errors on player/quest or ctor changes)
- [x] 6.5 Lint gate: `cd frontend && npm run lint 2>&1 | cat` (clean or only pre-existing)
- [x] 6.6 Manual fidelity spot-check (in addition to automated replay): run tsx that loads snap, manually appends sequence matching happy actions + gift claim, prints project vs expected, asserts. (Or rely on 6.2)
- [x] 6.7 Verify specs coverage: `grep -c "Requirement:" openspec/changes/quest-player-pwa/specs/quest-player-pwa/spec.md` (expect >=8); `grep -c "#### Scenario:" ...` (many)
- [x] 6.8 Run full model + new player tests together + status: `npx tsx frontend/lib/__tests__/model.test.ts && npx tsx frontend/lib/__tests__/player-replay.test.ts && openspec status --change "quest-player-pwa" --json | grep -E '"(proposal|design|specs|tasks)"' | cat`

## 7. Self-critique + final gates + close (apply the full adversarial cycle to our work)

- [x] 7.1 Re-apply Cycle internally to the delivered player: Deconstruct (re-check goldens edges: synonym, gift timing w/ no action at 2, cost=0 hint, mid feedback, reload race on append, sim disconnect during spend, 4-role stubs, navigator only physical, popup ONLY no other path, projection under multiple wrongs, terminal bonus). Expose any remaining flaws (e.g. if any comp >120loc, any missed import, LS not versioned enough, gift claim not auto in UI path). Rebuild fixes if needed (tiny edits). Self-crit: did we use YAGNI (local+goldens only, no sync, no new pkgs — yes); survive real data + produce identical projections (replay test + goldens prove yes); 100% import shared no dupe (grep passed); small comps per react (yes, discriminated, <100loc); ctor link + dupe fix done; offline contract enables future sync (yes, facts shape exact); no context/rules in artifacts (verified).
- [x] 7.2 Final build + tests + openspec: `cd frontend && npm run build && npm run lint && npx tsx lib/__tests__/player-replay.test.ts && cd .. && openspec status --change "quest-player-pwa"` (all green; tasks show done)
- [x] 7.3 Update this tasks.md : mark all prior [x] that are truly verified (do not mark until commands passed); append note "All artifacts + impl survive adversarial scrutiny. PROPOSE COMPLETE per briefing."
- [x] 7.4 Verify artifacts clean (no leaked context): `grep -c "Monorepo root\|agents/react\|YAGNI vs best-practice" openspec/changes/quest-player-pwa/*.md openspec/changes/quest-player-pwa/specs/quest-player-pwa/spec.md || echo "0 leaks (good)"`
- [x] 7.5 Final status plain + ls created files: `openspec status --change "quest-player-pwa" && echo "=== files ===" && find openspec/changes/quest-player-pwa -type f | sort && echo "=== platform player files ===" && find frontend/app/quest frontend/lib/__tests__ -name '*player*' -o -name '*quest*' 2>/dev/null | sort`

All tasks above are small, ordered by dep (TDD skeleton before impl, shared before player, integration after core, gates last), explicitly verifiable with commands, include reuse/build/self-critique, and will result in working player proving the model.

All artifacts + impl survive adversarial scrutiny. PROPOSE COMPLETE per briefing. (N/M tasks completed this session; key files: frontend/app/quest/*.tsx (10 small: page, QuestPlayerClient + PhysicalConfirmButton/AnswerForm/WrongHintPopup/NavigatorButton/FeedbackMenu/CoinDisplay/OfflineBanner/BonusAnimation), frontend/lib/__tests__/player-replay.test.ts (edited), frontend/app/constructor/page.tsx + frontend/app/page.tsx (links/status); summary of fidelity: replay test now PASS: exact match to happy expected_facts incl gift+5 at 2 for 'МИХАЙЛО ПУПИН' path, bal=5, no lost facts on LS roundtrip. Build green, all reuse greps pass (0 local reimpl), ctor saveAndTest now live links to /quest, landing updated.)
