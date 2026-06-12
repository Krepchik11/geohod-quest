# ANALYZE-03: Deep Adversarial Analysis of GameStep Model, Completion Semantics, Physical vs. Answer-required, and Supporting Step Types

**Task:** ANALYZE-03 — Chief Staff Engineer + relentless Critical Analyst subagent.  
**Date of analysis:** 2026-06-09 (grounded in current business/ docs v0.2 and discovery artifacts).  
**Scope:** GameStep (core of Quest aggregate), primary completion modes (Physical confirmation-only vs Answer-required list-of-strings), supporting behaviors (narrative/lead/continue, gift, hint, media/video, terminal/congratulations, start/greetings, error), linear sequence constraint.  
**Grounding sources (all local to workspace, no external assumptions):**  
- `business/08_DECISIONS_LOG.md` (locked Physical + Answer decisions, offline validation).  
- `business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md` (GameStep attributes, invariants, "exactly one primary completion mode").  
- `business/04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md` (primary modes + supporting flags, old Page_type deprecation, constructor needs, "Mystery of the Fortress" statue example).  
- `business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md` (physical = explicit player_confirmed, no answers list; answers = local snapshot list match; sync records without re-validate; "I completed a physical step but later want to undo" → reset attempt).  
- `business/07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md` (risks: "Physical step completion mechanic feels too trivial... reduces the magic"; open: acceptable answers precision, namerequest relevance, exact UI differences).  
- `business/09_WHY_THE_QUESTIONS.md` (why not copy old; extraction of intent over 1163 workflows / 47 types / duplication).  
- `business/06_V1_REQUIREMENTS_AND_CUT_LIST.md`, `00_PRODUCT_VISION_AND_SCOPE.md`, `02_COMMERCE...`, `05_ROLES...` (linear, coins via gifts/completions, trust honesty for physical in v1, cuts on branching/anti-cheat/photo).  
- Discovery: `discovery/parsed/option_sets.json` (full 14-value page_type incl. `questionnoanswer`, `question`, `question0`, `gift`, `lead`, `congratulations`, `video`, `namerequest`, `screenafterquest`, `style`, `hint`, `greetings`, `start`, `error`).  
- `discovery/parsed/data_types.json` (page_constructor fields: `Answers` = list.text, `Page_type`, `Gift_Coins` = number, `Main_text_RU`/`Place_RU`/`Page_name_RU`/`Button_text_RU`, `latitude`/`longitude`, `Hint_Image`, `Video_link`, `Hint`/`Next_page` self-refs, 556 records).  
- `discovery/parsed/element_definitions.json` (old UI: specialized `Slide_Question_no_answer` (7 WFs, states: help_, showpopup4a_, openbigimage_), `Slide_Question` (12 WFs, many states incl. correct_answer_, errorstyle_, music_, openerrorhint_), `Slide_Lead` (7 WFs), `Slide_give_prize` (8 WFs), `Slide_Congratulations` (9 WFs, steps_for_accruing_coins_), `Slide_Video`, `Slide_Start`, `Slide_Greetings`, `Slide_Hint`, `Slide_Error` (21 WFs), mapbox custom).  
- `discovery/parsed/workflows_sample.json`, `api_events.json`, `pages.json`, `record_counts.json` (21 quests, 556 pages/steps; 1163 total workflows, heavy ButtonClicked/SetCustomState/ChangeThing/Show/Hide per type).  
- `docs/` overviews (re-iterate same Page_type list + old flows).  
- No raw page_constructor *data rows* (actual step texts/Answers/Gift_Coins values) were exportable via the probed API (types mirrored but full content in live DB only; 404s for many in probe_results). "Mystery of the Fortress" is the canonical running physical example *provided in the business docs themselves*. Answer examples inferred from common quest patterns described (counting, plaque text, rebus solutions as strings).  

**Locked constraints (must not contradict):**  
- Physical = confirmation-only (uniform "no difference" explicit confirmation UI/action, *no* answers list, optional short note, geo display + hint-coin reveal *only*). Trust player honesty. No digital proof/photo/geofence enforcement in v1.  
- Answer-required = list of strings (multiline input in constructor, one per line; client membership match against local snapshot for full offline; advanced normalization deferred).  
- Supporting as flags/combinations on the two primaries. Linear sequence (no branching v1; old Next_page self-refs treated as historical).  
- Offline: client validates fully from snapshot; server records submissions + local outcome (no re-validation of correctness). Versioned bundles.  
- Coins: per Gift_Coins on steps + completion awards (exact old triggers extracted to gifts/completions).  
- Old 14+ Page_types = overloaded mess to ruthlessly simplify (dupe page/page_constructor, per-type slide components + 3-21 workflows each, 444 SetCustomState, scattered coin/answer_card mutations).  

**Process:** Deconstruct edges → expose flaws in current proposal (and old) → define 4+ variants → full deconstruct/expose/rebuild/self-critique per variant → edge matrix → recommendation with justification → explicit self-critique of recommendation. Extreme skepticism throughout. "Improves maintainability/readability" claims are attacked.

---

## 1. Realistic Examples (Grounded in Described Intent + Schema)

Since full 556 step records not present in workspace artifacts (only schema + counts + UI element defs), examples are constructed from:

- Business docs' explicit "Mystery of the Fortress" physical example ("go to X, find the object, optionally perform an action (touch the hands of the statue and feel the cold metal)"). This was almost certainly a `questionnoanswer` Page_type page_constructor record (no `Answers` list, geo lat/long, Image_link or Hint_Image of statue, Main_text_RU describing the action + confirmation prompt, Button_text_RU="Я сделал это" / "Нашёл", Place_RU, Duration, possibly Gift_Coins=0 or small, Next_page link for linear flow). Old Slide_Question_no_answer handled its rendering/confirm (different from Slide_Question).
- Answer steps: `question`/`question0` with `Answers` = ["42", "сорок два"] or ["Александр III", "Александр 3"] (plaque text, count of windows/columns, rebus solution as string). Slide_Question did input + local? (old was server) validation + wrong count + hint buy flow + error states.
- Gift: `gift` or embedded on congratulations/lead with `Gift_Coins` = 5 (or 1). Old "You_made_it", Complited_quest, steps_for_accruing_coins_ reusable, Getting_5_coins_for_completing list on user. Slide_give_prize.
- Narrative/lead/continue: `lead` Page_type, simple advance ("Next" / "Продолжить"), Main_text story, optional image/geo for "observe here".
- Media: `video` (short 10-30s Video_link), `style`? decorative.
- Terminal: `congratulations` + `screenafterquest`, review prompt, coin award logic.
- Hint: separate `hint` type or per-step gated (Buy_hint on answer_card, reveal Hint_Image + geo).
- Start/greetings/namerequest: special entry or name prompt (open: still needed?).
- Error: `error` for wrong answers/guidance.

