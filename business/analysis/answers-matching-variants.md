# ANALYZE-08: Deep Adversarial Analysis of Acceptable Answers, Matching & Normalization (multiline list, simple client match now, future norm, rebus/puzzle support)

**Task ID:** ANALYZE-08  
**Role:** Specialized Chief Staff Engineer + Critical Analyst subagent  
**Date of analysis:** 2026-06-09  
**Status:** COMPLETE. Full adversarial cycle (deconstruct/expose/rebuild/self-critique per variant + matrix + rec + exhaustive docs) executed. Report written to mandated location.  

**Grounding sources (all local to workspace; no external assumptions; multiple search strategies used: broad list_dir + parallel greps on business/ + discovery/ + docs/ + scripts/ for "Answers|Answer|page_constructor|Page_type|question*|Slide_Question|addAnswerCard|correct_answer|list\.text|answer_card|acceptable|multiline|normali[sz]ation|match|membership|contains|rebus|puzzle|numeric.*toler|is_correct|client.*correct"; targeted read_file with offsets/limits on JSONs for exact schemas; cross-read of prior ANALYZE-01/03/05/07 reports + FINAL-BEST-PRACTICE-BLUEPRINT.md for synthesis context and to avoid duplication):**  
- `business/04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md` (primary: GameStep conceptual, `completion: { mode: 'physical' | 'answer'; acceptable?: string[]; ... }`, "list of acceptable strings (synonyms, numbers, phrases)", "simple multiline input (one acceptable per line)" in constructor, "Initial client matching: simple (exact match or membership in the list, possibly basic case-insensitive contains for MVP)", "Normalization (trim, case folding, punctuation removal, number canonicalization, synonym handling) is explicitly a later iteration.", "list may not scale to puzzle variety", "Mystery of the Fortress" physical example, old Page_type deprecation, "hard to publish bad" error proneness on multiline, publish snapshots exact serializable incl. answers list plainly, self-critique on preview/iteration).  
- `business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md` (locked: client fully validates offline against downloaded snapshot; "For answer-required steps: the list of acceptable answers (strings...) exactly as authored for that version."; "Initial client matching: simple (exact or 'contains' match; normalization rules added later)."; "plain strings (as entered by the admin for that version)"; "Because the client needs to validate fully offline, the acceptable answers must be present in usable form in the local snapshot. (Cheating model is deprioritized per direction for v1.)"; "No re-validation of correctness on sync. The server records what the player submitted and the local validation result for that version."; "client is the sole judge... If the client has a bug in matching, the server will happily record the wrong outcome."; "Analytics on 'what answers players actually submitted' becomes more valuable"; bundle ~5MB incl. answers; physical = no acceptable list, explicit confirm; version freeze per snapshot for old attempts; sync records submitted_answer + is_correct (client) + ...).  
- `business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md` (GameStep: "completion: { mode: 'physical' | 'answer'; acceptable?: string[]; allow_note?: boolean }"; "'answer': player submits value; client matches against `acceptable` list (multiline input in constructor; simple membership initially, normalization later)."; invariants: exactly one primary mode, all data (incl. acceptable list) frozen in snapshot; "Open Modeling Questions: Exact representation of 'acceptable answers' for Question steps (exact match? normalized? multiple correct? regex? puzzle-specific?)."; old page/page_constructor duplication + 36-field multilingual + 14-type mess rejected; StepCompletion records submitted value for answers).  
- `business/08_DECISIONS_LOG.md` (locked: "For answer-required steps, authors provide a list of acceptable strings ... via a simple multiline input in the constructor (one value per line). Client does basic membership / matching against the list from the local snapshot. Advanced normalization is deferred."; "Client fully validates... no re-validation... The client implementation of matching becomes the source of truth for recorded outcomes on that version."; "Analytics on submitted answers per version becomes important"; physical no list; explicit publish for snapshots).  
- `business/07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md` (assumptions under attack: client local val + freeze; risks: "Frozen answers per snapshot... Client is the sole judge... Any bug in client matching logic permanently affects..."; "If we do not retain historical quest snapshots..."; open: "Precise definition of acceptable answers for the constructor (one string? list? normalization rules? support for numeric ranges or multiple puzzle solutions?)"; "What exact 'protected representation' of answers will be put into the downloadable bundle? (Hashed with what salt? Encrypted? Something else?)"; "When an answer is validated locally as correct but server says incorrect on sync (author changed the answer, or hash mismatch)..."; "Advanced anti-cheat or photo proof" cut for v1).  
- `business/06_V1_REQUIREMENTS_AND_CUT_LIST.md` (note drift/inconsistency vs locked: "Answer submission steps (with local feedback via protected answers + server re-validation on sync)."; "Any client-side only 'correct' that is never re-validated by server." cut; constructor musts: "list of acceptable answer strings"; "Advanced analytics, A/B testing of steps, heatmaps of wrong answers" as could-have; success: full offline play incl. "submitting answers"; risks if not: "Offline + server validation tension not resolved").  
- `business/09_WHY_THE_QUESTIONS.md`, `business/00_PRODUCT_VISION_AND_SCOPE.md`, `business/02_...`, `business/05_...`, `business/README.md`, `business/analysis/README.md`, `business/analysis/FINAL-BEST-PRACTICE-BLUEPRINT.md` (cross: synthesis already adopts `completion: { mode..., acceptable?: string[]... }` + "client membership match"; notes "list may not scale" mitigation via future numeric_range etc. without core mutation; "hashed acceptable sets" in recs for offline; constructor strengthening for answers entry; migration mapping old -> new; "plain list" as starting point but under scrutiny).  
- Discovery (exact per task prompt + exhaustive): `discovery/parsed/option_sets.json` (full 14-value page_type: "question", "question0", "questionnoanswer", "lead", "gift", "congratulations", "screenafterquest", "video", "hint", "error", "start", "greetings", "namerequest", "style"); `discovery/parsed/data_types.json` (page_constructor: 36 fields incl. "answer_for_exercise_list_text" name:"Answer" bubble_type:"list.text", "page_option_page_type" name:"Page_type", "gift_coins_number" "Gift_Coins", multilingual explosion (Main_text_RU/ENG/SRB, Place_*, Page_name_*, Button_text_*, Question_RU/ENG/SRB etc.), latitude/longitude, Image_link/Hint_Image/Video_link (file), Hint (self-ref page_constructor), Next_page (self-ref), Sample, Page_number, Answer_card (list.custom), Duration_*; duplicate "page" type also had "answers_list_text" name:"Answers" list.text + Page_type; answer_card type: count_wrong_answers_number, Complited/You_made_it flags etc.; 556 page_constructor records total from other counts); `discovery/parsed/element_definitions.json` (old UI: `Slide_Question` (12 workflows, custom_states: "music_", "errorstyle_", "open_error_", "showpopup4a_", "openbigimage_", "goingnextpage_", "openerrorhint_", "correct_answer_"), `Slide_Question_no_answer` (7 workflows, "help_", "showpopup4a_", "openbigimage_"); other Slides for lead/gift/video/congrats/error/hint with 3-21 WFs each; Edit_Page 55 WFs, Existing_Quest 63 WFs); `discovery/parsed/workflows_all.json` + `api_events.json` + `raw/workflow-api/probe_results.json` (old server: workflows/API "addAnswerCard", "create_answer_card_list", "deleteAnswerCard"; urls like /version-test/api/1.1/wf/addAnswerCard; events reference _wf_param_AnswerCard etc.; generate_docs.py flow: "InputChanged → validate → ChangeThing on Answer_card", "Submit answer → addAnswerCard API", "quest page → page_constructor data → answer cards"); `discovery/parsed/pages.json` + `record_counts.json` (21 quests, 556 pages/steps; heavy per-type dispatch); `discovery/scripts/generate_docs.py` (explicit extraction: Page types incl. question/questionnoanswer, fields "Answers, Page_type", addAnswerCard as answer tracking, old flow diagrams); `discovery/raw/data-api/probe_results.json` (404s on some answer_card etc. in probes, but schema mirrored).  
- Cross: `docs/02_DATA_MODEL.md`, `docs/05_WORKFLOWS_AND_BUSINESS_LOGIC.md`, `docs/10_MIGRATION_MAPPING.md` (legacy only: "Answers, Page_type", "Handle answers (InputChanged → validate → ChangeThing on Answer_card)", addAnswerCard mapping); no live app source (this workspace = business specs + discovery parses + prior analyses; implementation does not yet exist).  

