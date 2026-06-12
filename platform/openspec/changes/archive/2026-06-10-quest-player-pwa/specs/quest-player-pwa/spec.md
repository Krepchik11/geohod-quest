## ADDED Requirements

### Requirement: Player loads and renders steps from frozen QuestSnapshot using 4 primary templates
The Quest Player SHALL load a QuestSnapshot (via golden id or future serialized bundle) and render the linear sequence of steps using the four primary templates (first_screen, task_no_answer, task_with_answer, continue) with their rich_content, media roles, completion mode, and supporting behaviors exactly as defined in the snapshot. Rendering SHALL be deterministic from the frozen data.

#### Scenario: Load mystery-fortress-v1 golden and advance through all 4 templates
- **WHEN** player opens /quest?golden=mystery-fortress-v1 (or equivalent load of the snapshot with 4 steps: first_screen physical start, task_with_answer "Первый вопрос" with acceptable ["ПУПИН","МИХАЙЛО ПУПИН"], task_with_answer with gift, continue terminal)
- **THEN** the UI renders step 0 as first_screen (title/main_text from snapshot, physical confirm button), step 1 as task_with_answer (question prompt, answer input), step 2 as task_with_answer (gift narrative visible), step 3 as continue/terminal; all rich text, button labels, and structure match the frozen snapshot exactly; no mutation of snapshot data.

### Requirement: Physical confirmation is uniform for physical steps (first_screen, task_no_answer, terminal)
The player SHALL provide a single explicit confirmation mechanism for all steps with completion.mode = 'physical' (or template first_screen/continue/terminal). This includes optional short note (if completion.allow_note), custom button text from rich_content.button_text or supporting.physical_action.confirm_label, and optional action description. Confirmation SHALL append a physical_confirmed fact and advance.

#### Scenario: Confirm start and terminal steps in mystery golden
- **WHEN** player confirms the first_screen (step 0, physical) with optional note "Started the journey" and later confirms the terminal continue (step 3) with note "Completed the quest"
- **THEN** physical_confirmed facts are appended with step_position, note, local_is_correct=true, coins_delta=0 (matching happy-with-gift expected); UI uses uniform "Подтвердить" or snapshot button text; no acceptable list is shown or required.

### Requirement: Answer tasks use exact shared isAnswerCorrect against snapshot acceptable list
For steps with completion.mode = 'answer', the player SHALL render input + submit using the question_prompt and button_text from snapshot. On submit, it SHALL call the imported isAnswerCorrect(submitted, acceptable) from shared-model (exact same fn as ctor Test match and goldens). Correct SHALL append answer_submitted fact (with submitted_value and local_is_correct=true) and advance (plus any gift claim); incorrect SHALL trigger the hint popup if configured (see separate req).

#### Scenario: Submit real synonym from export on task_with_answer step
- **WHEN** player reaches step 1 (task_with_answer), enters "МИХАЙЛО ПУПИН" (or "пупин"), and submits
- **THEN** isAnswerCorrect("МИХАЙЛО ПУПИН", ["ПУПИН", "МИХАЙЛО ПУПИН"]) returns true (as asserted in shared goldens tests); answer_submitted fact appended with submitted_value, local_is_correct=true, coins_delta=0; advances to next step. Submitting "wrong" returns false (fact not yet appended for success).

### Requirement: Hints available ONLY via immediate wrong-answer popup (no separate button)
On incorrect answer submit for an answer-mode step that has supporting.hint, the player SHALL immediately show a popup "Spend X coins for hint?" (X = supporting.hint.cost_coins from frozen snapshot). Accept SHALL append hint_purchased fact (coins_delta = -cost, step_position), reveal the hint (hint_reveal_text + media.hint role), and allow retry or advance. There SHALL be no always-visible hint button or other purchase path for any template. Cancel closes popup with no fact (player can re-submit answer).

#### Scenario: Wrong answer on step with hint cost, then spend
- **WHEN** player submits incorrect value on step 1 (which has supporting.hint with cost_coins), sees immediate popup, chooses to spend, and current projected balance >= cost
- **THEN** hint_purchased fact is appended (local_is_correct true, negative delta); hint content (text + hint-role media) is revealed in the step view; no other UI path exposes hint purchase. If balance insufficient, spend is blocked (no fact, no overdraft).