**Plausible "Mystery of the Fortress" excerpt (reconstructed for analysis; Russian in real):**
- Step N (physical, questionnoanswer style): Page_name_RU="Руки статуи", Main_text_RU="Подойдите к памятнику. Коснитесь холодных металлических рук статуи. Почувствуйте текстуру и холод. Это ключ к следующей загадке.", Place_RU="Крепостная площадь, у центрального входа", latitude=..., longitude=..., Image_link=statue.jpg, Answers=(empty list or absent), Page_type=questionnoanswer, Gift_Coins=0, Hint= (optional coin-gated extra photo or "the hands point north"), Button_text_RU="Я выполнил действие / Нашёл и потрогал".
- Step N+1 (answer): "Сколько пальцев на руках статуи?" or "Какое слово вы 'услышали' от металла?" → Answers list with variants. Or rebus visual whose solution string is entered.
- Later gift step: "Вы сделали это!" + Gift_Coins=5, triggers old coin accrual.

Old flow (inferred from element defs + generate_docs journey): Load page_constructor seq → dispatch on Page_type → render specialized Slide_* → for question: InputChanged → validate (old server via addAnswerCard) → ChangeThing on answer_card (Complited, Count_wrong_answers, Buy_hint) → conditional next via Next_page or state. For questionnoanswer: simpler confirm path, no Answers, still answer_card record? (flags bag). Heavy custom state per slide.

This is the "expressive but messy" baseline: 14 types → 14-ish specialized components/workflows → duplication, imperative mutation hell, no versioning/offline concept.

---

## 2. Deconstruction: Edge Cases (Physical and Answers)

### Physical (confirmation-only, uniform, trust honesty) — Locked but Attacked
1. **Player lies / skips real-world action entirely** ("I tapped Done without going to the fortress or touching anything"). Locked: accepted (trust). But atmosphere dies; paying player feels cheated if they discover others "cheated" easily. No server proof possible without future geofence/photo (explicitly cut for v1; "advanced anti-cheat or photo proof" = future).
2. **Player confirms, then regrets / "I didn't really feel it" / wants to re-experience.** Undo per-step? Current proposal: no (reset *entire attempt* clears all StepCompletions). Loses partial progress + any coin spends. Harsh for long quests.
3. **"Action" is observational vs manipulative.** Uniform "I did it" button treats "stand here and look at the view for 30s" identically to "touch the cold hands and say the phrase aloud". Kills differentiation and immersion (old per-Page_type slides at least allowed different button text / images / states per historical quest).
4. **Multi-player / couple / team play.** One player confirms for group? Shared attempt state? Not in scope (v1 single player attempts), but real quests often social. Future collision with "per-attempt" coins/hints.
5. **Location verification future (or "geo display only" evolves).** Current: lat/long = display/map pin + "show on map" for *purchased hints only*. What if later rule "must be within 50m to confirm"? Breaks "simple confirmation" + offline (no GPS reliable offline?). Or photo upload proof — requires new media in StepCompletion, new rule, bundle bloat, privacy.
6. **Timing / duration enforcement.** Old had Duration_RU per page. Physical "spend 2 minutes here observing"? Uniform confirm doesn't capture "I spent the time". (Could be narrative flavor only.)
7. **Conditional physical (depends on prior answer).** E.g., "If you chose path A, now do physical X; else Y." But linear + no branching = forces duplication or "do both" or author workarounds. Old Next_page might have supported some dynamism via workflows.
8. **Undo after sync / cross-device.** Local confirm, syncs as player_confirmed=true. Later on another device: does reset affect it? Merge semantics in 03_ are "last-write or union" — ambiguous for "I lied then corrected".
9. **"No difference" kills author creativity / quest variety.** All physical steps render ~identically (same confirm chrome + optional note + geo). Old overloaded types let authors pick "style" or "questionnoanswer" which drove different visuals/workflows. Risk noted in 07_: "feels too trivial and reduces the magic".
10. **Partial or progressive physical tasks.** "Touch hand 1, then walk to hand 2, confirm at end." One step or N? Uniform model pushes authors to one big confirm or split into multiple identical-feeling steps.

### Answer-required (list of strings, client match, offline) — Locked but Attacked
1. **Synonyms / variants / typos / Russian specifics.** List allows ["Александр", "Александр III", "Александр 3-й"]. But "александр" (case), "Александръ" (old orthography), "Алекс" (partial), "Александр 3" with punctuation. Normalization *deferred* → early quests will have brittle matches. Client match bug = permanently wrong is_correct for that snapshot version (per 03_ decision).
2. **Rebus / visual / non-pure-string puzzles.** Common in location quests: image or observation whose "answer" is a word/phrase that requires interpretation ("the thing that looks like a key + fortress = ?"). List of strings works if author pre-defines the canonical string(s), but "partial credit" or "explain your reasoning" impossible. If rebus is image in step, answer is still string — but may not scale if future richer media puzzles.
3. **Numeric / counting with tolerance or multiple representations.** "How many arches?" Answers=["7","seven","семь"]. But "7 or 8 depending on angle"? Range? "Approx 7"? List of strings forces discrete; no "number between 6-8" without enumerating. "1" vs "один" vs "I".
4. **Multiple valid paths / non-unique solutions.** Quest design often has 2-3 equally "correct" observations leading to same next. List handles multiples, but if paths diverge in *experience* (different physicals later), linear forces either "any correct advances same" or content duplication.
5. **Partial credit / hints inside answer / multi-part answers.** E.g., "First word of inscription + number of letters"? Or "submit 3 things you saw". Current: all-or-nothing per step (wrong answer counter increments). Old answer_card had Count_wrong_answers aggregate.
6. **Order-dependent or contextual answers.** "The answer is the name on the *left* plaque" (ambiguous without photo). Or changes based on prior step choice (again, linear hurts).
7. **Client offline match vs author intent drift.** Author publishes v1 with Answers=["foo"]. Player downloads, plays offline with "f00" (typo) → wrong. Later author fixes list in v2. Old attempts frozen to v1 list (per locked decision). Analytics on submitted (wrong) answers become crucial (noted in 08_).
8. **"Secret" or very long / formatted answers.** Multiline input in constructor ok for list, but display/keyboard on mobile for 50-char rebus solution? Copy-paste from photo? Cheating vector (player screenshots Answers from bundle? but "protected" assumed; 07_ open on protected rep).
9. **No "I don't know, spend coin for hint that gives the answer" vs geo hint.** Hints are coin-gated *geo reveal + hint content*, not direct answer spoilers (per model). For pure knowledge questions this may frustrate.
10. **Rebus that is *not string at all* in future.** E.g., "arrange these 4 photos in story order" or audio match. List-of-strings + simple client match won't extend without new rule types.