**Locked constraints (must not contradict; re-attacked throughout):**  
- Physical / "no answer required" (maps to old questionnoanswer Page_type + Slide_Question_no_answer): no acceptable-answer list ever. Completion = explicit player confirmation ("I did it", "Found it") + optional short note. Uniform mechanism ("no difference" across physicals; rich surrounding content + custom button text/images provide differentiation). Trust player honesty. No digital proof/photo/geofence in v1 (explicit cut). Geo = display/map pin + "show on map" for coin-hint only.  
- Answer-required (maps to old question/question0 Page_type + Slide_Question with correct_answer_/errorstyle_ states): authors provide list of acceptable strings (synonyms, numbers, phrases) via **simple multiline input** ("one value per line") in constructor. Client does **basic membership / matching** (exact or "contains", case-insensitive?) against the list from the **local snapshot** for **full offline validation**. Advanced normalization (trim/case/punct/number/synonym) **explicitly deferred**.  
- All data (incl. acceptable list) **frozen in the quest snapshot/version at publish**. Old attempts bound to their snapshot's rules/answers forever. New attempts/downloads get latest published version.  
- Client performs **full local validation** against its downloaded bundle/snapshot. Server **records** submitted value + client-computed `is_correct` + ... on sync but performs **no re-validation or override of correctness**. (Note: 06_V1 contains contradictory language on "server re-validation on sync" and "cut any client-side only 'correct'"; this is attacked as drift/inconsistency below.)  
- Bundle (~5MB) serializes **plain acceptable strings** (exactly as authored) for answer steps + full GameStep content + version + integrity. Cheating model deprioritized for v1.  
- Constructor produces (or publish flow derives) the exact serializable GameStep shape. Linear sequence only (no branching v1). Supporting (gift/hint/media/terminal) additive/validated.  
- Old 14 Page_types + 36-field multilingual + dupe page/page_constructor + answer_card flag-bag + 1,163 WFs (esp. 55 on Edit_Page, 63 on Existing_Quest, 12/7 on Slides, scattered mutations) = accidental complexity / cautionary tale to ruthlessly simplify (not port). Old validation was server-side via addAnswerCard (assumed connectivity; mutated count_wrong_answers etc. on answer_card; no versions/offline/bundles).  
- Analytics on submitted (wrong) answers per version valuable for authors (to improve vN+1).  
- "Hard to publish bad" (dups, blanks, wrong lists, kind mismatches) is a hotspot (multiline + raw entry called out in 04/07).  

**Process (full cycle, per task + prior ANALYZE-03/07 style, max skepticism):** Start broad (list_dir + greps); narrow (targeted reads/greps on exact fields/states/workflows); deconstruct edges (prompt-specified + derived from discovery old flows + business self-critiques/risks/opens); expose flaws harshly in locked ("current lean") + old; define 4 variants (1 current lean, 2 hashes+receipt, 3 embedded matcher config+pluggable, 4 invention: author test cases + fuzzy); full cycle per variant (decon its edges, expose its flaws, rebuild conceptual sketch with explicit **data shape in GameStep**, **bundle contract**, **client contract**, **migration from old Answers/Answer list**, **test cases**); matrix (vs GAMSTEP physical/answer, offline bundle size, constructor entry multiline-vs-structured, analytics on wrong subs); recommend (must satisfy: offline client val, frozen in snapshot, simple for v1, extensible); self-critique of rec + entire analysis; status + path. Extreme skepticism: every claim attacked ("even if", "risk of", "why would authors..."); "improves X" claims tested against old pain (1163 WFs, mutable no-version, server-only, flag bags) and locked constraints; no softening; inconsistencies (e.g. 06 vs 03/08) called out. Parallel tool use throughout. Never broadened beyond answers/matching/normalization (touches GAMSTEP constructor offline only at intersection).  

No files created except the mandated report (write used only for explicit deliverable per task). All paths absolute.  

---

## 1. Realistic Examples (Grounded in Business + Discovery Artifacts)

Since full 556 page_constructor rows not exportable via probed API (types + counts + element defs present; content in live DB only; probes returned 404s for answer_card etc.), examples reconstructed from:

- Business explicit "Mystery of the Fortress" physical (questionnoanswer style): "go to X, find the object, optionally perform an action (touch the hands of the statue and feel the cold metal)". No Answers list. Geo + image + Main_text_RU describing action + custom Button_text_RU ("Я сделал это" / "Нашёл"). Old: page_constructor.Page_type=questionnoanswer, Answer=(absent or empty list.text), Gift_Coins=0?, Hint self-ref optional, Next_page for linear. Rendered via Slide_Question_no_answer (simpler states: help_/showpopup4a_/openbigimage_; no correct_answer_ or errorstyle_).
- Answer steps (question/question0): plaque text, count of windows/columns, rebus solution as string. page_constructor.Answer (list.text, e.g. ["42", "сорок два"], ["Александр III", "Александр 3"], ["ключ", "fortress key"] for visual rebus whose "solution" is a word). Old flow (generate_docs + api_events + element defs): load page_constructor seq → dispatch on Page_type → Slide_Question (12 WFs, states incl. correct_answer_, errorstyle_, openerrorhint_, goingnextpage_, music_?) → InputChanged → (client? state) → addAnswerCard API workflow (server validate against the Answer list on page_constructor, mutate answer_card: Count_wrong_answers++, Complited?, Buy_hint etc.) → conditional next. Server as truth; no bundle/offline/version. "question0" vs "question" perhaps variant (0-answers? or style).
- Gift/terminal on answer or physical: Gift_Coins on page_constructor + special Page_type or embedded; old "steps_for_accruing_coins_" reusable, Getting_5_coins_for_completing list on user, You_made_it / Complited_quest flags on answer_card.
- Narrative/lead: Page_type=lead, no Answer, simple advance.
- Other specials: namerequest (still open?), error (for wrong answers/guidance, 21 WFs on Slide_Error), video, start/greetings, congratulations/screenafterquest, hint (coin-gated via Buy_hint on answer_card?).

**Plausible reconstructed step (Russian in real; "Answer" field from page_constructor data_type):**
- Physical (questionnoanswer): Page_name_RU="Руки статуи", Main_text_RU="Подойдите к памятнику. Коснитесь холодных металлических рук... Почувствуйте текстуру и холод.", Place_RU=..., latitude=..., longitude=..., Image_link=..., Answer=(empty), Page_type=questionnoanswer, Gift_Coins=0, Button_text_RU="Я выполнил действие", Next_page=..., no answer_card needed or minimal.
- Answer (question): "Сколько пальцев на руках статуи?" or rebus visual prompt + "Answer": ["5", "пять", "five"] or longer "the word formed by first letters of the inscriptions on the left plaque". Server addAnswerCard compared submitted to list (exact?); on match set correct_answer_ state, advance; on fail errorstyle_ + increment Count_wrong_answers on answer_card.
- Rebus example (inferred common for quests): Visual image (statue hands + key shape) whose "answer" string is pre-chosen by author ("ключ" or "key to fortress"); list handles synonyms but not "I saw a key shape" free text.

Old answer_card was per-(user?, page_constructor, quest?) flag bag (no explicit "submitted value" field prominent in schema parses; analytics weak). 21 quests / 556 steps imply real variety in how question vs questionnoanswer vs gift were used (but no counts here; noted limitation).

This is the "expressive but messy" baseline the new model reacts to: 14 types → specialized Slides + per-type WFs + server workflows assuming connectivity + mutable content + no snapshot freeze concept.

---

## 2. Deconstruction: Edge Cases (Prompt-Specified + Derived from Grounding)