### Requirement: Navigator button appears only on physical/task_no steps when supporting.navigator present
The player SHALL show a Navigator button (label from supporting.navigator.label or default) only for steps that are physical-ish (template task_no_answer or completion.mode physical) AND have supporting.navigator data (lat/lng). Clicking SHALL open the geo (maps:// or in-app stub using frozen lat/lng) and append a navigator_used fact (for audit). The button SHALL NOT appear on pure answer or narrative steps, nor when no navigator in snapshot supporting.

#### Scenario: Navigator on physical step vs absent on answer step
- **WHEN** a physical step has supporting.navigator configured in the loaded snapshot vs an answer step without
- **THEN** Navigator button is rendered and functional only on the physical step (uses the exact frozen lat/lng/label/hint_only/shortest_route from snapshot); absent on answer steps; click appends navigator_used fact with step_position.

### Requirement: "Оставить отзыв" (FeedbackReport) available from global menu on every page/step
On every rendered step (including first_screen, mid-quest answer/physical, terminal), the player SHALL provide a global menu or persistent "Оставить отзыв" affordance. Activating it SHALL capture context (current step_position + snapshot) + optional note and append a feedback_reported fact (coins_delta=0, local_is_correct=true, note, step_position). This works while offline via local log.

#### Scenario: Leave feedback mid-quest on answer step then continue
- **WHEN** player is on step 1 (mid), opens menu, enters "Bug in hint text", submits feedback, then continues playing to completion
- **THEN** feedback_reported fact is appended with step_position=1, note="Bug in hint text"; play continues unaffected; fact is part of local log and would be synced later; available identically on step 0 and step 3.

### Requirement: Local append-only facts + deterministic re-projection exactly matches goldens (incl. gifts, balance, revealed)
All player actions SHALL append immutable facts using the exact shared Fact shape and types (physical_confirmed, answer_submitted, gift_claimed, hint_purchased, attempt_completed, feedback_reported, ...). Gifts from supporting.gift SHALL be auto-claimed (append gift_claimed with frozen coins_delta) when the step is reached/after prior completion if not already claimed. On any append, the player SHALL re-project via imported projectBalance(facts) and projectState(facts) from shared-model. The resulting facts and projections for the happy-with-gift replay (or equivalent actions on mystery snapshot) SHALL exactly equal the golden's expected_facts, expected_final_balance, and revealed state. Local facts SHALL persist to localStorage (keyed by golden/snapshot) and restore on reload to resume at last step with identical projection.

#### Scenario: Replay happy-with-gift actions (incl. real synonym + gift at 2) produces exact match
- **WHEN** player (or replay test) performs actions equivalent to happy-with-gift (physical 0 with note, submit "МИХАЙЛО ПУПИН" on 1, reach/claim gift on 2, physical 3) against the mystery snapshot
- **THEN** emitted facts exactly match the golden's expected_facts array (incl. gift_claimed at position 2 with +5, answer_submitted with real value, attempt_completed at 3, no hint facts); projectBalance(facts) === 5; projectState matches completed/revealed; after reload from LS the state and balance are identical with no lost/double facts.

#### Scenario: Wrong answers + hint spend + feedback do not break projection fidelity
- **WHEN** player submits wrong on an answer step, spends on hint popup (append hint_purchased neg delta), appends feedback mid, then completes with gift
- **THEN** final projected balance accounts for all deltas (gifts positive, hint negative) exactly; revealedHints includes the spent step; no overdraft; facts log is append-only and re-projection on reload matches.

### Requirement: Terminal step completes the attempt and emits attempt_completed + bonus
On confirming a terminal/continue step (supporting.terminal), the player SHALL append attempt_completed fact (plus any final gift/bonus from snapshot), show completion UI with final projected balance, summary, and options (replay, clear local). Bonus animation/voice stub SHALL trigger for gift or terminal per supporting.bonus_animation.

#### Scenario: Complete mystery golden terminal
- **WHEN** player reaches and confirms step 3 (terminal)
- **THEN** attempt_completed fact appended (step_position=3, local_is_correct=true); completion screen shows final balance from projection (5 for happy path); any bonus_animation on the step or prior gift is triggered (visual + voice stub); "complete quest" path exercised.

### Requirement: Offline indicator, simulate disconnect, and local-only persistence for replay
The player SHALL display an offline/pending banner when in simulated-offline mode or when local facts exist. A "simulate disconnect" toggle SHALL prevent sync simulation and force local-only. "Simulate sync" (when not disconnected) SHALL be a no-op banner ("facts would append idempotently; no corrections in demo") that leaves local state unchanged. All state (facts, current step) SHALL survive full page reload via localStorage and produce identical projection/behavior post-reload. No network calls to real sync.

#### Scenario: Play offline, reload, simulate reconnect
- **WHEN** player plays several steps (incl. gift claim + wrong+spend), enables simulate disconnect, reloads the page, then disables disconnect and triggers "simulate sync"
- **THEN** on reload the exact step, facts, balance, and revealed state are restored from LS and projections match pre-reload; banner indicates offline during sim; sync sim shows message but does not alter local facts or require backend; full flow remains playable end-to-end with no server dependency.