### Cross-Cutting + Taxonomy Issues
- **Bloat vs oversimplification:** Old 14 types = high expressiveness per quest (different slides, different button chrome, different states for gifts vs questions vs physicals) but catastrophic maintainability (per-type WFs, 21 WFs on Slide_Error alone, scattered coin logic in "666" + answer_card flags, no single source of truth for "what completes a step"). Current lean proposal risks the opposite: uniform physical feels same-y; flag combos explode in constructor (invalid states like "physical + has Answers list"?); supporting narrative on answer step vs standalone.
- **Linear vs real content needs:** Old had Next_page + workflows that could conditional (inferred from "some existed"). Decision: linear v1. But real quests (21 of them) may have used the self-refs for light branching or "skip if X". Forcing sequence may require authors to linearize creative content (e.g., "do physical A or B" becomes two parallel steps, one of which is "skip by confirming you did the other").
- **Atmosphere / "magic" loss:** Uniform + list may make quests feel more like "form filler + confirm button" than immersive location adventures. Old (messy) at least allowed per-page differentiation.
- **Version freeze + client-as-truth:** Any modeling choice baked into a published snapshot's GameStep rules is *immutable* for players who started against it. Bad modeling choice has long tail.
- **Multi-attempt / replay:** Reset clears completions; replay sees same rules. Good for "play again for better score", but physical "I already touched it last time" feels silly on replay.
- **Constructor authoring velocity:** Flags vs first-class kinds affects how fast internal team (only authors) can iterate 21+ quests.

These edges are *not hypothetical*; they are directly implied by the locked "trust + simple list + uniform + linear + offline snapshot" + historical Page_type variety that existed to (over-)address them.

---

## 3. Flaws in the Current Lean Proposal (Discriminated Primary Mode + Supporting Flags)

**Current (per 01/03/04/08):** GameStep has:
- Primary discriminator: `completion_mode: 'physical' | 'answer_required'`.
- For physical: no `acceptable_answers`; `player_note?: string`; uniform confirm semantics.
- For answer: `acceptable_answers: string[]` (from multiline); client `matches( submitted, list )`.
- Supporting: flags/combos e.g. `is_gift: bool` (with `gift_coins?: number`), `has_hint: bool` (coin cost, reveal content/geo), `is_video: bool`, `is_terminal: bool`, `is_narrative?: bool` (pure advance), `is_start`, media refs, geo (display), rich text blocks (Main, Place, Question prompt, Gift text, Hint text).
- Every step exactly one primary (invariant).
- Linear ordered seq.
- Bundle serializes the above (answers only for answer steps); player renders based on mode + flags; StepCompletion records `submitted_answer?` or `player_confirmed: bool` + local outcome.

**Exposed flaws (skeptical reading of the docs themselves):**
- **"No difference" physical is explicitly called out as risk** in 07_ and 03_ self-critique: "feels too trivial ('just tap done') and reduces the magic for location-based physical tasks." The proposal accepts it for v1 simplicity but the analysis task requires exposing that this may "kill atmosphere".
- **List-of-strings is minimal for offline but does not scale to "puzzle variety"** (04_ open questions + edges above). Rebus, counts, plaques are string-ish today; future richer content (media puzzles, interpretation) hits wall. Normalization deferred = author pain early.
- **Flags as "combinations" are underspecified and bloat-prone.** Docs say "plus optional 'has_hint', 'is_gift'..." but do not define valid combos or precedence (narrative that is also answer-required? physical gift terminal?). Constructor will need validation or authors will create invalid steps. Old 14 types were *at least* exhaustive (if messy) dispatch.
- **Still requires many special cases in player/constructor/render/sync.** Even with lean model, UI code will branch on mode + is_gift + is_video + is_terminal + has_hint + geo-present. This is the "taxonomy bloat" migrated into if/switch sprawl instead of 14 types. Maintainability win is questionable.
- **Loses old expressiveness without clear replacement.** Old per-Page_type slides allowed *different* confirmation chrome, error flows, music?, popup states, coin accrual hooks per historical content. Uniform + flags may force generic "one confirm modal for all physicals" (authoring faster? or less delightful?).
- **Offline + freeze amplifies any flaw:** If uniform physical or string-list is insufficient for a published quest's creative intent, that quest version is stuck for its players. No easy "this step is special physical-observation".
- **Authoring vs player experience tension:** Constructor "simple multiline" + flags is lean for internal team, but if real quests (556 steps across 21) used the 14 types' nuance, velocity or quality may suffer. (We lack the actual texts to count how many were questionnoanswer vs question vs gift etc.)
- **Compared to old mess:** Old was *worse* for maintenance (dupe types, 1163 WFs mostly UI state, answer_card as flag bag mutated imperatively, coin logic scattered across reusables + "steps_for_accruing_coins_", no offline). But it *worked* for the shipped quests. Current proposal is a *reaction* (ruthless simplify) that may over-correct.
- **Self-critique of docs:** The business docs already contain the seeds of skepticism (risks, "open questions", "self-critique" sections, "walk through 2-3 real quests... identify gaps"). The "current" is not presented as perfect; this task is to attack it harder.

In short: current is the "lean MVP" path chosen under constraints, but it inherits the "uniform may kill magic" and "list may not scale" problems while trading old's bloat for potential future flag-sprawl and loss of differentiation.

---

## 4. Variant 1: Current Lean (Discriminated Primary + Flags, Uniform Physical)

**Description (as specified):** Exactly the locked model in 01/03/04/08. GameStep discriminated by primary completion_mode. Supporting as orthogonal flags. Constructor: mode picker (Physical / Answer-required) + checkboxes for gift/hint/video/terminal + rich text areas + (if answer) multiline answers + geo + media. Player: if physical → render confirm button + optional note textarea + geo map button (if hint spent); if answer → input + submit + immediate local feedback (correct/wrong per snapshot list). Bundle: full steps; answers[] only present (or non-empty) for answer steps. StepCompletion: variant fields (player_confirmed or submitted_answer) + is_correct (local for answers) + coins_spent. Validation: physical always "correct" on confirm; answers = list.includes(normalized(submitted)) (simple initially).

**Deconstruct (edges):**
- Physical lie: accepted (trust).
- Undo: whole-attempt reset only.
- Synonyms/rebus: list + deferred norm; rebus treated as "author picks the string".
- Partial: no.
- Multiple paths: author duplicates content or accepts "any of list advances same".
- Future geo/photo: requires new mode or flag + model change (breaks frozen snapshots).
- Taxonomy: relies on author choosing correct primary + valid flag combo; no first-class "counting task" vs "touch task".
- Linear: forces serialization of any old conditional flows.

**Expose flaws:**
- Directly inherits the "reduces the magic" risk called out in source docs.
- "No difference" uniform confirmation is a *deliberate* simplification that may make all  physical steps (observation, action, counting-while-there, listening) feel identical in UI — contrary to "rich content" being the differentiator.
- Flag combinations can create nonsensical steps (physical + answers list present? narrative terminal that also requires answer?). No explicit taxonomy of valid kinds.
- List-of-strings is "simple for offline" but the edges (numeric ranges, visual rebuses needing interpretation, fuzzy match) are punted; client match code becomes the permanent source of truth per version.
- Still branches in render/validation code on the flags → potential for the same complexity the 14 Page_types caused, just centralized.
- Maintainability gain over old: yes (one model vs 14 slides + 100s WFs), but readability for future devs: "what does a physical-gift-hint step look like in player?" requires tracing flag logic.
- Vs locked: complies perfectly (by definition). But the task requires exposing that compliance may be insufficient for "real content needs".