### Core Edges for Acceptable Answers / Matching / Normalization
1. **Synonyms / variants / typos / Russian specifics (high real impact).** List allows ["Александр", "Александр III", "Александр 3-й", "Александръ"]. But submitted "александр" (case), "Александр 3" (punct/space), "Алекс" (partial/abbrev), "Александр 3-й." (trailing), old orthography, translit ("Aleksandr"). Normalization *deferred* → early quests (v1 snapshots) have brittle matches. Client match bug (or future norm change) = permanently wrong is_correct for that snapshot (03/08 locked: client source of truth).
2. **Rebus / visual / non-pure-string puzzles (explicit "future norm, rebus/puzzle support" in task).** Common: image/observation whose "answer" requires interpretation ("the thing that looks like a key + fortress = ?"; "first letters of words on the plaque spell..."). List of strings works *if* author pre-defines canonical string(s) in multiline; but "partial credit", "explain your reasoning", or "multiple interpretations" impossible in all-or-nothing. If rebus is purely visual (no text entry intended), answer still string today — but "list may not scale to puzzle variety" (04_). Non-string future (arrange photos, audio match, gesture) breaks string list entirely.
3. **Numeric / counting with tolerance or multiple representations.** "How many arches/windows/fingers?" Answers=["7","seven","семь","7."]. But "7 or 8 depending on angle/which side?"; "approx 7"; "between 6-8"; Roman "VII"; "один" vs "1" vs "I". List forces discrete enumeration; no range/tolerance without author listing all. Old had no special numeric (plain list.text + server compare).
4. **Multiple valid paths / non-unique solutions.** 2-3 equally "correct" observations (different plaques, different angles) leading to same next step. List handles ("any of these"); but if paths diverge in *experience* (different later physicals or hints), linear (08_) forces duplication or "any correct advances identically".
5. **Partial credit / hints inside answer / multi-part answers.** "First word of inscription + number of letters in it?"; "submit the 3 things you saw (in any order)". Current (locked): all-or-nothing per step (wrong counter increments on any fail; old answer_card had aggregate Count_wrong_answers). No per-part scoring or "close but...".
6. **Order-dependent or contextual answers.** "The name on the *left* plaque" (ambiguous w/o photo in step); "the number *after* you touch the hands"; answer changes based on prior step's choice (linear hurts; old Next_page self-refs might have allowed conditional pages).
7. **Client offline match vs author intent drift + version freeze.** Author publishes v1 with Answer=["foo bar"]. Player downloads, plays offline with "f00 bar" (typo) or "Foo Bar" → wrong (if no norm). Later author "fixes" list in v2 (or realizes better synonym). Old attempts frozen to v1 list (locked). Analytics on submitted wrongs = *only* feedback loop for authors (08_ calls it out as important; 03_ notes it becomes "more valuable").
8. **"Secret" or very long / formatted answers.** Multiline ok for entry, but mobile keyboard for 80-char rebus solution? Player copy-paste from photo of plaque? "Secret" (not shown in UI, only in bundle) still plain in snapshot → potential cheat vector (player inspects bundle/IndexedDB; "protected" assumed but deprioritized; 07_ open question on exact protected rep (hashed? encrypted?)). Long answers bloat bundle slightly.
9. **Normalization deferred = early pain.** Locked: "simple (exact or contains; norm later)". But real quests use Russian + numbers + phrases → authors will pad lists with variants now (or ship brittle). When norm added later, old frozen snapshots *cannot* benefit (client bug or old match logic permanent for those versions). "Early pain" for v1 content quality.
10. **"I don't know" + answer-hint vs geo-only hint.** Current: hints = coin-gated *geo reveal + hint content* (not direct answer spoiler). For pure knowledge/re-bus this frustrates (player may want "spend to see the plaque text"). Old had Buy_hint on answer_card (tied to question flow).
11. **Rebus that is *not string at all* in future + partial/visual non-string.** E.g. "arrange these 4 photos in story order" (no text input); audio tone match; "draw the shape you saw". List + string submit fails. Old had no such (all text or confirm).
12. **Context/order dependent + multi-step puzzles.** Answer valid only after prior physical/answer (e.g. "use the number from step 3"); or cumulative ("sum the counts from the three statues").
13. **Client bug freezes per snapshot (core locked risk).** Any impl error in membership/contains (off-by-space, unicode, etc.) permanently affects is_correct recorded for all attempters on that version (03_ risk explicitly accepted; client sole judge).
14. **Old server vs new client shift + drift.** Old: addAnswerCard (server, assumed online, mutated answer_card flags, no submitted persisted prominently for analytics, correct_answer_ state in client Slide but validation server). New: client match from plain list in bundle. 06_V1 still says "server re-validation on sync" (contradicts 03 v0.2 / 08 locked "no reval; client local"); cut list attacks "client-side only 'correct'". This inconsistency is a flaw in the foundation.
15. **Tamper / offline "lie" on answer (deprioritized but not zero).** Player edits local bundle/JS (plain strings) or fakes is_correct in sync payload. Server records the claim; no reval = accepts it. Analytics may flag outliers later.
16. **Empty/dup/blank in lists (constructor + runtime).** Multiline "42\n\n  42 \n" → ["42",""," 42"] in list (old list.text may have had same). Matches weirdly or never. No old guard visible.
17. **Analytics on wrong submissions (valuable but underspecified).** Server records submitted_answer (good); but without norm or matcher type, "why was it wrong?" hard for authors to act on (e.g. "player submitted '7' but we had 'семь' only").

### Cross-Cutting + GAMSTEP / Constructor / Bundle / Analytics
- **Physical vs answer in GAMSTEP (01/03/04):** Physical: no list, no matcher. Answer: list + matcher. Uniform physical "no difference" + rich content as differentiator (risk: feels trivial, reduces magic). Invalid combos (physical + acceptable present) must be prevented at authoring.
- **Offline bundle size (03/ locked ~5MB):** Plain string[] small (even 20 answers x 50 chars). Hashes similar/smaller. Config + tests add bytes per answer step. Media/geo dominate; answers negligible but multiply across 556 steps / 21 quests.
- **Constructor entry (04/07/08):** "simple multiline" (error-prone: blanks, dups, OS newlines, no live test, no visual of parsed list). Old: direct list.text on page_constructor (in Edit_Page 55 WFs monster). New must produce clean list for bundle; "hard to publish bad" weak if raw textarea.
- **Analytics on wrong submissions (03/08/06):** Recorded (submitted + is_correct per version) = key for authors (improve future; spot if list was incomplete). Old: Count_wrong_answers aggregate (no per-submitted value easy to query?); no version. New: per-version heatmaps of wrongs = could-have in 06.
- **Version freeze + migration (01/03/09):** Old Answer/Answers lists must map to new acceptable[] at import time for historical attempts/snapshots (synthetic legacy versions capturing the list *as it existed* when answer_card was created). No retro fix for old.
- **Old expressiveness loss:** 14 Page_types + per-type Slides (different states/chrome for question vs no-answer vs error) allowed nuanced flows (music on question?, specific error popups). Lean list + uniform = simpler but may lose per-quest "feel".
- **Linear pressure:** Old Next_page self-refs allowed some dynamism/conditionals that affected answer validity/context. Forced linear serializes choices.

These edges are *not hypothetical*; directly implied by locked "simple list + deferred norm + client truth + offline snapshot + linear" + historical Page_type variety (question vs questionnoanswer existed for a reason) + real quest patterns (rebus, counts, plaques) + 07_ open questions on protected rep + numeric/puzzle support.

---

## 3. Flaws in the Locked ("Current Lean") Proposal (Plain List + Basic Client Membership for MVP)

**Current (per 01/03/04/08 decisions + blueprint synthesis):** GameStep.completion = { mode: 'physical' | 'answer', acceptable?: string[], allow_note?: boolean } (for answer steps: acceptable from multiline constructor input, one per line). Client: basic `list.includes(submitted)` or `list.some(a => a.toLowerCase().includes(...) )` (trim? case? MVP "contains" option). Bundle: plain `acceptable: string[]` (or absent for physical) serialized verbatim in the step for that version/snapshot. Physical: no list. Publish freezes the list. No embedded matcher type (implicit "membership"). Normalization punted. Constructor: raw multiline textarea (split on \n at save/publish).

**Exposed flaws (harsh; skeptical reading of the grounding docs themselves + discovery):**
- **"List may not scale to puzzle variety" is called out in source (04_) but punted.** Rebus/visual, numeric tolerance, partial/multi-part, future non-string all hit the wall immediately for creative content. Authors forced to enumerate or accept "stringify everything". Old Page_type + Slide_Question at least had dedicated states (correct_answer_ vs errorstyle_); lean migrates the problem into client match code (permanent per snapshot).
- **Client as permanent truth for the version (03_/08_ explicit).** "If the client has a bug in matching, the server will happily record the wrong outcome." Any off-by-one in contains, unicode fold, or " " trim = bad is_correct frozen forever for attempters on vN. Old server was (buggy but) updatable in theory; new locks the impl with the data.
- **Normalization deferred = guaranteed early pain + unfixable.** Real Russian + numbers + phrases (inferred from 21 quests) will require authors to bloat lists now with variants. When norm lands (trim/case/punct/number/synonym), v1 snapshots use old brittle logic. "Early pain" for content quality and player frustration on paid quests.
- **Constructor multiline is highest-error entry (04_/07_ call out).** "42\n  42 \n\nforty two" → junk in list (blanks, whitespace, dups). No live preview of parsed list, no test-submit box, no de-dup/trim at entry. Publishes to bundle as-is → frozen junk matches or fails. Old list.text suffered same (no guard visible in parses). "Hard to publish bad" fails.
- **Plain strings in bundle = exposure + tamper surface (07_ open on "protected representation").** Even if "cheating deprioritized", player can inspect PWA cache/IndexedDB, see all acceptable for every answer step (long "secret" answers visible), or monkey-patch the match fn before submit. Server records the (possibly faked) is_correct with no receipt/hint of tamper. Old server had the list "protected" behind workflows.
- **No support for richer matching semantics without data model change.** To add numeric_range or "fuzzy for rebus" later requires either (a) new fields on every answer step (migration pain for old snapshots), (b) convention in the string list (e.g. "RANGE:6-8"), or (c) sidecar. Freezes extensibility.
- **Analytics on wrongs is "valuable" (03_/08_) but weak.** Server gets submitted string + boolean is_correct (per version). Without embedded matcher type or author-provided test cases, authors can't easily see "player was close (edit dist 1) but list missed synonym" vs "completely off". Old had only aggregate Count_wrong_answers (no submitted value easy).
- **Inconsistencies/drift in foundation (06 vs 03/08).** 06 still requires "server re-validation on sync" and cuts "client-side only 'correct'"; locked 03/08/01/ decisions are the opposite (client local, record only, no reval). This is not "updated"; it is conflicting spec that implementers will hit. Old addAnswerCard was server-only (connectivity assumed; no offline).
- **Loses old per-type nuance without replacement.** Slide_Question had dedicated correct_answer_/errorstyle_/openerrorhint_ states + music_? vs no-answer simpler flow. Lean "one match fn for all answer steps" + uniform physical may make quests feel generic (rich content helps, but chrome/states were part of old "magic").
- **Bundle + freeze amplifies every flaw.** Bad list, wrong match logic, or missed variant ships to every downloader of vN and sticks for their attempts. No server "fix it for everyone".
- **Vs old mess:** Old was *worse* (server-only, no offline, mutable, scattered 1163 WFs, flag-bag answer_card, no analytics on exact submitted, dupe types). But it shipped 21 quests with real rebus/count/plaque content using lists + server compare. Lean is a *reaction* (KISS for offline) that may over-correct on expressiveness for puzzles while under-addressing the "client truth + freeze" risks the docs themselves flag.
- **Self-critique of docs + blueprint:** Sources already contain the skepticism seeds (07_ opens, 03_ risks, 04_ "may not scale", 08_ "client impl becomes source of truth", blueprint hints at "hashed acceptable sets" + future numeric_range in synthesis). Current lean is the "deliberate MVP cut" but the task requires exposing that it bakes in pain and limits.