**Rebuild sketch (conceptual, for this variant):**
```ts
type GameStep = {
  id: string; position: number;
  primary: 'physical' | 'answer_required';
  // supporting
  is_gift?: boolean; gift_coins?: number;
  has_hint?: boolean; hint_cost_coins?: number; hint_text?: string; hint_image?: MediaRef;
  is_video?: boolean; video_ref?: MediaRef;
  is_terminal?: boolean; is_start?: boolean;
  // content
  title: string; main_text: string; place_text?: string; button_text?: string;
  geo?: {lat:number; lng:number}; // display only
  media?: MediaRef[];
  acceptable_answers?: string[]; // only for 'answer_required'; else absent/empty
  // author-only
  internal_notes?: string;
};
type StepCompletion = {
  step_id: string; attempt_id: string; version: string;
  player_confirmed?: boolean; // physical
  submitted_answer?: string; // answer
  is_correct: boolean; // local truth for this snapshot
  coins_spent: number;
  player_note?: string; // optional for physical
  completed_at: Date;
};
```
Player dispatch: `if (step.primary === 'physical') <ConfirmButton onPress={confirm} /> else <AnswerInput onSubmit={matchAgainst(step.acceptable_answers)} />`. Constructor multiline for answers only shown if answer mode.

**Self-critique:** This is the "do the minimum under constraints" variant. It is *correct* w.r.t. locked decisions and v1 cuts (no photo, no branching, simple offline). But it may be *insufficiently expressive* for the very quests that motivated the 14 Page_types (which existed because uniform was not enough historically). Readability: better than 1163 WFs, but the "flags" section will grow comments listing "valid combinations". Extensibility cost: adding "photo proof physical" later means either (a) new primary (breaking "lean"), (b) flag + conditional in confirm (bloat), or (c) new rule system (see variants 3/4). For 21 quests / 556 steps it may be "good enough" if most physicals were already similar. But the analysis must remain skeptical: "no difference" was chosen partly because "we do not need subtypes" (08_), but the task asks to question whether that assumption holds when walking real content (which we cannot fully, due to missing exports).

---

## 5. Variant 2: Richer Step Kinds as First-Class (Separate Behaviors Even if YAGNI)

**Description:** Make the "supporting" + nuances first-class *kinds* (or sub-kinds) in the discriminator. GameStep.kind: 'narrative' | 'physical_observation' | 'physical_action' | 'counting_task' | 'knowledge_question' | 'puzzle_rebus' | 'gift' | 'media_video' | 'terminal' | 'hint_reveal' | 'start' | 'greetings' | 'error' | ... (inspired directly by the 14 old values + edges). Physicals split by intent (observation vs action vs counting-while-present). Answers split by puzzle type (knowledge vs rebus vs count) to allow future type-specific matching (e.g., numeric tolerance for counts). Each kind carries its own completion rule implicitly (or small params). Flags reduced or eliminated (kind implies giftable? or still allow gift overlay on any). Constructor: dropdown of rich kinds (with descriptions/examples); kind-specific form sections (e.g., "counting_task" shows "tolerance?" later). Player: kind-specific UI chrome (different confirm language for "I observed" vs "I touched and felt", different input hints for rebus "enter the word this represents"). Bundle: kind + kind-specific data. StepCompletion: kind-tagged or still uses primary for validation. Offline: client has per-kind matcher (but strings for most).

This is "richer taxonomy now to avoid future bloat and preserve atmosphere".

**Deconstruct (edges):**
- Physical lie / undo / multi: same as current, plus now different physical *kinds* may have different "honesty weight" in future (action kind could later require photo more easily).
- Rebus vs knowledge: explicit kind lets author signal "this is interpretive" vs "this is factual plaque"; future matcher can differ (e.g., rebus kind accepts fuzzy or author-provided explanation field).
- Counting: kind can carry "min/max" or "exact list" later without polluting answer list.
- Synonyms still list-based inside the kind.
- Linear: same pressure.
- "Namerequest" / special: first-class or map to 'greetings' + name capture (if still needed).
- Old style/video/gift: first-class.