In short: locked satisfies the "simple for v1 + offline client val + frozen snapshot" letter, but inherits "list may not scale", makes client match the unchangeable judge, punts norm (early pain), uses error-prone entry, exposes plain lists, and has foundation drift. It is the baseline to attack with variants.

---

## 4. Variant 1: Current Lean (multiline -> list, client membership/contains)

**Description (precise, as locked):** Exactly the model in 01/03/04/08 + blueprint. Constructor: (for answer mode) plain <textarea> "one acceptable value per line". On save/publish: split(/\r?\n/), trim, filter blanks (or not — risk), de-dup optional → acceptable: string[]. GameStep shape: completion: { mode: 'answer', acceptable: string[], ... } (physical omits or empty). Bundle contract: the string[] (plain, ordered) embedded in the serialized step for that snapshot version. Client contract: `function isAnswerCorrect(submitted: string, acceptable: string[], opts = {contains: true}): boolean { const s = submitted.trim().toLowerCase(); return acceptable.some(a => { const t = a.trim().toLowerCase(); return opts.contains ? s.includes(t) || t.includes(s) : s === t; }); }` (MVP basic; no norm beyond this). Physical: always "correct" on explicit confirm (no list, no call). Migration: direct copy old page_constructor.Answer (list.text) values into new acceptable[] (or page.Answers); synthesize legacy snapshots for historical answer_cards using the list at time of card creation. Test cases: basic membership + contains examples.

**Deconstruct (edges for *this* variant):**
- All prompt edges + above: synonyms handled only by author enumeration + brittle contains; rebus = author picks string (no fuzzy/interpretation); numeric = enumerate or fail (no range); partial/multi = all-or-nothing; order/context = unsupported; client bug freezes (yes, this *is* the client impl); secret long = plain in bundle; norm deferred = pain + unfixable for v1 snapshots; old addAnswerCard (server) → new client fn (drift risk if 06 language lingers).
- Constructor: raw multiline → easy blanks/dups/newline artifacts in the list that ships.
- Bundle size: minimal (strings).
- Analytics: submitted + boolean only (no "why" or distance).
- GAMSTEP: clean split (physical has no acceptable; answer has list + this matcher).
- Freeze: any match bug or incomplete list is law for that snapshot's attempters.

**Expose flaws (harsh, specific to V1):**
- Directly bakes in the "list may not scale" and "client impl = permanent truth" problems called out in grounding. No path to numeric/rebus without changing the data shape later (breaking old snapshots or requiring dual paths).
- Multiline entry is *the* error source for the thing that gets frozen (04_/07_). No live test, no structured editor, no author-provided tests.
- Plain list = zero tamper hint (player can see/edit all answers locally; receipt of claim is just the boolean).
- Early quests suffer norm absence; later norm can't help frozen ones.
- Maintainability: the match fn lives in client (versioned by app release, not per-snapshot); if it evolves, old bundles expect old behavior (or all snapshots re-evaluated? no, per locked).
- Vs old: simpler (no 12 WF Slide + server WF), but loses any per-question nuance (correct_answer_ state was explicit).
- "Simple for v1": yes. Extensible: no, without migration pain.
- Self-critique: This *is* the locked decision, so "flaw" is that the decision itself (under adversarial) is the minimal cut that accepts the risks (freeze, scale, pain). It can be implemented with tiny code (one splitter, one fn). But task requires variants that address the exposed limits; pure V1 fails "extensible" and "future rebus/puzzle support".

**Rebuild sketch (conceptual data shapes/contracts for V1):**
```ts
// GameStep (conceptual, in bundle/snapshot + DB draft)
interface GameStep {
  position: number;
  // rich content (RU v1): title, main_text, place_text, question_prompt?, button_confirm_text, ...
  media: MediaRef[];
  geo?: {lat: number; lng: number}; // display only
  completion: 
    | { mode: 'physical'; allow_note?: boolean; }
    | { mode: 'answer'; acceptable: string[]; /* implicit matcher: basic membership/contains */ };
  supporting?: { gift?: {coins: number; narrative: string}; hint?: {...}; ... };
  // author-only
  internal_notes?: string;
}

// Bundle contract (serializable snapshot for a QuestVersion)
interface QuestSnapshot {
  version_id: string;
  steps: GameStep[]; // acceptable[] present verbatim for 'answer' steps; plain strings
  // + quest meta, integrity_hash, published_at
}

// Client contract (pure fn, ships in PWA; used for offline val + author preview test)
function isAnswerCorrectV1(
  submitted: string,
  acceptable: string[],
  opts: { useContains?: boolean } = {}
): boolean {
  if (!submitted || acceptable.length === 0) return false;
  const s = submitted.trim().toLowerCase();
  return acceptable.some(a => {
    const t = a.trim().toLowerCase();
    return opts.useContains ? (s === t || s.includes(t) || t.includes(s)) : s === t;
  });
}

// Migration from old (discovery page_constructor.Answer list.text or page.Answers)
function migrateOldAnswerList(oldAnswerList: string[] | null): string[] {
  if (!oldAnswerList) return [];
  return oldAnswerList
    .map(v => (v || '').trim())
    .filter(v => v.length > 0); // or keep blanks if old did — risk
  // For historical answer_card: synthesize QuestVersion snapshot using the list value at card's created time (requires import-time reconstruction or server history).
}

// Test cases (author or unit)
assert(isAnswerCorrectV1("42", ["42", "сорок два"])); // exact
assert(isAnswerCorrectV1("Сорок два", ["42", "сорок два"], {useContains: true})); // variant via contains? weak
assert(!isAnswerCorrectV1("43", ["42"]));
assert(!isAnswerCorrectV1("", ["42"]));
assert(!isAnswerCorrectV1("42 ", ["42"])); // if no trim in V1 — fails (pain)
```

**Self-critique of V1:** Highest fidelity to locked decisions and "simple for v1". Tiny surface (splitter + 5-line fn). Bundle size minimal. Directly migrates old lists. But *fails the task's "extensible" and "future rebus/puzzle support"* and accepts (without mitigation) the scale/client-truth/norm-pain flaws the grounding documents themselves surface. Constructor entry remains the weak raw-multiline point. Good as *baseline implementation target* (ship the fn + splitter first), but not the end state. Readability high if the fn is isolated + tested; maintainability good short-term, degrades when puzzle variety arrives.

---

## 5. Variant 2: Server-Precomputed Hashes in Bundle + Client Receipt (Tamper Hint Without Reval)