**Expose flaws:**
- **Taxonomy bloat risk returns immediately.** 14 old types were "messy but expressive"; choosing 12-15 new first-class kinds recreates the maintenance surface (per-kind renderers, per-kind constructor panels, per-kind migration from old Page_type, tests). YAGNI warning in task itself.
- **Over-engineering for v1.** Locked is "uniform physical, list answers simple". Introducing counting_task etc. violates "supporting behaviors as flags" direction and "lean" for MVP. Constructor more complex (authors must learn taxonomy instead of "pick physical or answer + gift?").
- **Still doesn't solve all edges.** A "rebus" kind with string list doesn't magically handle "non-string rebus" or partial credit unless we add *more* fields per kind.
- **Migration / data model churn:** Every new kind is a new case in all code paths. Old 14 types already showed the cost (specialized slides with varying WF counts).
- **Authoring velocity:** More choices = slower for internal team? Or better guidance?
- **Vs constraints:** Can be made compliant (map physical_* → physical confirmation; *_question/*_rebus → answer list), but adds weight the locked decisions tried to cut.
- **Future:** Good for extensibility (add 'photo_physical' kind later without flag hell), but at cost of bloat now.

**Rebuild sketch:**
```ts
type StepKind =
  | { kind: 'physical_observation'; confirm_label?: string; requires_action_note?: boolean; }
  | { kind: 'physical_action'; action_description: string; confirm_label: string; }
  | { kind: 'counting_task'; prompt: string; acceptable: string[]; tolerance?: number; } // future
  | { kind: 'knowledge_question' | 'puzzle_rebus'; acceptable: string[]; match_mode?: 'exact'|'contains'; }
  | { kind: 'narrative' | 'gift'; gift_coins?: number; ... }
  | { kind: 'media_video' | 'terminal' | ... };
type GameStep = { ..., kind: StepKind, ... }; // no separate primary; kind implies completion
```
Render: exhaustive switch on kind (or visitor). Validation: kind-specific function.

**Self-critique:** This directly attacks the "uniform may kill atmosphere" and "list may not scale" by giving first-class homes to the nuances the old 14 types tried to capture (questionnoanswer → physical_action or physical_observation; question/question0 split perhaps into knowledge vs rebus). It is *more honest* about real quest content variety. However, it risks recreating the old Page_type sprawl in a typed enum + discriminated union (still better than 14 separate tables/elements, but the "rich" part may be YAGNI for the 21 quests that shipped). Implementation cost higher for v1 (more UI branches in constructor/player). Readability: excellent if kinds are well-named and documented; poor if kinds proliferate. Offline: still works (kinds that need lists carry them; confirmation kinds don't). Best if we had counted real usage of each old Page_type (e.g., how many questionnoanswer vs pure lead). Without that, adding kinds is speculative. Still requires strategy for invalid combos (can a 'gift' be a 'physical_action'?). Extreme skepticism: this may be "premature classification" — the 14 types were accidental; a clean 5-6 might suffice.

---

## 6. Variant 3: Content-Driven with Embedded Rules (Steps are Rich Content + Optional "CompletionRule" Object)

**Description:** Minimize the discriminator on GameStep itself. GameStep is mostly *content container* (title, main_text, place, media, geo, hint_block, gift_block, button_variants, author_notes). Completion semantics live in an embedded `completion_rule?: CompletionRule` (polymorphic / discriminated):
- `ConfirmationRule` { type: 'confirmation'; optional_note: boolean; trust_player: true; }
- `AnswerListRule` { type: 'answer_list'; acceptable: string[]; match_strategy: 'membership' | 'contains' | ...; }
- `AlwaysAdvanceRule` { type: 'narrative'; } (or implicit if no rule)
- Future: `PhotoProofRule`, `NumericRangeRule { min, max }`, `MultiPartRule`, `TimeSpentRule`, `LocationProximityRule` (even if v1 doesn't use).
- Or `NoRule` / implicit for pure media/gift/terminal (advance only).
Gifts/hints/media/terminal are *content sections* that can co-occur with a rule (or rule can be on a "gift step" that also has confirmation? rare). Constructor: rich content editor + optional "completion rule" picker (with sensible defaults: no rule → narrative/advance; pick "require confirmation" or "require answer list"). Player: if rule present, render appropriate completion control(s) after/beside the rich content; else just "continue". Bundle: content + serialized rule (answers inside AnswerListRule). StepCompletion: depends on rule type (confirmed or submitted + outcome). This is "content first; rules as data".

**Deconstruct (edges):**
- Physical lie: ConfirmationRule explicitly encodes "trust_player: true" (documented, versioned per step).
- Undo: rule can influence (but still attempt-level probably).
- Rebus / counting / future: new rule subtypes (NumericRangeRule, InterpretiveRebusRule {acceptable + author_hint}) without changing GameStep shape much. List becomes one rule impl.
- Synonyms/partial: AnswerListRule carries the list + (later) norm flags or fuzzy.
- Multiple paths: still linear, but a rule could be "any of several sub-answers".
- Uniform vs expressive: authors attach the *minimal* rule needed; rich content (different descriptions, images, "feel the cold") provides the atmosphere differentiation. No "no difference" problem because every physical confirmation step can have unique surrounding content + custom button labels.
- Old special types (namerequest, style): map to content + no-rule or special rule; or small set of rules.
- Linear: same.

**Expose flaws:**
- **Rule objects add indirection/complexity.** "Simple" model in current docs becomes "step + optional rule union". Serialization for bundles, validation of rule+content combos, UI for attaching rules in constructor — all cost. Risk of "empty rule" or "rule on narrative that shouldn't have one".
- **Still needs a primary-ish dispatch.** Render code does `if (!rule) { advance } else if (rule.type==='confirmation') ... else if (rule.type==='answer_list')...` — same branching as flags or kinds, just in rule space. Could be more or less readable.
- **YAGNI for rules beyond the two.** If v1 only ever uses ConfirmationRule and AnswerListRule (per locked), the polymorphic object is overkill vs simple mode field + answers list (current). Future rules (photo, range) can be added as new rule types later without breaking old steps.
- **Authoring:** More powerful (attach "confirmation" to a step that also has gift content), but more decisions for author ("does this step need a rule? which?"). Old Page_type was "pick one thing"; this is "build content then decorate with rule".
- **Vs locked + offline:** Fully compliant (ConfirmationRule for physicals = uniform confirm + trust; AnswerListRule = list strings + client match). But the "embedded rules" framing may feel heavier than the "two primary modes" the decisions explicitly chose.
- **Maintainability:** Rules are extensible (new rule type = new matcher fn + new constructor panel + new player control). Central place for completion logic. Better than old scattered WFs. But more types to maintain than lean mode+flags.
- **Data evolution:** Adding a field to ConfirmationRule (e.g. future "require_photo: bool") affects only steps using that rule; old snapshots fine.

**Rebuild sketch:**
```ts
type CompletionRule =
  | { type: 'confirmation'; allow_note: boolean; /* locked trust implicit */ }
  | { type: 'answer_list'; acceptable: string[]; /* client match details */ }
  | { type: 'always_advance' }
  | { type: 'numeric_range'; min: number; max: number; } // future, still string? or number in bundle
  // ...