**Description:** Keep plain (or not) acceptable list *server-side only* for authoring/migration. On publish, server precomputes salted hashes of the canonical set (or per-answer hashes + set hash) and embeds *only the hashes* (plus salt or versioned salt strategy) in the bundle snapshot for that step/version. Client still does local match against *its copy of the plain list?* (or against what?); to support offline, either (a) still ship plain + hash for verification, or (b) ship only hashes + client must... no, for offline val client needs to decide is_correct without server. Refined: ship plain acceptable (for offline match) + precomputed set-hash (or per-answer); on client "correct" decision, client produces a *receipt* = hash( submitted + claimed_is_correct + step_ref + version + nonce + acceptable_set_hash ). Sync uploads receipt + submitted + claim. Server can re-compute the set_hash from its master (or stored) and verify the receipt proves "this claim was made against *this* set at *this* version" without "re-val correctness" (server doesn't say "you were wrong"; it says "your receipt doesn't match the set you claim to have used, or hash chain broken" → flag/audit/correct the record). Tamper hint without violating "no reval of the boolean outcome". Client still does the membership for UX/feedback.

**Deconstruct (edges):**
- All prior + : synonyms/rebus/numeric still string-list problem (hashes don't solve matching semantics).
- Client bug freeze: still happens for the boolean (receipt only proves *which* set was used for the claim).
- Tamper: harder (receipt must match); player editing plain list in bundle would produce receipt that fails server hash check on sync → server can mark "tampered claim" or ignore the is_correct.
- Offline: still works (plain list for local match + receipt gen).
- Bundle size: + hash bytes (tiny) per answer step.
- Secret answers: hashes hide the actual strings from casual bundle inspection (better than plain).
- Constructor: still multiline (or improved).
- Migration: old lists → compute hashes at synthetic snapshot time.
- Analytics: submitted always there; receipt gives confidence score on claim integrity.

**Expose flaws:**
- **Does not solve core matching expressiveness or norm problems.** Hashes are integrity layer, not a matcher. Still need the list + membership fn for client to *decide* locally.
- **Offline + receipt tension:** To generate receipt client needs the set_hash (shipped) + the submitted + its decision. If it ships plain list anyway (to decide match offline), the "hiding" benefit is partial (plain still visible for match). If *only* hashes shipped, client cannot decide match offline without downloading or guessing (violates hard req).
- **"Without reval" is preserved only narrowly.** Server doesn't override the boolean for UX; but can reject/flag the record on receipt fail → effectively corrects or discards the outcome. This may feel like reval to player ("my offline correct was not accepted").
- **Complexity for marginal gain (v1).** Adds crypto (hash fn, salt per version or global?), receipt format, server verify on every answer completion sync, error UX for "receipt invalid". YAGNI if cheating deprioritized. Old had no such (server always knew).
- **Key management / versioned hashes:** Salts must be stable per snapshot (frozen); rotation strategy complex. Client must ship exact same hash algo.
- **Still client match bug freezes the UX/boolean.** Receipt only catches post-match tamper or list edit.
- **Self-critique:** Directly addresses 07_ open "protected representation? hashed?". Improves tamper detection + analytics confidence + "secret" hiding vs plain V1. But adds surface without fixing the "list may not scale" or "norm deferred" or "client truth for outcome" core. May be overkill for deprioritized cheat model + small internal quests. Fits "extensible" better (can layer on V3 matcher later: hash the *config* too).

**Rebuild sketch:**
```ts
// GameStep (authoring still uses acceptable list; snapshot may elide plain for "protected")
interface AnswerCompletion {
  mode: 'answer';
  acceptable: string[]; // for client offline match (or omit if pure hash, but then no offline val)
  acceptable_set_hash: string; // server precomputed: hash( sort(acceptable).join('|') + salt(version) )
  hash_algo: 'sha256-v1';
  // ...
}

// Bundle contract addition
// steps[...].completion.acceptable_set_hash + salt_ref (or embedded small salt)

// Client contract extension
function computeAnswerReceipt(
  submitted: string,
  isCorrectClaim: boolean,
  stepId: string,
  versionId: string,
  acceptableSetHash: string
): string {
  // hash( submitted + '|' + isCorrectClaim + '|' + stepId + '|' + versionId + '|' + acceptableSetHash + '|' + clientNonce() )
  return sha256(...);
}

// On sync: server verifies receipt re-computes to same using its knowledge of set_hash for (step,version). If not: record "tamper_suspect: true", perhaps override is_correct or queue for author review. Does *not* re-run membership on submitted (unless policy decides to).
// Migration: on import, for legacy answer_card, compute set_hash from the Answer list at that historical time.
```

**Self-critique of V2:** Strong on integrity/tamper/secret-hiding/analytics (directly attacks open questions in 07_ and "client sole judge" risk in 03_). Receipt provides "tamper hint without reval" as task asks. Bundle size impact negligible. Still requires the list (for offline) so doesn't bloat much. However, *does not advance the matching semantics* (synonyms/rebus/numeric/partial still author-enumeration problem; norm still deferred pain). Adds crypto/verify code for a deprioritized threat model. "Simple for v1" suffers. Best as *layer* on top of V1 or V3 (hash the matcher config + list). Good defense-in-depth, not standalone solution for the task's "rebus/puzzle support" and "normalization" angles.

---

## 6. Variant 3: Embedded Small Matcher Config per Step (exact, contains, numeric_range, future puzzle) with Pluggable Client Impl

**Description (directly addresses "future norm, rebus/puzzle support" + extensibility):** Per answer step, instead of implicit "membership", embed a small matcher config (discriminated, versionable, serializable). GameStep.completion for answer: { mode: 'answer', matcher: MatcherConfig, acceptable?: string[] /* depending on type */ }. MatcherConfig = { type: 'exact' | 'contains' | 'numeric_range' | 'fuzzy' | 'puzzle_rebus_v1' | ..., config: { tolerance?: number, useNorm?: 'v0' | 'none', ... }, test_cases?: [...] /* optional */ }. Client has a registry/pluggable impls: `const matchers = { exact: exactImpl, numeric_range: (submitted, acceptable, cfg) => { const n = parseFloat(submitted); return n >= cfg.min && n <= cfg.max; }, ... }; function isCorrect(submitted, step) { const m = matchers[step.matcher.type]; return m ? m(submitted, step.acceptable, step.matcher.config) : false; }`. Author in constructor picks matcher type (default 'contains' or 'exact' for v1) + params (for numeric: min/max; for rebus: fuzzy_level). Normalization can be a *param* on the config ( 'deferred' | 'v1_trim_case' ) so old snapshots keep their rule, new can use better. Future puzzle: add 'rebus_interpretive' type + config (author provides "canonical_interpretations" or embedded tests). Bundle: the full matcher config + acceptable data (small). Constructor entry: structured (type picker + conditional fields) not just raw multiline (multiline still for the list values). Migration: old lists → {type: 'contains' /* legacy default */, acceptable: migratedList }.

**Deconstruct (edges):**
- Synonyms/RU/typos: can be handled by norm flag in config or per-matcher (e.g. contains with 'v1_norm').
- Rebus/visual: 'puzzle_rebus_v1' type can carry extra (author "key shape" hint? or fuzzy + tests); still string submit today.
- Numeric tolerance: first-class 'numeric_range' {min, max, parseAs: 'int'}.
- Partial credit: future matcher type or config.score_threshold.
- Multiple valid: list + any-match still, or set-based.
- Context/order: still hard (linear); matcher could reference prior step results in future (complex).
- Client bug freeze: *mitigated* — matcher type+config is data in snapshot; client impl for that type can be fixed in app release, and old snapshots specify which type they used (if impl is deterministic + pure, old behavior reproducible or "use v1 impl for legacy type").
- Secret long: still data (but can be hashed inside config?); config makes "what rule" explicit.
- Norm deferred: solved — norm is *part of config per step/version* (v1 snapshots use 'none' or 'legacy_contains'; new steps use 'v2_full').
- Old addAnswerCard: map to 'exact' or 'contains' default.
- Bundle size: config JSON small (few bytes extra per answer step).
- GAMSTEP: physical has no matcher; answer has one (discriminated).
- Constructor: structured picker (better than multiline alone); still need list entry for most types.

**Expose flaws:**
- **Adds indirection/complexity for v1.** "Simple membership" becomes "pick type + config". Constructor UI more work (picker + conditional panels). Client registry (must ship all historical impls or compat layer for frozen snapshots). Risk of "wrong type chosen by author" (e.g. numeric on text).
- **Still fundamentally list + string submit for most.** Rebus non-string future still needs new type + input control evolution (not just matcher).
- **YAGNI if 95% of real steps are simple synonym lists.** If old 556 were mostly "exact plaque text or count as string", the config is ceremony. (Unknown without full export.)
- **Client pluggable impls must be pure/deterministic** for replay/reproducibility of old frozen snapshots across app versions/devices. Side effects or locale-dependent parse = new class of freeze bugs.
- **Analytics still needs the submitted + the config used** (to explain "why wrong: numeric parse failed" or "fuzzy score 0.6 < threshold").
- **Vs locked "simple multiline + basic"**: exceeds "simple for v1" in surface (picker, more types to test, registry).
- **Self-critique:** Directly solves "embedded small matcher config" task request + "pluggable client impl" + extensibility for norm/rebus/numeric/partial without changing core GameStep shape later. "Future puzzle" cheap to add (new type in union + impl + constructor panel). Migration clean (default legacy type). Bundle contract explicit (config travels frozen). This is the "extensible" winner among the required. Risk is over-engineering the MVP; stage by shipping only 'exact'/'contains' + norm flag first.

**Rebuild sketch:**
```ts
// GameStep
type MatcherConfig =
  | { type: 'exact' | 'contains'; config: { norm?: 'none' | 'v0_trim_case_punct' }; acceptable: string[] }
  | { type: 'numeric_range'; config: { min: number; max: number; tolerance?: number }; acceptable?: string[] /* for display/fallback */ }
  | { type: 'puzzle_rebus_v1'; config: { fuzzy_level: number; author_notes?: string }; acceptable: string[]; test_cases?: Array<{input: string; should_match: boolean}> }
  | { type: 'future_puzzle'; config: object };

interface AnswerCompletion {
  mode: 'answer';
  matcher: MatcherConfig;
}

// Bundle contract: full matcher object (small JSON) per answer step in snapshot. Hashes optional layer from V2.

 // Client contract (pluggable)
const matcherRegistry: Record<string, (submitted: string, m: MatcherConfig) => boolean> = {
  exact: (s, m) => /* apply norm from m.config, exact === */,
  contains: (s, m) => /* ... */,
  numeric_range: (s, m) => { const n = parseFloat(s.trim()); const c = m.config; return !isNaN(n) && n >= c.min && n <= c.max; },
  puzzle_rebus_v1: (s, m) => { /* fuzzy + check test_cases if present for author validation */ ... },
};
function isAnswerCorrectV3(submitted: string, completion: AnswerCompletion): boolean {
  const impl = matcherRegistry[completion.matcher.type];
  return impl ? impl(submitted, completion.matcher) : false;
}

// Constructor entry: not raw multiline only — type select (default 'contains' for legacy feel) + list editor (structured chips preferred) + conditional (for numeric: min/max inputs; for rebus: fuzzy slider + "add positive/negative test case" rows).
// Migration from old: { type: 'contains', config: { norm: 'none' /* or legacy */ }, acceptable: migrateOldAnswerList(old.Answer) }
```

**Self-critique of V3:** Best alignment with task ("Embedded small matcher config per step ... with pluggable client impl"; "future norm, rebus/puzzle support"). Makes the matching rule *first-class data* frozen in snapshot (explicit, versionable, migratable). Client impls centralized + testable (pure fns). Constructor can evolve from multiline to "choose matcher + fill". Norm/rebus/numeric/partial become data not code changes. Bundle contract clean (config + data small). Analytics can record "used matcher X with config Y; submitted Z → false". Still simple for v1 if only 2-3 types shipped initially (exact/contains + numeric stub). Over plain V1: huge for extensibility without future shape changes. Downside: more surface than "lean" (registry, more constructor code, author education on types). If real usage is 100% simple lists, this is YAGNI ceremony — but grounding shows open questions on "numeric ranges or multiple puzzle solutions" precisely because list is insufficient. Wins on "must ... extensible".

---

## 7. Variant 4: Invention — Author-Provided Test Cases + Fuzzy in Client for Rebus (Grounded Extension)

**Description (my invention, directly from task example "author-provided test cases + fuzzy in client for rebus" + edges + old pain):** Build on V3 but make *author-provided test cases* first-class for every answer step (especially rebus/puzzle). GameStep answer: { matcher: { type: 'fuzzy_rebus' | 'membership_plus_tests' | ..., config: {...} }, acceptable: [...], positive_tests: Array<{input: string; note?: string}>, negative_tests: Array<{input: string; note?: string}> }. On publish, server/client can *validate* the provided tests against the current matcher impl (author sees "this positive fails the current fuzzy — fix list or test or level"). Client matcher for rebus/fuzzy uses edit-distance / synonym map (per-step or global small) + test cases as "oracles" (if submitted matches a positive test exactly or fuzzy, accept; if matches negative, reject even if list would have). Bundle embeds the tests (small; authors will provide 3-8 per tricky step). Constructor: structured list editor + "Test cases" section (add positive/negative rows with "test now" button that runs the live client matcher). For simple steps: tests optional/empty (falls to V3 base). This gives authors a way to *encode their intent* for ambiguous rebus ("these 4 phrasings should pass; this near-miss should not") without bloating acceptable list, and gives analytics "player submitted X (which was a positive_test but fuzzy score low → we adjusted level in vN+1)". Fuzzy impl in client (e.g. Levenshtein + token overlap + Russian stem hints if cheap). "Secret" answers can be hidden in tests vs main list.

**Deconstruct (edges):**
- Rebus/visual non-string (string today): tests let author capture "the interpretations I accept" explicitly; fuzzy handles typos/variants without full enumeration in acceptable.
- Synonyms/typos/RU: tests + fuzzy cover more than pure list; author provides real player-like submissions as tests.
- Numeric/partial: tests can be used alongside (or numeric matcher + tests for edge cases like "7.1 approx").
- Client bug freeze: tests act as *executable spec* per snapshot. If impl changes, tests can be re-run at import or warn ("3 tests now fail on current client — this snapshot may behave differently").
- Partial credit: tests can carry "partial_score" in future.
- Secret long: tests can be the "visible" examples; canonical acceptable hashed or omitted from casual view.
- Analytics: gold — "submitted matched positive_test #2 but was marked wrong (fuzzy threshold)" tells author exactly what to tune.
- Constructor: structured + test editor (higher velocity for puzzle steps; multiline paste still helper for acceptable).
- Bundle size: tests add bytes (author-controlled; 5 tests x 30 chars = tiny vs media).
- Migration: old lists → acceptable + auto-generate some positive_tests from the list itself (or empty; author can enrich on re-publish).
- Old Slide states: tests + fuzzy can drive richer feedback ("close! one of your test cases was almost...") vs binary correct/wrong.
- GAMSTEP physical: no tests/matcher.
- Freeze: tests freeze the *author's intent examples* with the data.

**Expose flaws:**
- **Author burden:** Providing good tests is extra work (especially for 556 steps). Internal team may skip for simple plaques, only use for rebuses → inconsistent data. "Test cases" sounds like TDD to authors, not content.
- **Bundle bloat if abused:** Author pastes 50 tests per step → multiplies size (still small, but principle).
- **Fuzzy impl is heuristic + locale/RU hard.** Levenshtein on Russian ok-ish; stemmers/dicts add dep or code. Non-deterministic or changing over app releases = new freeze class (tests help detect but not prevent).
- **Still needs base matcher + list.** Invention layers on V3, not replaces.
- **Validation of tests at publish:** Server must run the (same) client matcher logic against tests to gate "publish only if all positive pass, all negative fail" — couples server to client match code (or pure shared lib).
- **Vs simple V1:** More powerful for the "rebus/puzzle support" task asks, but exceeds "simple for v1" and "multiline list" locked entry.
- **Self-critique:** Exactly the "your invention (e.g., author-provided test cases + fuzzy...)" requested. Directly mitigates "list may not scale" for interpretive content by letting author *exemplify* rather than *enumerate*. Tests double as living docs + analytics oracles + impl regression guards for frozen snapshots. Excellent for "multiple valid", "typos author didn't think of", "contextual" (author can note "this test only valid after step 4"). Cost: authoring UX + code for test editor + runner + fuzzy. If team ships mostly simple content, underused. Strong synergy with V3 (tests as optional on any matcher config). Best for content quality where rebus/puzzle *is* the product differentiator.

**Rebuild sketch (invention specifics):**
```ts
interface AnswerCompletionV4 {
  mode: 'answer';
  matcher: { type: 'membership_plus_tests' | 'fuzzy_rebus'; config: { fuzzy_threshold?: number; norm: 'v0' | 'none' } };
  acceptable: string[]; // canonicals
  positive_tests: Array<{ input: string; note?: string /* "player saw 'key shape'" */ }>;
  negative_tests: Array<{ input: string; note?: string }>;
}

// Client (fuzzy example)
function fuzzyMatch(submitted: string, targets: string[], threshold: number): boolean {
  const s = normalize(submitted);
  return targets.some(t => levenshtein(s, normalize(t)) / Math.max(s.length, t.length) <= (1 - threshold));
}
function isAnswerCorrectV4(submitted: string, comp: AnswerCompletionV4): boolean {
  const m = comp.matcher;
  // 1. exact on acceptable or tests
  if (baseExact(submitted, comp.acceptable)) return true;
  if (comp.positive_tests.some(pt => baseExact(submitted, [pt.input]))) return true;
  if (comp.negative_tests.some(nt => baseExact(submitted, [nt.input]))) return false;
  // 2. fuzzy
  if (m.type === 'fuzzy_rebus' && fuzzyMatch(submitted, [...comp.acceptable, ...comp.positive_tests.map(p=>p.input)], m.config.fuzzy_threshold || 0.7)) {
    return true;
  }
  return false; // or fall to other
}

// Constructor: list editor for acceptable + dedicated "Author test cases for this puzzle/rebus" (positives/negatives, with live "Run matcher" that calls isAnswerCorrectV4 against current config).
// On publish: for each test, assert( isAnswerCorrectV4(positive.input, this) === true && for negative === false ); else block or warn.
// Bundle: includes positive/negative_tests arrays (frozen intent).
// Migration: from old Answer list → acceptable + positive_tests = the list values (auto); author enriches later.
```

**Self-critique of V4:** Most "future-proof" for the rebus/puzzle/norm/ambiguity edges that motivated the task. Author tests encode *intent* (what players will actually submit) better than lists alone; fuzzy + tests handle Russian variants/typos/interpretations gracefully. Provides built-in "executable spec" per snapshot (guards client impl changes, great for analytics "X matched a positive_test"). Synergizes with V2 (hash the tests+config too) and V3 (tests as first-class on matcher). Directly from task prompt. Flaws: authoring cost, heuristic fuzzy quality for RU, extra bundle data, more code than lean. For v1 where "simple" + "multiline" locked, this is the "invention" to evolve *toward* (start with optional tests on a V3 base). If rebus content is rare, V3 without mandatory tests suffices. Highest leverage for content quality under freeze model (authors can "unit test" their puzzles before publish).

---

## 8. Edge Case Handling Matrix

| Edge Case / Criterion | V1: Current Lean (plain list + membership/contains) | V2: Hashes + Client Receipt | V3: Embedded Matcher Config + Pluggable | V4: Author Test Cases + Fuzzy (invention) | Notes / GAMSTEP / Bundle / Constructor / Analytics Impact |
|-----------------------|-----------------------------------------------------|-----------------------------|-----------------------------------------|---------------------------------------------|-------------------------------------------------------------|
| Synonyms/typos/RU variants | Author enumeration + brittle contains/trim (deferred norm) | Same + hash integrity | Config.norm flag (per-step/version) + type-specific | + fuzzy + author positive tests capture real variants | Locked deferred norm = early pain in V1; V3/V4 embed the rule. |
| Rebus/visual non-string (string today) | Author picks canonical string(s) in list; no interp/partial | Same (hashes don't help semantics) | 'puzzle_rebus_v1' type + config | + author tests for interpretations + fuzzy | "List may not scale to puzzle variety" (04_) hit hardest in V1; V3/V4 address. |
| Numeric tolerance/range | Enumerate strings or fail | Same | First-class 'numeric_range' {min,max} | + tests for approx edges | List poor fit; V3+ solve without enum. |
| Partial credit / multi-part | All-or-nothing; wrong count | Same | Future matcher or score in config | Tests carry partial metadata | Old answer_card had Count_wrong_answers; new analytics better in all but weak in V1. |
| Multiple valid / context/order dep | Any-of-list; linear duplication | Same | Config can hold sets or refs | Tests + notes for "valid after X" | Linear (08_) constraint hurts all; matcher can't easily reference prior without complex. |
| Client bug freezes per snapshot | Yes (the membership fn is truth) | Yes (boolean still from client; receipt only integrity) | Mitigated: type+config data + versioned impls; tests guard | + tests as executable spec per snapshot | Core 03_/08_ risk; V3/V4 make "what rule" explicit/frozen. |
| "Secret" long answers exposure | Plain in bundle (cheat/tamper vector) | Hashes hide strings (better) | Same as V1 + config may hide | Tests can be "public examples"; canonicals protected | 07_ open on protected rep; V2+ improve. |
| Normalization deferred = early pain | Yes (unfixable for v1 snapshots) | Same | Solved: norm= param in per-step config | + fuzzy covers more | V3/V4 directly attack. |
| Old addAnswerCard / server vs client | Drift (06_ still says server reval) | Same + receipt audit | Map to default 'contains' config | Same | Inconsistency in grounding; V all inherit unless policy layer. |
| GAMSTEP physical/answer split | Clean (physical: no acceptable; answer: list) | Same | Same (physical has no matcher) | Same | Physical never has list/matcher/tests (locked). |
| Offline bundle size (~5MB target) | Minimal (strings only) | + tiny hashes | + tiny config JSON | + author tests (controlled, small) | Media/geo dominate; answers negligible in all. Plain V1 smallest. |
| Constructor entry (multiline vs structured) | Raw multiline (error-prone blanks/dups) | Same | Structured type picker + conditional + list editor (better) | + dedicated test cases editor + live runner (best for puzzles) | 04_/07_ hotspot; V3/V4 strengthen "hard to publish bad". Multiline still helper. |
| Analytics on wrong submissions | submitted + boolean (weak "why") | + receipt confidence | + matcher type/config used (explainable) | + which test matched/fuzzy score (richest) | 03_/08_/06_ call valuable; V4 > V3 > V2 > V1. |
| Tamper detection / client truth | None (plain + boolean claim) | Receipt proves set used for claim | Config frozen; receipt layer possible | Tests + receipt; impl guard | V2+ provide "tamper hint without reval". |
| Migration from old Answer/Answers list.text + answer_card | Direct copy list → acceptable[] | + compute hashes | Default {type:'contains', ...} + list | + auto positive_tests from list | All feasible; historical snapshots needed for fidelity (09_). |
| Version freeze of bad rule | Any model (locked) | Same (but receipt flags bad claims) | Explicit config frozen (auditable) | + tests freeze author intent examples | 03_/08_ accepted; better data helps authors fix vN+1. |
| Extensibility (future puzzle/non-string) | Requires data shape change later | Same (layer hashes) | New matcher type + impl + panel (no core change) | + test support for new input types | V3/V4 win per task "extensible". |
| "Simple for v1" | Highest (tiny code) | Medium (crypto + verify) | Medium (registry + picker; stageable) | Lower (test editor + fuzzy + runner) | Locked wants simple; V1 literal, others add for robustness/expressiveness. |

**Matrix summary:** V1 is the lean locked baseline (simple, small, direct migration) but maximizes the scale/client-freeze/norm-pain/tamper/exposure flaws. V2 adds integrity layer cheaply (hashes/receipts) without fixing semantics. V3 makes matching *data* (config per step/version) — extensible for norm/rebus/numeric/partial with pluggable client, small cost. V4 layers author intent (tests) + fuzzy for the hardest rebus/ambiguity cases, richest analytics, best "hard to publish bad" for puzzles. No variant escapes linear or honesty-trust or freeze; all support offline client val. Bundle size and GAMSTEP split are non-issues across. Constructor entry improves dramatically in V3/V4 (structured over raw multiline).

---

## 9. Recommendation (Must Support: Offline Client Val, Frozen in Snapshot, Simple for v1, Extensible)

**Recommended: Start with disciplined V1 (current lean, to hit "simple for v1" + locked decisions literally) + *immediately* adopt the data shape + migration from V3 (embedded small matcher config as discriminated union, defaulting to legacy 'contains'/'exact' for plain-list feel). Evolve constructor entry toward V3 structured (type + list editor + optional norm flag) + V4 (optional author test cases + live runner, especially surfaced for rebus/puzzle steps). Layer V2 receipt/hash as integrity add-on in bundle/sync for tamper hint/analytics confidence (post v1 or concurrent if cheap). Do not ship full V4 fuzzy as mandatory for all steps in launch window.**

**Rationale (tied to all criteria + grounding):**
- **Musts satisfied:** Offline client val (client runs the (pluggable) matcher against data in its snapshot; physical has none). Frozen in snapshot (the matcher config + acceptable/tests + version id travel with GameStep in bundle; old attempts use exactly what they downloaded). Simple for v1 (default to V1 behavior via {type: 'contains', config: {norm: 'none'}, acceptable: [...] }; raw multiline still accepted as input method with paste-to-structured helper; only 1-2 matcher types at launch). Extensible (new type like 'numeric_range' or 'puzzle_rebus_v1' or 'future_audio' is a new discriminated case + one registry entry + one small constructor panel + tests support; no change to GameStep.completion shape or prior snapshots).
- **Improves on locked V1 flaws:** Explicit matcher config makes "what rule was used for this step in this version" first-class data (auditable, versioned, explainable in analytics). Norm becomes per-snapshot config (not global deferred pain). Rebus/puzzle support path without "list may not scale" wall. Structured entry + optional tests directly attack "multiline error-prone" + "hard to publish bad" (04_/07_). Receipt layer (V2) adds tamper hint without reval.
- **Vs old (discovery):** Old server-only addAnswerCard + implicit compare on list.text + flag-bag answer_card + per-Page_type Slides (question vs questionnoanswer had different states/WFs) + no versions = unmaintainable, no offline, mutable. New: one matcher config shape (data, not 14 types), pluggable pure fns in client (centralized, testable), frozen per snapshot, submitted values + config recorded for analytics. Migration mechanical (old Answer list → config + acceptable; synthesize snapshots for historical cards).
- **Vs current synthesis in FINAL-BEST-PRACTICE-BLUEPRINT.md:** Aligns (they use acceptable?: string[] + note future numeric_range without core mutation; suggest hashed sets). This makes the "rule" explicit in the acceptable container so future numeric etc. are natural extensions of the same shape.
- **GAMSTEP / bundle / constructor / analytics:** Physical remains no-matcher. Bundle: config small (JSON in step). Constructor: can start lean (multiline + implicit type) then add picker/tests (staged; respects "save + real player preview acceptable"). Analytics: submitted + (matcher.type + config + which test or fuzzy score) = rich for authors (heatmaps of "near misses on rebus tests").
- **Trade-offs accepted:** Slight increase in model surface vs pure plain list (one small union + registry). If 100% of content is simple plaques, overkill — but grounding open questions + "list may not scale" + rebus examples in task show it's not. Author education on "matcher type" for internal team. Fuzzy impl quality for RU is heuristic (tests mitigate). Must keep impls pure for frozen reproducibility.
- **Concrete data shape in GameStep (rec):**
  ```ts
  completion: 
    | { mode: 'physical'; allow_note?: boolean; }
    | { mode: 'answer'; matcher: MatcherConfig; /* acceptable inside matcher or top for simple */ };
  type MatcherConfig = { type: 'exact'|'contains'|'numeric_range'|'fuzzy_rebus'|'puzzle_future'; config: {...}; acceptable: string[]; positive_tests?: ...; negative_tests?: ...; };
  ```
- **Bundle contract (rec):** Full GameStep incl. matcher object (plain data, frozen) for answer steps. Optional: acceptable_set_hash + receipt recipe.
- **Client contract (rec):** `isAnswerCorrect(submitted, completion)` dispatches to registry[completion.matcher.type](submitted, completion.matcher). Pure, versioned per app but driven by snapshot data. Physical path: no call.
- **Migration from old Answers (rec):** On import for historical: create synthetic QuestVersion(s) with matcher: {type: 'contains', config: {norm: 'none'}, acceptable: migrateOld(page_constructor.Answer || page.Answers)}. Map question/question0 → answer mode with matcher; questionnoanswer → physical. answer_card Count_wrong_answers + submitted (if reconstructible) → StepCompletion records with the version's matcher.
- **Test cases (rec, for impl + author):** Per-matcher unit tests (exact match, range bounds, fuzzy thresholds, test cases roundtrip). Author-provided as data in V4 (validated at publish: positives must pass, negatives must fail under the chosen config). Golden: "Mystery fortress" physical (no matcher) + plaque count (numeric or contains) + rebus (fuzzy + 4 positive/2 negative tests).

**Justification (maintainability/readability vs old + current):** Over old: one small discriminated matcher (data) + centralized pure fns vs 14 Page_types + specialized 3-21 WF Slides + scattered server addAnswerCard + flag mutations. Over pure V1 lean: makes the "matching rule" explicit and extensible data (addresses every deconstructed edge and open question without later shape churn). Constructor code stays readable (small registry, one dispatcher, conditional forms per type, optional test subcomponent). KISS for v1 (default legacy type behaves like locked multiline list). SOLID: open for new matcher types, closed for core GameStep. TDD: pure fns + test cases as data enable property tests ("for any step's positive_tests, isCorrect must return true").

**When to revisit:** After exporting/walking 2-3 real quests' 556 page_constructor rows (Answer lists, Page_type distribution, actual rebus/count examples) — if <5% need anything beyond contains, lean harder to V1 + optional V2 hashes only. Measure authoring time on first puzzles with/without test cases editor.

This rec is the *least-bad survivor* of the cycle that respects *every* locked constraint while giving a clear path for the task's "future norm, rebus/puzzle support" and "extensible".

---

## 10. Self-Critique of This Entire Analysis + Recommendation

- **I may have over-weighted rebus/puzzle and extensibility.** The locked decisions (simple multiline, basic membership, deferred norm, client local, freeze accepted) were made after adversarial process to enable offline MVP. If the 21 shipped quests were 90%+ simple plaque/count strings that "just worked" with server compare + author-padded lists, V1 is perfectly adequate and V3/V4 are architecture for a problem that doesn't exist yet. Task *required* 3+ variants + "your invention (e.g. author-provided test cases + fuzzy for rebus)", so I did — but the rec could defensibly be "V1 literal + V2 hashes for integrity, revisit matching after real content export".
- **Lack of real step content is a weakness (repeated from ANALYZE-03/07).** We have schemas, counts (556), element states (correct_answer_ on Slide_Question vs simpler on no_answer), workflow names (addAnswerCard), but no actual Answer list values, Gift_Coins distributions, or "how many question vs questionnoanswer" from the 21 quests. Inferences from "Mystery of the Fortress" + common location-quest patterns (plaques, counts, visual rebuses) are grounded but not exhaustive. A follow-up must export 3 full page_constructor sets.
- **V3 and V4 are similar (layered).** V4 is "V3 + tests + fuzzy as a matcher type". This is ok — the point was to explore "config as data" and "author intent examples" as distinct but compatible lenses. In practice they converge (tests live inside the matcher config).
- **"Improves maintainability" claim must be tested in code.** Argued from first principles + old 1163 WF / 14 type / answer_card flag-bag pathology + discovery element counts. Actual client registry + constructor conditional panels + bundle serializer will reveal if the discriminated config adds cognitive load or saves it vs a single "acceptable: string[]" + comment. Pure fns help TDD.
- **Skepticism on rec:** Even the hybrid exceeds "simple multiline + basic membership" literalism. If team is tiny/internal and rebus rare, pure V1 + manual author discipline on lists + later global norm (accepting frozen old) may have highest velocity. Matrix shows trade-offs; no variant is flawless. Rec is "best under the musts + task requirement for variants addressing scale/future".
- **Other un-attacked:** "Protected" in bundle (hashes help but client still needs data to match offline). Multi-device/offline sync of "I submitted X, client said correct under this matcher" (ties to ANALYZE-05). How author "tests" a rebus without real location (preview via save+player still the locked path). Russian fuzzy quality (no external libs assumed).
- **Process strength:** Followed mandated full cycle (deconstruct edges from prompt + grounding + discovery; expose in locked + per-variant; 4 variants with explicit data shapes/contracts/migration/test cases per; matrix; rec with why vs old/current/locked; max self-critique/docs; extreme skepticism; multiple parallel tool strategies; absolute paths; no broadening). All claims traceable to cited business/ lines + discovery/ JSON values (e.g. "answer_for_exercise_list_text" "Answer" list.text, page_type values, Slide_Question 12 WFs with "correct_answer_", addAnswerCard WFs). Grounded in business/04/03/01/08/07 + specified discovery.

---

## 11. Migration / Implementation Notes (for follow-on + synthesis)

- Old `page_type` + presence of `Answer` (list.text on page_constructor) / `Answers` (on page):
  - `questionnoanswer` → physical (no matcher/acceptable).
  - `question` / `question0` → answer + matcher {type: 'contains' (legacy default), config: {norm: 'none'}, acceptable: the list values}.
  - `gift` / `congratulations` etc. → supporting + appropriate completion (or physical/answer if had list).
- `Gift_Coins` → supporting.gift (frozen at snapshot).
- `Answer` list.text → inside matcher.acceptable (trim/filter policy decided once, applied at migration + new entry).
- `Hint` / `Buy_hint` / answer_card mutations → has_hint supporting + StepCompletion coins_spent + submitted.
- `Next_page` self-refs → linear positions (warn on any non-sequential for migration).
- answer_card history (Count_wrong_answers, Complited, submitted if reconstructible) → StepCompletion (versioned to synthetic snapshot using the Answer list at card time) + analytics events.
- Old server addAnswerCard / correctAnswer* flows → client isAnswerCorrectV* + sync record (no reval).
- Constructor: start with multiline (V1) + implicit matcher; add type picker + structured list + optional tests (V3/V4) + publish gate ("all author tests pass under chosen matcher").
- Client: one registry + dispatcher; pure fns per type; used in player offline, author preview "test submit", publish validator.
- Bundle/publish: serialize the matcher object (data only) + optional hash/receipt support.
- Tests: per-matcher golden (incl. migrated old lists); snapshot freeze tests ("vN bundle with old config still evaluates submitted the same"); author test cases as data in V4.
- Analytics: record submitted + matcher.type + config (redacted?) + outcome + (for V4) matched_test_id or fuzzy_score.
- Snapshot retention: required for old attempts to re-download exact (incl. their matcher config) if local cleared (per 03_ risks).
- Revisit after real content export + first v1 quest built with the shape.

---

**Report path:** `business/analysis/answers-matching-variants.md` (absolute: `/home/nabor/_projects/geohod/quests/business/analysis/answers-matching-variants.md`).  
**Status:** COMPLETE. (Full cycle with tool-assisted broad-to-narrow searches (list_dir + 10+ parallel/sequential greps across business/discovery/docs/scripts/raw + targeted offset reads of 4+ JSONs + full reads of 10+ .md), deconstruct/expose/rebuild per 4 variants with explicit shapes/contracts/migration/tests, matrix, rec under musts, exhaustive self-critique/docs like ANALYZE-03/07. Extreme skepticism applied; no claim un-attacked. Ready for main-thread synthesis (SYNTH-001), cross-review with other ANALYZE-*, blueprint update, real quest data walk-through, and implementation planning. All claims traceable to workspace sources.)

**Next recommended actions (from this analysis):**  
1. Export actual page_constructor (and page) data for 2-3 representative quests (incl. one rebus/count heavy + "fortress" physical) — validate Page_type distribution, real Answer list examples, rebus frequency, numeric usage.  
2. Prototype the matcher registry + V3 config shape + basic constructor picker (lean default) + publish validator using the shapes here; unit test against migrated old lists + author test cases.  
3. Decide exact V1 default matcher (contains vs exact; what "contains" means precisely — substring both ways?) + norm v0 and document as part of snapshot contract. Layer V2 hashes/receipts if tamper concern elevated.  
4. Revisit this doc + rec after first real quest authored/published/played under the model (measure authoring friction on puzzle steps, analytics value of submitted + config, any freeze surprises).  
5. Align with parallel (esp. ANALYZE-02 versioning/snapshots, ANALYZE-01/05 offline/sync, ANALYZE-07 constructor, ANALYZE-03 GAMSTEP, ANALYZE-09 migration) — the matcher config lives in the GameStep snapshot shape they define.

This concludes ANALYZE-08. Maximum skepticism applied throughout. Grounded in every cited source in the workspace. No files other than the mandated report were created.  

*End of ANALYZE-08 report.*