type GameStep = {
  id; position;
  // rich content (almost everything)
  title; main_text; place_text; button_confirm_text; button_advance_text;
  media: MediaRef[]; video?: MediaRef; hint?: {cost: number; content: ...; geo_reveal: ...};
  gift?: {coins: number; text: string};
  geo?: Geo; // display
  // the semantics
  completion_rule?: CompletionRule; // absent = pure narrative/advance/media/terminal flavor
  is_terminal?: boolean; // or derived from content + rule
  // ...
};
```
In player: render all rich content first → then render control dictated by rule (or default continue). Validation fn: `validate(step.completion_rule, input)`. Bundle includes the rule objects (answers inside).

**Self-critique:** This is elegant and "content-driven" — directly addresses "no difference may kill atmosphere" because the *content* (unique statue description + custom confirm button text "I felt the cold metal hands") differentiates every confirmation step; the rule is just "this one needs explicit confirm, trust the player". It scales better to puzzle variety (swap in a NumericRangeRule or future PhotoRule without new primary mode). It is *closer to "old was expressive" without the 14-type bloat* (rules are few, content is rich, no per-type slides). However, it may be *too abstract* for the lean v1 mandate and the explicit "two primary modes" language in decisions. Constructor UI must make the rule attachment feel natural and default correctly (most steps probably get a rule or none). Risk: rule sprawl if not disciplined (but better than Page_type sprawl because rules are small data, not full UI components + 21 WFs). Offline fidelity high (rule travels with snapshot). For the locked "uniform physical": a ConfirmationRule *is* the uniform (with params for note), but authors don't feel it as "no difference" because their content makes it different. This variant improves on current lean by making the "why this step requires confirmation vs answer" a first-class attachable thing rather than a mode that forces uniformity. Still, for pure MVP where only two rules will ever be used, the extra object may be unnecessary ceremony. Skepticism: without real step data showing how many old pages used "questionnoanswer" vs "question" vs pure "lead" (no rule), we can't know if the power is warranted.

---

## 7. Variant 4: Strategy / Behavior Composition Pattern per Step (Designed Alternative)

**Description (my design, grounded in SOLID + the observed old pain):** Treat completion/validation as *pluggable strategy* objects (or functions/behaviors) composed onto the step, but keep the step itself as rich content + minimal flags. 

- GameStep has `content: RichContent`, `behaviors: StepBehavior[]` (array or set of composable behaviors for flexibility).
- Or cleaner: `completion_behavior: CompletionBehavior` (strategy ref or embedded) + supporting behaviors as small flags or separate `supporting_behaviors: SupportingBehavior[]`.
- `CompletionBehavior` is a strategy: interface with `getCompletionUIHints()`, `validate(input, stepSnapshot): {is_correct, feedback}`, `requiresAnswerList(): boolean`, `isConfirmationOnly(): boolean`, `getOfflineMatchFn()` etc. Serialized as type + config (e.g. {type: 'AnswerListStrategy', config: {acceptable: [...]}} ).
- Supporting (gift, hint, media, terminal) as *additive behaviors* that can attach to any (or most) completion behaviors. E.g., a physical confirmation step can have a GiftBehavior attached (award on confirm).
- In code (player, constructor, bundle, sync): the strategy object (or registry by type) encapsulates the differences. No giant switch in player; `step.completion_behavior.executeConfirm(...)` or `step.completion_behavior.render()`.
- For old 14 types migration: each Page_type maps to a specific behavior combo (questionnoanswer → ConfirmationBehavior + no answer list; question → AnswerListBehavior; gift → GiftBehavior on top of lead or confirmation; etc.).
- Constructor: content editor + "completion strategy" selector (Confirmation (uniform), Answer List, Advance Only, ...) + "add supporting behaviors" (multi-select or chips for gift/hint/video/terminal, with validation that gift requires a trigger behavior).
- This is "strategy pattern at the conceptual/domain model level" for validation/completion (plus composition for supporting).

**Deconstruct (edges):**
- All prior edges: handled by choosing/parameterizing the right strategy (ConfirmationStrategy {trust: true, note: optional}, AnswerListStrategy {list, match: 'simple_membership'}, future NumericStrategy, ProximityStrategy (for geo future), etc.).
- Rebus non-string: a InterpretiveStrategy or custom per-quest? (but keep simple; or note that strategies are for *validation*, content carries the puzzle).
- Undo / lie: strategy can influence completion record shape.
- Multiple valid: strategy config can hold the list or rules.
- Linear: unchanged.
- Old special (namerequest): NameCaptureBehavior (supporting or completion).

**Expose flaws:**
- **Conceptual overhead for a v1 lean system.** Strategy pattern is powerful (decouples, open for extension — add new strategy impl without changing GameStep or most code), but requires more upfront design (behavior registry, serialization of strategies, ensuring strategies are pure data for bundles/offline, testing each). May be "architecture astronaut" for internal team building 21 quests.
- **Runtime vs data:** If strategies are classes in code, the "what this step does" is partly in the deployed client binary, not purely in the quest snapshot. For frozen versions this is ok (player that downloaded vN has the strategies that vN steps expect), but complicates "replay old attempt exactly". Better if strategies are pure data/config (as in variant 3).
- **Still needs the two locked primitives.** ConfirmationStrategy and AnswerListStrategy will be 90% of usage. The generality may not pay off immediately.
- **Composition complexity:** Behaviors array can have conflicts (two completion behaviors? gift without trigger?). Needs invariants + constructor guards. Old mess had implicit "one Page_type" which at least prevented some invalid states.
- **Readability for non-engineers (authors):** "Attach AnswerListStrategy" sounds more intimidating than "this is an Answer-required step". Internal team may prefer the simple mode/flags of current.
- **Vs current proposal:** More flexible and future-proof than lean flags (no flag explosion; new completion need = new strategy data shape + handler). More contained than first-class kinds (no enum bloat; strategies are few + config).
- **Offline:** Strategies must be implementable client-side from snapshot data only (yes for the locked ones; future geo proximity harder offline).
- **Maintainability win over old:** Huge — instead of 14 hardcoded slides + WFs, you have a small set of strategy handlers + content-driven render. Adding a "future physical with optional photo" = new strategy config + one handler, not a new Slide_PhotoPhysical + 15 WFs.

**Rebuild sketch:**
```ts
// Conceptual (data shapes for model + bundle)
type CompletionStrategy =
  | { name: 'confirmation'; config: { allow_note: boolean; /* trust implicit */ } }
  | { name: 'answer_list'; config: { acceptable: string[]; match: 'membership' } }
  | { name: 'advance_only'; config: {} };
type SupportingBehavior =
  | { name: 'gift'; config: { coins: number; reveal_text: string } }
  | { name: 'hint'; config: { cost: number; ... } }
  | { name: 'media'; config: { refs: MediaRef[] } }
  | { name: 'terminal'; config: { show_review: boolean } };
type GameStep = {
  ...rich content...,
  completion_strategy: CompletionStrategy; // required or default
  supporting_behaviors: SupportingBehavior[]; // 0+
};
```
Player: `const strat = getStrategyImpl(step.completion_strategy.name); strat.renderUI(step, onComplete);` + `if (supporting...) attachGiftFlow(...)`. Validation and bundle serialization delegate to the named strategy's config + shared fns. Constructor: strategy picker populates the config form dynamically.

**Self-critique:** This is my preferred "engineer" solution because it directly solves the observed historical failure mode (overloaded Page_type → specialized everything → 1163 WFs of state + mutation) by making *behavior* pluggable data + small handler code, while keeping content rich and central. It handles the "taxonomy bloat vs oversimplification" by starting minimal (only the two locked strategies + common supporting) and *extending by adding strategy configs*, not by adding 10 more kinds or 10 more flags. Atmosphere preserved via rich per-step content + strategy-specific UI hints (different confirm labels per confirmation step via content or small config). For edges: future "photo physical" = new strategy name + config {require_photo: true} + handler that knows to capture/upload (when allowed); old snapshots unaffected. Offline: the strategy name + config are in the snapshot; client must ship handlers for all strategies that existed at publish time of any supported version (versioned handlers or compatibility layer). 

Flaws remain: added abstraction may slow initial implementation (need strategy registry, UI for dynamic forms in constructor); authors may not need the power; composition validation is real work. Compared to variant 3 (embedded rules): very similar (rules ~ strategies); the "strategy" framing emphasizes *behavioral variation and pluggability* (good for the "supporting step types" part of task) and maps cleanly to code (Strategy pattern). Vs current lean: more maintainable long-term because new requirements don't mutate the core GameStep shape or explode flags. Vs richer kinds: avoids the fixed taxonomy. Extreme skepticism on this variant: it is the most "future-proof" but may be the *least* aligned with the explicit "lean", "two primary modes", "supporting as flags" language chosen in the decisions log after adversarial process. Introducing strategies now could be seen as second-guessing the locked choices. For v1, the implementation cost of the pattern (even conceptually) may exceed the benefit if 80%+ of steps are simple physical-confirm or answer-list + gift/hint. Without counts of real Page_type usage from the 556, it's hard to justify the extra layer.

---

## 8. Edge Case Handling Matrix

| Edge Case | Current Lean (V1: mode + flags, uniform physical) | Richer Kinds (V2) | Content + Embedded Rules (V3) | Strategy/Composition (V4) | Notes / Locked Impact |
|-----------|---------------------------------------------------|-------------------|-------------------------------|---------------------------|-----------------------|
| Player lies about physical action | Accepted (trust); no diff in model | Same + kind may signal "action" vs "observe" for future weighting | ConfirmationRule explicitly {trust:true}; content can warn | ConfirmationStrategy {trust:true}; pluggable later | Locked: trust honesty. Old answer_card had Complited flag anyway. |
| Undo after confirm | Whole attempt reset only (03_) | Same | Same (rule doesn't change reset scope) | Same | Harsh for long quests; no per-step undo in any. |
| Multi-player / shared confirm | Not supported (single attempts) | Same | Same | Same | Future; composition in V4 could allow shared behaviors. |
| Location verification (future geo) | Geo display only; confirm always allowed offline | New 'proximity_physical' kind later | New ProximityRule later (affects only new steps) | New ProximityStrategy + config (lat/lng/radius) | Locked v1: display only. All variants need model change for enforcement; V3/V4 localize the change best. |
| Synonyms / case / Russian variants | List + deferred normalization; brittle early | Kind-specific (e.g. knowledge_question can have norm flags) | AnswerListRule carries list + later norm config | AnswerListStrategy config + norm | Client match = source of truth per snapshot (08_). Analytics critical. |
| Rebus / visual puzzle (not pure string) | Treated as string list entry chosen by author | Dedicated 'puzzle_rebus' kind (signals intent) | AnswerListRule or future InterpretiveRule | RebusStrategy or AnswerList + content | List works for today; none solve "author must anticipate all interpretations". |
| Partial credit / multi-part | All-or-nothing; wrong count | Kind can have scoring later | Rule can evolve to {type:'multi_part', parts: [...] } | Strategy with partial result | Not in v1 any variant. Old had Count_wrong_answers aggregate. |
| Numeric range / tolerance (counting) | Enumerate strings or fail | 'counting_task' kind with tolerance field | NumericRangeRule {min,max} | NumericStrategy config | List-of-strings poor fit; V2-4 handle without changing core. |
| Multiple valid paths (different experiences) | Any-of-list advances same; linear duplication | Kinds don't solve linear | Rules don't solve linear | Same | Linear decision (08_) is the constraint; all suffer. Old Next_page may have helped. |
| "No difference" kills atmosphere for physicals | Direct problem (uniform confirm) | Mitigated (different kinds have different labels/UI hints) | Mitigated (rich content + custom button per step + rule just says "needs confirm") | Mitigated (strategy can provide UI hints; content dominates) | Key risk in 07_/03_. V1-3/4 better than pure uniform. |
| Invalid combo (physical + answer list) | Possible via flags; needs runtime guards | Kinds are mutually exclusive by design | Rule + content; constructor can prevent (only one completion rule) | Strategies: enforce single completion strategy | Old Page_type prevented by being single value. |
| Version freeze of bad rule/answers | Any model: frozen per snapshot for old attempts | Same | Same (rule object frozen) | Same | Locked decision (08_). Analytics on submissions help authors. |
| Client match bug affects recorded is_correct | Yes (answers); physical always "correct" | Same | Same | Same | 03_ risk accepted. |
| Namerequest / special flows | Flag or special is_start + content | First-class 'name_request' kind (if needed) | Content + special rule or no-rule + capture field | NameCaptureBehavior | Open in 07_. V2/V4 make it cheap to add or drop. |
| Gift coin award on confirm vs on advance | Flag is_gift on any primary | Gift kind or overlay on other kind | Gift content block + any rule (award on rule complete) | GiftBehavior composed on completion strategy | Old: Gift_Coins on page_constructor + scattered accrual logic. All variants centralize better. |
| Pure media / video / terminal with no "task" | Narrative flag or no primary? | Dedicated kinds | No rule = advance; content provides flavor | advance_only strategy + supporting media/terminal | Old had dedicated video/congratulations/screenafterquest. |
| Branching / conditional next (old Next_page) | Not supported (linear) | Same | Same | Same | Explicit cut (08_). All variants defer. |
| Replay after physical done | Same content/rules; "I already touched it" feels odd | Same | Same | Same | Replay is feature (06_). Content can say "re-experience". |

**Matrix summary:** Current lean handles locked cases cleanly but exposes the atmosphere and scaling risks most directly. V2 adds taxonomy cost. V3 and V4 localize future extensions (new rules/strategies) and let rich content carry differentiation, at the price of one level of indirection. No variant fully escapes linear or honesty-trust constraints.

---

## 9. Recommendation Under Constraints

**Recommended: Hybrid of Variant 3 (Content + Embedded Rules) with light Strategy flavor (Variant 4), implemented as "lean primary rule types + rich content + small composable supporting behaviors".** Concretely for v1:

- Keep GameStep shape close to current proposal (for minimal delta from locked decisions).
- But reframe internally as: rich content blocks are primary; `completion_rule: ConfirmationRule | AnswerListRule | null` (embedded, small discriminated union — not full polymorphic object hell).
- Supporting: `supporting: { gift?: GiftConfig, hint?: HintConfig, media?: ..., terminal?: boolean, ... }` (object or small array; validated in constructor).
- No first-class "kinds" enum beyond the two rules (respects "uniform physical" + "list answers" locked).
- In model/docs/code: document that the *content* (unique Main_text, Place, custom Button_text, images, "feel the cold metal") is what differentiates physical confirmation steps — the rule is just the *mechanism* ("this step requires explicit player honesty confirm").
- For future: adding `NumericRangeRule` or `PhotoConfirmationRule` (post v1) is a new discriminated case in the union + one handler + one constructor panel. No change to "physical" concept.
- Constructor defaults: "Add step" → narrative (no rule) or author immediately picks "Physical task (confirm)" (→ ConfirmationRule) or "Answer / puzzle (list)" (→ AnswerListRule) + optional gift/hint toggles.
- Player: content always renders; rule (if present) dictates the completion control appended.
- This satisfies *all locked* (ConfirmationRule = uniform confirm, no answers list, trust; AnswerListRule = list strings, client match; flags/combos for supporting; linear).
- Improves on pure current lean: makes the "why uniform feels same" problem *author's content problem* (they control text/button), not a model limitation; prepares the shape for the edges without overcommitting taxonomy now.
- Improves on old 14 Page_type mess: one content container + tiny rule objects (data, not 14 full custom elements + 3-21 WFs each) + centralized handlers instead of scattered mutations and state machines. 556 steps become instances of the same shape; migration maps old Page_type + presence/absence of Answers + Gift_Coins → rule + supporting.
- Why not pure V2: avoids recreating taxonomy bloat immediately (only add kinds if usage data from real 21 quests shows the 14 types were all heavily used differently).
- Why not pure V1 current: because the source docs *already flag* the triviality risk, and the task requires variants that address "physical with optional photo proof even if YAGNI", "puzzle/rebus", "taxonomy bloat vs oversimplification".
- Why V3/V4 flavor: strategy/embedded rules give the "pluggable completion semantics" without forcing authors or code to choose among 10+ kinds upfront. Composition for gift/hint (which old attached to many Page_types) is natural.
- Constraints respected: no photo/geofence now (those would be future rule/strategy); list simple for offline (inside AnswerListRule); physical confirmation-only.

**Justification (maintainability / readability / vs old + current):**
- **Over old Page_type mess:** Old was 14 values on the same record driving completely different UI components, workflows, states, and mutations (answer_card flags bag, coin accrual in multiple places, 1163 mostly imperative WFs). Result: unreadable, unmaintainable, no offline/versioning story. New: single GameStep concept (as in 01_), completion semantics as small attached data (rules), rich content as the variable part. Dispatch is small + centralized. Adding a new completion nuance costs 1 rule variant + handler, not a new Slide_* + 10 WFs + state pollution.
- **Over pure current lean:** The "primary mode + flags" is a good starting point but, as critiqued, risks flag sprawl and "everything physical is the same button" in the player's mind (even if content differs). Embedded rule makes the *semantics* explicit and versionable per step ("this step used ConfirmationRule v1 with note=true"), which is valuable under snapshot freezing. Rich content emphasis protects atmosphere without violating uniform mechanism.
- **Readability:** A step JSON with `completion_rule: {type: 'confirmation', allow_note: true}` + 200 chars of statue story text is self-documenting. Authors see "this is a confirmation step" in constructor. Devs see the rule drives the completion path.
- **Maintainability:** Fewer invalid states (constructor enforces one completion rule); easier testing (test each rule type + supporting combos); easier evolution (new rule doesn't touch existing steps' data); better analytics (record which rule type was used per completion).
- **Player/Offline:** Identical to current for locked cases. Client match code lives with AnswerListRule impl. Physical confirm is always the same trust mechanism.
- **Authoring for internal team:** Still lean (pick rule type or none; toggle gift/hint). More guidance than raw flags.
- **Risks accepted in rec:** Slight increase in model complexity vs pure "two modes" (one extra union type). If real usage is 95% simple cases, the rule object is mild ceremony. Still no branching, still trust for physical, still list strings. Must document valid rule+supporting combos rigorously.
- **When to revisit:** After importing or manually walking 2-3 real quests' 556 steps (export the page_constructor data!). If >20% of physicals had meaningfully different "feels" or answer steps used non-string patterns, lean harder into V2 or full strategies. If most were uniform, pure lean (V1) suffices and this hybrid is overkill.

This recommendation is the *least-bad* survivor of the adversarial cycle under the explicit constraints. It does not claim perfection.

---

## 10. Self-Critique of This Entire Analysis + Recommendation

- **I may have over-weighted "atmosphere" and "future puzzle variety".** The locked decisions and v1 cuts (no photo, linear, simple list, trust, ~5MB, internal authors only) were made *after* adversarial process precisely to ship. If the 21 quests succeeded with the old overloaded types, a simplified uniform + list may be perfectly adequate for players; the "magic" came from the *real locations and stories*, not the Page_type chrome. The task forced 3+ variants + deconstruct, so I did — but the rec could be "stick with current lean + better docs on using rich content for differentiation".
- **Lack of real step data is a weakness in the analysis.** I used the "Mystery of the Fortress" example from the business docs + schema + element counts + old slide names. Without the actual 556 records (Answers lists, Gift_Coins values, Page_type distribution, Main_text examples, how many used Next_page non-linearly), claims about "real content needs" or "how many were questionnoanswer" are inferences. A follow-up subtask should be "export 3 full quests' page_constructor rows and walk them".
- **Variants 3 and 4 are similar.** I distinguished them (embedded data rule vs pluggable strategy with composition), but in practice the implementation would converge. This is ok — the point was to explore "content-driven" and "strategy" as distinct lenses.
- **"Improves maintainability" is a claim that must be tested in code.** The report argues it from first principles and old pain points (1163 WFs, dupe types, scattered logic). Actual Rust/Next.js (or whatever) implementation + constructor forms + player components will reveal if the rule/strategy layer adds more cognitive load than it saves. The old system "worked" despite mess because Bubble hid some wiring.
- **Skepticism on my own rec:** Even the hybrid adds a layer. If the team is small and internal, the absolute simplest (current lean, or even a single "step" with answers optional + a "requires_confirmation" bool) might have highest velocity. The matrix shows no variant is flawless on all edges. Recommendation is "best under constraints" not "objectively best".
- **Other un-attacked assumptions:** "Rich content" will be sufficient differentiator. Authors will use the constructor (vs spreadsheet import, per 04_ self-critique). 5MB + PWA works for the media in real quests. Coin gift mechanics (extracted from old) won't need per-step rule changes.
- **Process strength:** This report follows the mandated cycle (deconstruct/expose/rebuild/self-critique per variant, matrix, rec with why vs old/current, max documentation, extreme skepticism, ground in all specified sources + discovery). It does not soften critiques.

---

## 11. Migration / Implementation Notes (for follow-on work)

- Old `page_type` → new rule:
  - `questionnoanswer` → ConfirmationRule (physical).
  - `question` / `question0` → AnswerListRule (take the `Answers` list).
  - `gift` / `congratulations` / `screenafterquest` → supporting gift/terminal + appropriate rule or null.
  - `lead` / `start` / `greetings` / `video` / `style` / `hint` / `error` / `namerequest` → narrative or supporting; map namerequest to open question (content capture?).
- `Gift_Coins` → gift config inside supporting.
- `Answers` list → inside AnswerListRule (or absent).
- `Hint` self-ref + Buy_hint → has_hint + hint config (geo reveal separate?).
- `Next_page` → position/order (linearize; detect cycles/conditionals for migration warnings).
- answer_card history → StepCompletion records (reconstruct from flags + submitted if available; version them to the quest snapshot at time).
- Old coin accrual (You_made_it, steps_for_accruing_coins_, Getting_5_coins...) → centralized on gift completion + quest completion events (per 08_ decision).
- In constructor: start with current lean forms; evolve the "rule picker" UI from mode radio.
- Player: keep uniform confirmation for ConfirmationRule steps; use content for labels.
- Bundle + offline: rules serialize cleanly (no code, just data + the list for answers).
- Tests: per-rule validation + combo invariants; snapshot version tests (old frozen rules still work).

---

**Report path:** `business/analysis/gamestep-completion-variants.md` (this file).  
**Status:** COMPLETE. (Full adversarial cycle executed with multiple tool-assisted explorations of business/01/03/04/06/07/08/09, discovery/parsed/option_sets/data_types/element_definitions/workflows_*/record_counts, docs/ overviews. No raw step content rows available — noted as limitation. Extreme skepticism applied throughout; recommendation is the least-bad that respects all locked constraints while addressing the task's required variants, edges, and "why improves over old mess and current proposal". Ready for review + real quest data walk-through.)

**Next recommended actions (from this analysis):**  
1. Export actual page_constructor data for 2-3 representative quests (including one "fortress"-style physical heavy) to validate assumptions on Page_type distribution and answer patterns.  
2. Prototype the constructor step form for the recommended hybrid (rule + supporting) vs pure lean; get internal author feedback on feel.  
3. Define the exact client match algorithm (and any MVP normalization) for AnswerListRule and document it as part of the snapshot contract.  
4. Revisit this doc after first real quest is built in the new model.

This concludes ANALYZE-03. All claims traceable to the cited sources in the workspace.