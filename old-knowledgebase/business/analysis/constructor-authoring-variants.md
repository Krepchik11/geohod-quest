# ANALYZE-07: Deep Adversarial Analysis — Quest Constructor MVP & Authoring Experience

**Task ID:** ANALYZE-07  
**Role:** Chief Staff Engineer + Relentless Critical Analyst subagent  
**Date:** 2026-06-09 (analysis execution)  
**Status:** COMPLETE. Full adversarial cycle applied to current spec + 4 variants (including invention). Report delivered.  
**Output Path:** `business/analysis/constructor-authoring-variants.md` (absolute: `/home/nabor/_projects/geohod/quests/business/analysis/constructor-authoring-variants.md`)  
**Grounding Sources (all local, no external web):**  
- `business/04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md` (primary: philosophy, GameStep, MVP capabilities, answers as multiline, preview decision, self-critique, old WF warning)  
- `business/08_DECISIONS_LOG.md` (locked: multiline answers, "save then switch to real player as test user" acceptable for MVP, no high-fidelity live preview at launch, explicit publish for version, linear only, client snapshot validation)  
- `business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md` (Quest aggregate + ordered GameSteps, invariants, versioning for snapshots, reject old 47 types + duplication)  
- `business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md` (bundle snapshot must embed answers list plainly + full step content; publishing/versioning mechanism; old attempts frozen to their snapshot)  
- `business/06_V1_REQUIREMENTS_AND_CUT_LIST.md` (admin constructor musts: create/edit/publish/reorder steps with kinds, answers strings, media, geo, hints, gifts; preview via save+test; success = admin can create+publish+preview end-to-end)  
- `business/07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md` + `business/09_WHY_THE_QUESTIONS.md` (assumptions under attack: preview sufficiency, linear seq, internal team only; risks of frozen bad content; "current project" is accidental complexity not spec)  
- `business/00_PRODUCT_VISION_AND_SCOPE.md`, `business/02_...`, `business/05_...` (cross-refs for roles, commerce surface in constructor)  
- Discovery artifacts for old complexity mapping: `discovery/parsed/element_definitions.json` (Edit_Page: 55 workflows; Existing_Quest: 63 workflows; 52 reusables total), `discovery/parsed/workflows_all.json` (1,163 total, heavy on SetCustomState/Hide/Show), `discovery/parsed/data_types.json` (page_constructor: 36 fields incl. multilingual explosion, Answer list.text, Gift_Coins, Page_type 14 values, self-ref Hint/Next_page, latitude/longitude, Image_link/Hint_Image/Video_link; quest_name_constructor duplication), `discovery/parsed/option_sets.json` (page_type: style/hint/lead/gift/error/start/video/question/greetings/question0/namerequest/congratulations/questionnoanswer/screenafterquest), `docs/06_PAGES_AND_USER_JOURNEYS.md`, `docs/05_WORKFLOWS_AND_BUSINESS_LOGIC.md`, `docs/00_EXECUTIVE_SUMMARY.md`, `docs/02_DATA_MODEL.md` (old admin page only 9 wfs; authoring lived in reusables)  
- `business/analysis/README.md` (context: this is one of parallel ANALYZE-*; feeds synthesis)  
- Cross: `docs/10_MIGRATION_MAPPING.md`, `docs/03_DATA_MANAGEMENT.md` (historical only)  

**Process Followed:** Start broad (list_dir + grep across business/ + discovery/ + docs/ for "constructor", "Edit_Page", "page_constructor", "Answers", "Gift_Coins", "publish", "preview", "multiline", "step", "reorder", "GameStep"); narrow to key files + JSON schemas + workflow counts; read full targeted sections (with offsets for JSON); no assumption of app source (find confirmed: this workspace is docs + discovery + business specs only — no TSX/Next.js constructor implementation exists yet; analysis is pre-implementation design critique); deconstruct spec vs. old; define + cycle each variant; synthesize recs + mapping + data entry + bundle support. Maximum skepticism applied at every step (self-critiques, "even if", "risk of", "why would this be better than", frozen-content implications, YAGNI vs. correctness needs). Never broadened beyond constructor authoring (create/edit/reorder/publish steps + multiline answers + explicit Publish + media/geo/hints/gifts + preview strategy).

**No files created except this mandated report.** Used `write` only for the explicit deliverable. All paths absolute in this doc.

---

## 1. Deconstruction of the Current Lean Spec + Business Context

### Core Philosophy (from 04)
Quest = **linear sequence of GameSteps** (not general page builder, not rich editor). Two mutually exclusive primary completion modes:
- Physical / No-answer task: real-world observation/action → explicit player confirmation ("Done", "I found it"). Optional geo for display/map.
- Answer-required task: submit value → client matches against author-provided list of acceptable strings (synonyms, numbers, phrases).

Supporting (orthogonal or standalone): narrative/advance ("continue"), media (image gallery/video), hint (coin-gated reveal of geo/extra), gift/reward (narrative + optional coins), start/greeting, terminal/end (congrats + review), rare error/guidance.

**Old `Page_type` (14 values) rejected as presentation variants** — constructor chooses semantic behavior + rich content, not 14 types.

### Minimal Per-Step Data (Conceptual, Drives Constructor UI)
- Position (for order).
- Internal title/name.
- Kind/behavior flags (primary mode + has_hint?, is_gift?, is_video?, is_terminal?).
- Content blocks (RU only): main text/task, place desc, button variants, question prompt, hint content (text+opt image), gift text.
- Acceptable answers: `string[]` (for answer steps only). **Simple multiline input (one per line)** per locked decision.
- Media: primary image, hint image, video ref.
- Geo: optional {lat, lon} (display + map pin only; no enforcement).
- Author notes/sample (constructor-only).

Quest-level: name/summary/price/level/age/city/tags/preview image/start geo. Status: Draft/Published/Archived (or equiv).

**MVP Constructor Capabilities (non-negotiable from 04/06):**
1. Create quest (metadata form).
2. Add steps in sequence.
3. Edit step content/kind/answers/media/geo/hint/gift.
4. Reorder steps (drag or explicit pos).
5. Delete steps (confirmation; published have restrictions/versioning implications).
6. Preview "as player would see it" — **locked: "Save the quest, then switch to the real player logged in as a test user" is acceptable MVP. No high-fidelity live preview embedded at launch.**
7. Explicit **Publish** (makes appear in catalog + downloadable; creates version).
8. Basic stats (read-only).

**Out of MVP (or later):** branching (linear only per 08), full version history/rollback, collab, rich text WYSIWYG, external authors.

### Versioning + Offline Bundle Tie-In (Critical, from 03/08/01)
- Publishing mechanism (explicit Publish button) produces versioned snapshot.
- Bundle/snapshot (for PWA download): full ordered GameStep sequence + rich content + **acceptable answers embedded as plain strings (exactly as authored for *that* version)** + media refs + geo + version id + integrity hash.
- Client validates answers **fully offline** against the snapshot it downloaded. Server records submissions + local outcome but **does no re-validation of correctness**.
- New attempts/downloads get *latest published* version.
- Old attempts frozen to the version/snapshot they started with ("buggy answers frozen for those who already started").
- Invariant: published quest >=1 step.
- When admin edits published quest: existing bundles valid for started attempts; new downloads get new content. In-progress old continue against their version.

**Constructor must produce (or publish flow must generate from) exactly this serializable structure.** Answers list from multiline is *directly* what goes into protected? (plain in bundle per current model) client matching. Any formatting artifact (trailing newlines, dups, empties) ships to clients forever for that version.

### Explicit Preview Decision (08 + 04 self-critique)
"Save then switch to real player logged in as test user" **acceptable**. "No requirement for high-fidelity live preview embedded inside the constructor at launch."
Self-critique in 04: "Live preview in the constructor is easy to say and hard to build well (state management between editor and preview, media uploads, etc.)." "If the team is small and internal, a very simple Markdown + JSON or even a spreadsheet import might be higher leverage than a fancy web constructor for v1."

### Error Proneness Hotspots Called Out in Task
- Wrong answers list (multiline: extra blank lines → empty string matches? dups? missing obvious synonyms? case/punct that normalization will later "fix" but frozen versions won't?).
- Bad geo (manual lat/long → pins in wrong city, maps broken for hints).
- Missing media (publish step with placeholder text only → dead player experience).
- Wrong step kind/flags (physical marked answer → no completion UI; gift coins on non-gift).
- Reorder/delete on published: sequence changes affect only future; but if you delete a step mid-published-quest, old attempts must still see the old sequence (requires snapshotting full steps at publish time, not "live" steps).

### Authoring Velocity for Internal Team
Small internal team (no external authors). Russian content. Must be *efficient* — not Bubble-spaghetti slow. Success (06): "An internal admin can create a complete quest with a mix of physical and answer steps, publish it, and preview it end-to-end."

### Reordering / Deletion in Linear Sequence + Published Quests
Linear only (08). Reorder = change to current working content. Publish snapshots the order + content at that instant. Deletion same. Old versions (for old attempts) must retain historical step list/answers (snapshot retention decision open per 03/07). UI must make clear: "You are editing the next version. Existing players on vN see old sequence."

### Old Bubble Complexity — The Cautionary Tale (Never Repeat)
- Duplication: `page` vs `page_constructor` (both 556 recs, same data), `quest` vs `quest_name_constructor`.
- page_constructor: **36 fields** — multilingual explosion (_RU/_ENG/_SRB on nearly every text: Main_text, Place, Page_name, Button_text, Question, Duration, Quest_name etc.), Answer (list.text), Page_type (14), Gift_Coins (num), latitude/longitude, Image_link + Hint_Image + Video_link (file), Hint (self-ref page_constructor), Next_page (self-ref), Sample (ref), Page_number, Buy_hint (bool), etc.
- Reusables: **Edit_Page** (CustomDefinition on quest_name_constructor): **55 workflows**. **Existing_Quest**: **63 workflows**.
- Total: 1,163 workflows (839 ButtonClicked, 444 SetCustomState, 358 Hide, 349 Show — pure UI state machines). Admin page itself only 9 wfs; authoring complexity *pushed into* monster reusables.
- Why so many? In-place editing of step list, tab switching (content / media / answers / hint / geo / gift), conditional show/hide for every Page_type variant (question vs questionnoanswer vs gift vs video vs namerequest etc.), manual next/hint wiring, multilingual sync?, save handlers, preview simulation hacks, validation scattered, drag-reorder via custom states, publish flows, error popups.
- Result (09): "accidental complexity", "UI state pollution", "constructor duplication patterns", "the cost of building an in-place editor with Bubble's element + workflow model".
- Business/04: "We will design a much cleaner constructor (likely form-based + live preview component) because we control the whole stack and are not fighting no-code limitations."
- Cut list (06): "In-app complex reusable element editors with dozens of workflows each." "The 1,163 imperative workflows..."

**Any new constructor that accretes similar god-component + hundreds of conditionals/state mutations will be a failure.** Maintainability metric: constructor code itself must be *readable/maintainable* (small focused components, typed discriminated unions for kinds, shared renderers with player, minimal state surface, no leaked "current editing step id" in weird places).

### Current Lean Spec (What "form-like + list editor + explicit Publish + external test-player" Means)
Inferred precisely from docs (no code yet):
- Quest metadata form (structured inputs for name/summary/price/level/age/city/tags/preview/start-geo).
- Steps as **ordered list** (cards or table rows showing summary: pos, kind badge, truncated text, flags for media/geo/hint/gift/answers-count, edit/delete/move buttons).
- Add step → opens structured form (or inline): kind selector (Physical | Answer | Narrative | ... or flags), textareas for main/place/question/prompt/hint/gift, **simple multiline textarea for answers** ("one acceptable value per line"), number inputs or pickers for geo, media uploaders (with list of current), hint toggle revealing subfields.
- Save (draft) vs **explicit Publish button** (triggers version/snapshot, makes downloadable/purchasable).
- Reorder: up/down arrows or basic DnD on the list (positions integers or sortable keys).
- Delete: confirm; warning if published quest.
- Preview: "Save" then manual switch (new tab? different login as test user or "test mode" grant) to real `/quest` player flow. No embedded sim.
- No live WYSIWYG; plain inputs (textareas sufficient, "no rich text beyond needed").

This is the "lean" baseline. It *directly* implements the locked decisions.

**Skeptical deconstruction of lean (before variants):**
- **Velocity:** Acceptable for v1 if team small. But preview friction high: to check one changed step's media rendering or answer feedback or hint flow or geo pin, author must save, switch context (possibly re-auth as test player), navigate/ start the quest (or resume), advance to that step, interact, spend fake coins if hint, submit test answers, observe. For physical: "just confirm". To test reordering impact: full play or careful step jumping. Iteration loop = minutes per tweak. For internal team doing many quests, this kills authoring velocity and content quality (less polishing of texts/media).
- **Error proneness:** *High for called-out risks.* Raw multiline: author pastes "42\n  42 \nforty two\n" → empty-ish or whitespace strings in list → client match surprises (or future norm hides but old snapshots don't). No visual of how answers will be presented. Geo: two number fields — easy transpose digits, wrong hemisphere, no map feedback until player test. Media: upload happens, but no thumbnail/preview in step list or form → easy to attach wrong file or forget alt. Missing required per kind (answer step with 0 answers) can reach publish. Kind mis-selection (physical with answers list) may serialize but player confused. No "what you publish is what player sees" guard.
- **Versioning implications:** Edits always to "current" (draft/working). Publish = the trigger for new immutable version. Good. But: if you edit after publish (fix a bad answer), old attempters never see fix (intentional). Reorder/delete: snapshots the *state at publish time*. If you delete a step from a published quest's working copy and re-publish, new players get shorter sequence; players mid-attempt on prior version keep full old sequence (requires storing full step list per snapshot, not pointers to mutable steps). Deletion of steps in "published quests" is really deletion from future versions only. UI must never imply "this deletes for everyone".
- **Preview fidelity vs acceptable:** Per decision, acceptable. But fidelity low for the exact things that cause errors (media loading in real PWA cache context, geo map interaction + hint spend UI, full linear flow after reorder, coin balance effects from prior gifts, answer input keyboard + submission states, offline simulation). "Switch to real player" tests integration but not *in the flow of authoring*. Risk: authors skip full tests, ship subtle UX/text bugs that are frozen.
- **Reordering linear:** List editor fine. Positions must be stable per snapshot. Drag better than manual numbers (error-prone renumbering).
- **Deletion published:** As above — versioned. No cascade to old attempts.
- **Bundle support:** Strong if implemented cleanly — on Publish, take the in-memory/current-DB steps array (with answers split from the textarea at save or publish time), serialize to snapshot shape, embed answers[], assign version, store snapshot (or generate bundle artifact). Multiline splitting logic must be robust (trim, filter blank, preserve order, no extra \r). Media uploads must produce stable refs that bundle process can resolve (local fs? object storage?).
- **Maintainability of constructor code (the mandate):** *Potentially excellent.* One QuestForm + StepsList (array of StepDraft, key by temp id or pos) + StepForm (discriminated on kind: conditional fields via ifs or subcomponents). No god "Edit_Page". Use form lib + schema (zod) for validation. Positions as drag sortable. Publish action = serialize + POST. State mostly local or simple draft query/mutation. Readable, small files, high testability (validateAnswersList, serializeToSnapshot). Risk: if "form-like" becomes 1 giant component with 20 tabs/conditionals for every supporting flag + media states + geo, it regresses toward old 55-wf hell (in React terms: useState explosion + useEffect for sync).
- **Productivity + Correctness:** Productivity medium (friction on preview/iteration). Correctness weak ("hard to publish bad" fails — author can easily publish zero-answer step or bad geo or missing image). Frozen bad content risk is *amplified* by weak guards.

This is the baseline. It satisfies "acceptable MVP" literally but may not satisfy long-term authoring velocity or "hard to publish bad content" for a product where content errors are permanent for subsets of players.

---

## 2. Variant 1: Current Lean (Structured Form + Ordered List + Explicit Publish + External Test-Player Preview)

**Description (precise):** Exactly the inferred current spec above. Metadata form → sortable step list (summary cards) → per-step structured form (kind radio/select + conditional sections + plain <textarea> for answers "one per line" + file inputs for media + number fields for geo/lat-lon + toggles + sub-textareas for hint/gift) → Save Draft (persists working copy) + big Publish button (validates minimally?, snapshots current state to new QuestVersion + bundle-eligible data, flips status). Preview affordance: "Preview in Player" link/button that saves then instructs "open player as test user X" (or automates a test session link). No side preview, no per-step render, no live match tester. Reorder via list controls. Delete with "this only affects unpublished/future versions" note.

**Full Cycle Critique (skeptical):**

- **Authoring velocity (internal team):** Medium-low for iteration-heavy work. Creation of first draft ok (forms are familiar). But every content tweak that needs visual/UX check costs context switch + play time. For a 15-25 step quest (typical from old 556 pages / ~21-25 quests), testing a single media swap or answer list tweak = full save + player launch + advance N steps. Authors will batch changes and test less often → lower quality or slower delivery. For small internal team this may be "fine" per decision, but velocity claim in vision ("efficiently build and iterate") is aspirational, not delivered by this UX.
- **Error proneness (wrong answers list, bad geo, missing media):** *Highest of the variants.* Multiline is literally "simple" as decided but error-prone by nature (humans paste badly; newlines vary by OS; trailing spaces; author thinks "one per line" but list ends up ["42", "", "forty-two"]). No immediate feedback on what the list actually contains or how matching will behave. Geo fields: pure numbers, no map, no validation beyond "is number", no "this is in city X" sanity. Media: upload succeeds silently; step list may show filename only or nothing; easy to publish step whose "primary image" failed or is the wrong asset. Kind + answers mismatch: form allows answer list on physical step (or vice versa); serializes anyway. No pre-publish gate stronger than "has >=1 step". Result: bad content *easy* to publish; errors frozen for vN attempters.
- **Versioning implications of edits (what triggers new publish):** Cleanest here. Edits mutate the single "current draft/working" representation. Only explicit Publish creates new version/snapshot. Perfect match to "explicit Publish for version". Reorder/delete are just mutations to current; their effect is versioned at publish instant. Deletion from a "published" quest's editor is safe (old snapshots immutable). Implication for code: Quest entity has "current_content" (or steps live on it until publish snapshots them); publish does INSERT INTO quest_versions (snapshot_json, ...). Simple.
- **Preview fidelity vs "acceptable":** Delivers exactly the locked "acceptable". Fidelity is that of the real player (best possible for integration, offline, real PWA serviceworker, real auth/coins, real map if device geo). But *authoring-time* fidelity is zero — you cannot see the effect of your current edit without leaving the constructor. For media/geo/hints: you see nothing until full player test. For multiline answers: you see the effect only by submitting in player. Acceptable per spec, but the self-critique in 04 calls out the build difficulty of better; here we pay the iteration cost instead.
- **Reordering in linear sequence:** Straightforward list (array index or position field). DnD or buttons mutate the array order in current draft. On publish, the array order at that moment is snapshotted into the version's step list (positions 1..N or stable keys). No issue. Old versions keep their historical order.
- **Deletion of steps in published quests:** Same as reorder — mutates current; publish snapshots the reduced list. Old attempts (with their snapshot) still have the step (their local bundle has it; server records use the versioned step list). UI must surface "published quests retain historical steps for active attempts". Deletion is not "destructive to players".
- **Mapping to old reusable element complexity:** *Excellent win.* Replaces Edit_Page (55 wfs of tab/conditional/show/hide/save for 14 page_types + self-refs + multi-lang) + Existing_Quest (63 wfs of list mgmt) with 1-3 focused React components + server mutations. No SetCustomState equivalent explosion if state is normalized (steps: StepDraft[]). No need to simulate next/hint navigation in editor (linear from list order). The "cost" of in-place editor is paid once in modern component model, not 100+ imperative rules. Code volume for constructor surface: 10-20% of old WF count in equivalent "logic lines".
- **Recommended data entry for answers/gifts (in this variant):** As spec — raw multiline textarea for answers (split on publish/save by /\r?\n/). For gifts: toggle or "Gift step" kind + Gift_Coins-like number input + gift narrative textarea. (See recs section below for why this is weak.)
- **How it supports offline bundle generation:** *Directly and simply.* The working steps (after multiline split into string[]) + quest meta are the exact source for snapshot serialization. Publish handler: `const snapshot = { version: nextVer, steps: currentSteps.map(s => ({...s, answers: parseMultiline(s.answersRaw)})) }; await createQuestVersion(questId, snapshot); generateOrReferenceBundle(snapshot);`. No transform loss. Media handling: uploads produce URLs that the bundle packer (separate or same step) can include or reference. Very maintainable path from constructor state → bundle.
- **Maintainability (constructor code itself readable/maintainable):** **Highest of variants if disciplined.** Small surface: list as <SortableSteps steps={drafts} onReorder=... />, <StepEditor kind={...} onChange=... /> with <AnswerMultiline raw={...} onChange=... /> (internal split only at boundary), media components reusable. Typed (interface GameStepDraft { kind: 'physical' | 'answer'; answersRaw?: string; geo?: {lat:number,lon:number}; ... }). No preview sync logic. Easy to unit test the splitter, kind validators, serializer. Risk of regression to unmaintainable: if every flag gets its own state + useEffect("sync media to preview that doesn't exist") or giant switch(14 kinds). Keep YAGNI: implement only needed fields from 04.
- **Author productivity:** Medium. Fast for metadata + bulk add of simple steps. Slows on polish/verify cycle.
- **Correctness (hard to publish bad content):** **Lowest.** Relies on author vigilance + any minimal server checks. Easy to ship wrong answers list or missing media or bad geo. Given frozen-snapshot risk (03), this is *unacceptable long-term* for a correctness-critical authoring surface. "Hard to publish bad" fails.

**Skepticism summary for V1:** Satisfies letter of decisions and MVP cut. But the self-critiques in source docs already flag preview cost and import-as-alternative. For a product whose value is *content quality*, making authoring error-prone and slow-iteration is a strategic flaw. Good first implementation target (fast to ship), but plan to evolve data entry and gates immediately.

---

## 3. Variant 2: Richer Integrated Preview (WYSIWYG Step Editor with Side-by-Side or Modal Player Preview, Even if More Complex than "Acceptable")

**Description:** Step editing is still form-based (or "WYSIWYG" for text blocks if rich needed, but keep plain per scope), but the UI includes a **live or on-demand preview pane** (split view on desktop, or "Preview this step" / "Preview full quest" modal/drawer). The preview *renders using the exact same player components* that the real /quest flow uses (or a faithful subset): <PlayerStepView step={currentDraftStep} mode="preview" simulatedCoins={...} onSimulateAnswer={(val) => showMatchResult(parseAnswers(draft), val)} onSimulateHint={() => ...} />. For full sequence: a simulator that walks the current draft steps list in order, maintaining fake attempt state (current pos, spent coins from gifts/hints, submitted answers for this sim). Media uploads update preview immediately (optimistic or after save). Geo: preview shows embedded mini-map with pin (clickable). Answer list: preview shows the input field + "submit test" that runs client match logic live. Side-by-side: editor left, preview right (or tab). "Publish" still explicit + external full player test recommended for final validation (real PWA/offline/device). Even if this exceeds the "no high-fid required" decision.

**Full Cycle Critique (maximum skepticism):**

- **Authoring velocity:** *Highest potential.* Edit text → see rendered in player UI instantly. Change answers list → test submit in preview pane without leaving. Swap media → thumbnail + simulated load in preview. Move geo → pin jumps. Spend "hint" in preview → see reveal. Reorder → "play" the new sequence in sim to spot flow issues. Iteration loop = seconds, not minutes. For internal team, this multiplies content quality and speed. "Switch to real" still available for final sign-off (real auth, real coins economy, real offline after download).
- **Error proneness:** *Lowest.* Visual + interactive feedback catches: "this text is too long for the card", "media didn't load (404 in preview)", "geo pin is in ocean (map shows)", "my answer list has '' entry (test submit shows weird)", "hint image not appearing on spend", "after reorder this physical step now follows a gift weirdly". Authors *see* the player experience of their exact current draft. Catches the exact hotspots (wrong answers list via test box, bad geo via map, missing media via broken img).
- **Versioning implications:** Unaffected — preview is *always of the working/draft copy*. Publish still the only version trigger. Preview can even show "this change would be in vN+1". Excellent. Simulator can be "what if I publish now" without committing.
- **Preview fidelity vs acceptable:** *Much higher authoring fidelity* than pure external. Uses real components → consistency (if you share code, preview *is* the player rendered against draft data). Still, "integrated" != "the real PWA on real device with real serviceworker cache + real location + real attempt persistence". Hence keep the "save + switch to real test user" as the gold standard for release; integrated is for during authoring. Risk: authors over-trust the sim (e.g. sim doesn't model multi-attempt reset, or coin earning from prior quests, or exact bundle download size). Divergence risk if preview renderer forks from player (must share).
- **Reordering / deletion:** Preview/simulator makes impact *visible immediately* ("play from start in preview" shows the new order or gap after delete). Better than list-only.
- **Deletion in published:** Same versioning story; preview/sim helps author understand they are editing future only.
- **Mapping to old complexity:** Mixed. On one hand, avoids old reusable bloat by using *shared real components* for preview (DRY win vs. old having separate "Slide_*" reusables per type with 21 wfs on Slide_Error alone etc.). On the other, adds preview orchestration code (state for sim attempt, "render in preview mode" props, simulated data providers) that old never had cleanly (old "preview" was probably hacked via the same pages with test data). Could bloat the admin surface more than lean. But overall still << 55+63 wfs because modern composition + typed data > imperative show/hide per type.
- **Data entry answers/gifts:** Form can be richer because preview gives immediate payoff: answers become editable list (chips or inputs) *with live "Test answer" box in the preview pane or editor* that runs the exact membership logic the client will use on the snapshot. Gifts: preview shows the gift reveal UI + coin award animation when "reached". Structured entry becomes natural.
- **How supports offline bundle:** *Strongly.* If preview/simulator re-uses or exercises the *exact serializeToSnapshot(draft)* function that publish uses, then every preview is also a "bundle readiness" check. The act of previewing forces the data model to be bundle-serializable at all times. Media in preview uses same URL scheme as bundle packer. Excellent for correctness of bundle gen.
- **Maintainability (constructor code itself):** **Medium — the riskiest for bloat.** Requires: (1) clean extraction of player rendering into shared `components/player/StepView.tsx` (or equiv) that accepts "data only, no real attempt hooks" for preview; (2) a SimulatorContext or hook that walks steps, manages fake local state (currentStep, completions, coins, submittedForThisStep); (3) layout (resizable split or modal — responsive pain on "admin on phone"?); (4) handling unsaved changes in preview (preview live on draft state, or "apply edit to preview" button). If done poorly: god "ConstructorWithPreview" component, heavy useEffects for sync, duplicated logic "in sim vs real", hard to test (sim state machines). If done well (composition, dependency inversion for attempt state): very maintainable, and *improves* overall app (player components get better isolation). Still more lines than pure lean. Violates the "no high-fidelity... at launch" decision + "preview is easy to say hard to build" self-critique. Adding this now adds scope/complexity/risk to MVP.
- **Author productivity:** Highest for the internal authoring loop.
- **Correctness (hard to publish bad):** High. Visual + interactive sim + live match test makes bad lists/geo/media *obvious before the Publish button is even clickable*. Can add "preview passed" soft requirement.

**Skepticism summary:** This is the "richer" that the task asks to critique "even if more complex than acceptable". It directly addresses the velocity and error proneness deconstructs. The main objections are (a) explicit decision against high-fid at launch (we would be choosing to exceed scope), (b) implementation cost and divergence risk (state mgmt between editor + preview is exactly the "hard" called out), (c) for a *small internal team* the external test may suffice if "test user" friction is engineered low (one-click "launch as test on this quest" that opens player with pre-granted access + seed data). Building it well requires the same shared component discipline that is good anyway. Worth considering post-MVP or as stretch for v1 if authoring velocity is measured and found lacking.

---

## 4. Variant 3: Import-First / Low-UI (Markdown/JSON/YAML Step Definitions with Validation + Visualizer; Constructor Is Mostly Importer + Light Editor)

**Description:** Primary authoring surface is **not** a rich form builder but a text/structured-data importer + visualizer. Quest metadata still has a small form. For steps: primary input is a big textarea or file drop for a document in a chosen format:
- YAML (preferred for structure): 
  ```yaml
  steps:
  - kind: physical
    title: "Statue hands"
    main_text: |
      Go to the fortress. Find the statue. Touch the cold metal hands...
    place: "Central square, by the fountain"
    geo: [55.123, 37.456]
    has_hint: true
    hint_text: "Look behind the left hand"
    # no answers
  - kind: answer
    main_text: "How many windows on the memorial?"
    question: "Enter the number"
    answers:
      - "12"
      - "twelve"
      - "12 окон"
    media:
      - role: primary
        url: "https://.../memorial.jpg"  # or upload handler
  - kind: gift
    main_text: "You found the treasure!"
    gift_text: "A golden coin from the era..."
    gift_coins: 5
  ```
- Or Markdown with YAML frontmatter per step or `---` separators + special blocks.
- Or pure JSON (less author friendly).
Author pastes/edits the text, hits "Parse / Import / Validate". Parser (strict schema) produces internal step list or errors with line numbers ("answers[1] is empty", "geo must be [lat,lon] numbers", "kind=answer requires non-empty answers[]", "media url unreachable or not image"). Visualizer: read-only (or lightly editable) cards/list derived from the parse tree — shows exactly what will be published, with badges, truncated content, mini media thumbs if fetchable. Light editor: click a visualized step → small form to tweak one field (or "edit raw" jumps back to text with cursor). "Export current as YAML" for roundtrip / source control. Still have the ordered list view for reorder (after import, or import can have explicit "position"). Publish explicit, same as others. "Preview" = parse success + "launch in test player" (or optional "render preview from parsed tree").

Constructor code is "mostly importer + light editor" + the visualizer + serializer (the parsed model *is* close to GameStep).

**Full Cycle Critique (skeptical):**

- **Authoring velocity (internal team):** High *for text-comfortable authors* (devs, power users, or team that likes Google Docs + export). Bulk operations trivial (edit in external editor, paste whole quest). Copy-paste from existing quest descriptions or scripts. Reorder = cut/paste sections in text (or post-import list reorder). For non-technical admins (if any on internal team), *velocity killer* — syntax errors, escaping Russian text in | blocks, forgetting list indentation. Visualizer mitigates by giving feedback. If team is small and technical-ish, this can be *faster* than clicking forms for every step (per 04 self-critique: "very simple Markdown + JSON ... might be higher leverage").
- **Error proneness:** *Lower structural errors, higher syntax/human-format errors.* Parser + validation catches at import time: empty answers for answer kind, invalid geo, missing required per kind, duplicate positions, bad media refs (if validator fetches). "Wrong answers list" becomes "I see in visualizer that my list parsed to 3 items including a blank — fix in text". Bad geo: parse fails or visualizer shows "invalid". Missing media: validator can warn "url 404 or not image". Still possible to ship semantically bad content (wrong synonym, bad phrasing) but structure is enforced. Russian text in YAML can have indent/quote issues.
- **Versioning implications:** Same as lean — text defines the current draft/working. Parse → internal model → publish snapshots. Text can be stored as "source" alongside snapshot for human audit (nice bonus). Reorder/delete in text or in visualizer list; both mutate the "current definition".
- **Preview fidelity:** Low in-authoring (text), but visualizer can include "step render preview" cards (using shared player components against the parsed tree). Full fidelity still via external test player after parse+save. Can add "simulate full play from this YAML" button that walks the parsed steps. Good enough, and cheaper than full side-by-side.
- **Reordering / deletion:** In text: manual (easy for small N, painful for 30+). Post-parse: use the list visualizer for drag reorder (then "re-export to text" or keep internal order as source of truth). Deletion: delete section in text or from viz list. Same versioning safety.
- **Mapping to old complexity:** *Best avoidance.* Old was heavy UI editor fighting 14 types + 36 fields + self-refs. This is data-first: the definition *is* the model. No 55/63 reusable WF monsters; the "editor" is a parser + form for tweaks + list for order. Closest to "we control the stack" — define clean schema once (zod/yaml schema shared with bundle + API), UI is thin. Migration from old page_constructor becomes "export old to this YAML, hand-edit, import".
- **Data entry for answers/gifts:** *In the format:* answers: [ "12", "twelve" ] (list, no multiline ambiguity). Gift: explicit kind or gift: {text: "...", coins: 5}. Structured by nature → no trailing newline problems. Can still offer "paste answers one per line here" helper that populates the YAML list. Excellent.
- **How supports offline bundle generation:** *Best of all.* The parsed/validated model can be *the* canonical internal representation. `serializeToBundleSnapshot(parsedQuest)` is near-identity. Import path and publish path use same serializer. Roundtrippable (export snapshot as YAML for debugging/audit). Validation at import = validation for bundle readiness. Media handling: importer can accept uploads and rewrite urls into the structure, or leave refs for later bundler.
- **Maintainability (constructor code):** High if parser is isolated. Code: one `importQuestDefinition(text, format)` + schema validator + normalizer (trim answers etc.) + errors UI + visualizer (map parsed steps to cards, using shared <StepSummary step={p} />) + minimal tweak forms (that mutate the tree or roundtrip to text) + exporter. The heavy logic is schema + (de)serializer — highly testable, pure functions. Less UI state than form builders. Risks: format choice debates (support 2 formats? maintenance), parser bugs on edge Russian/unicode/indent, keeping visualizer in sync with schema changes, authors editing "source of truth" text vs. the DB steps (two sources). Still far more maintainable than old or a bloated rich preview. YAGNI: start with one format (YAML), strict.
- **Author productivity:** High for the right authors; potentially low discoverability/friction for others. "Low-UI" can feel like "no UI" if visualizer is weak.
- **Correctness (hard to publish bad):** High on structure (parser gates). Medium on semantics (author still writes the content; visualizer helps review before publish). Pre-publish can require "last parse succeeded with 0 errors + N steps".

**Skepticism summary:** Directly called out as viable alternative in the source 04 self-critique. For a small internal team that values speed and data integrity over "delightful form clicking", this can be superior to lean forms. Downside is accessibility of the tool itself (if the internal team includes non-technical content people, forms win). Bundle support and error reduction on the *structure* (answers lists especially) are compelling. "Constructor is mostly importer" means the UI code stays small and the domain model (schema) does the work — aligns with "readable/maintainable constructor code". Strong candidate for v1 or as primary + forms as fallback.

---

## 5. Variant 4: Invention — Step Library + Composer with Templates + Structured Editors + Pre-Publish Validation Gates + Inline Mini-Previews (Physical/Answer/Gift Templates as First-Class)

**Description (my invention, grounded in all prior + gaps):** 
The constructor is a **composer** (not just list + form, not just importer).
- **Step Library / Palette (left or top):** Clickable or draggable templates: "Physical Observation Task" (pre-sets kind=physical, confirmation UI hint, optional geo), "Answer / Knowledge Question" (kind=answer, shows answers editor), "Narrative Bridge" (pure continue), "Media Scene" (video/image heavy), "Gift / Reward Step" (pre-sets gift fields + coins award, kind often terminal-ish), "Coin-Gated Hint" (can be attached or standalone), "Terminal / End" (congrats + review trigger). Each template has a short description + example ("Touch the statue hands...").
- **Sequence Composer (center):** Sortable list of *step cards* (drag to reorder; each card: type icon + title + 1-line preview of main_text + badges: "media ✓", "geo 55.1,37.4", "hint", "gift +5", "3 answers", warning icons). Add by dragging template onto list or + button (inserts at end or position). Click card → opens focused editor panel (right or modal, but not full page switch).
- **Per-Step Editor (structured, template-aware):** 
  - Kind locked by template but changeable.
  - Text fields as appropriate (rich enough textarea or simple MD for main/place/hint/gift; keep no full WYSIWYG per scope).
  - **Answers (structured, not raw multiline):** <AnswerListEditor>: chips or editable rows. + button adds new "answer" input. X removes. "Paste lines" button splits clipboard into new rows (helper for migration). Inline "Test match" input: type a string, instantly shows "Matches ✓ (exact)" or "No match" using the *same* client matching fn that will be in the bundle/player. Prevents the "wrong list" error at entry time. De-dup on add optional.
  - **Gifts:** When template="Gift" or "is gift" flag: dedicated subform — gift narrative (textarea), coins award (number, with presets 0/5/10 from old patterns like countCoinMadeIt / Gift_Coins), optional "award only on first completion?" (future). Preview shows the prize reveal.
  - **Media:** Drag-drop multi upload zone per role (primary, hint). Thumbnails + remove + "use as hint image too". Immediate mini-preview.
  - **Geo:** Lat/lon numbers + **interactive mini map** (embed Leaflet/Mapbox light, click to place pin, updates numbers; or search). Warns if coords look invalid (out of city bounds if we have city data).
  - **Hint:** Toggle "has_hint" → reveals gated content editor (text + image upload) + "costs X coins" (default 1? from old Buy_hint).
- **Inline Mini-Preview (per step card or in editor):** Collapsible or always-visible small render of *this step as player sees it* using shared player components against the *current editor values* (not full sim). "Continue" button does nothing in mini; answer input + "submit test" runs match; "buy hint (sim)" reveals; gift shows award. For physical: big "I did it" button. Catches render/layout/media issues per step without full play.
- **Full Sequence Simulator (optional modal, cheap):** "Simulate play from here" button on list: walks current composer state in order, fake attempt, shows cumulative coins, allows submitting answers/hints in the real UI components. Not side-by-side always-on (to respect "acceptable" spirit), but available.
- **Pre-Publish Validation Gates + Checklist (hard to publish bad):** Publish button is prominent but *disabled or red with tooltip* until:
  - >= N steps (or at least start + terminal?).
  - Every answer-kind step has >=1 trimmed non-empty answer.
  - No blank-only answers.
  - All steps have main_text (or equiv required per kind).
  - Media: primary present for steps that declare it? (soft or configurable).
  - Geo sanity (optional).
  - "Run checklist" button produces human-readable report: "Step 7 (answer) has 0 answers — fix", "Step 3 missing primary image", "Total expected bundle size est. 4.2MB", "No terminal step — players may not see review prompt", "Duplicate answer strings across steps? (ok but review)".
  - Optional "dry-run serialize" that exercises the exact bundle snapshot code and shows the JSON or "would produce valid vN".
- **Other:** Save draft always available. "Duplicate this step", "Insert template here". Version awareness banner: "Editing content for next publish (current published = v3, 142 players on v2 or earlier)". "View past versions" (read-only). Export to YAML/JSON (synergy with V3). "Test in real player" (saves current draft, grants temp test access, opens player — fulfills the acceptable preview).
- **Data model in composer:** Always works on in-memory + persisted draft steps array (typed GameStepDraft with answers: string[] already split, not raw). Multiline is *only* a paste helper.

This is "step library + composer with templates for physical/answer/gift" as suggested in task prompt.

**Full Cycle Critique (skeptical, self-applied):**

- **Authoring velocity:** Highest for frequent internal use. Templates reduce "what fields do I need for a physical observation?" decision + setup time (pre-fills sensible button text, confirmation copy, etc. from domain knowledge). Structured answer editor + test matcher means "add the 3 synonyms I just thought of" is 10s not "edit textarea, count lines, hope". Map picker + media thumbs + mini preview = see problems instantly while still in flow. Checklist catches before the "publish" click. For reordering a 20-step quest: drag is natural. Overall: authors spend time on *content* not on "fighting the UI" or "did I remember to set the gift coins?". Matches "authoring velocity for internal team".
- **Error proneness:** *Lowest by design.* Structured answers + live tester directly attacks "wrong answers list". Map + sanity directly attacks "bad geo". Thumbs + mini-preview attack "missing media". Templates + required fields in schema attack "wrong kind + fields". Pre-publish gates make it *mechanically hard* to publish bad (you have to deliberately override or fix). Still possible to write *semantically* wrong content (bad puzzle answer, wrong lat by 0.01 that looks ok on map), but the mechanical/hotspot errors are gated. For published quests: the gates apply to the working copy before each publish.
- **Versioning implications:** Explicit publish still the trigger. All composer state is the "current working for next version". Snapshots capture the fully validated/composed structure at publish time (including the answers[] as finalized list, not raw). Reorder/delete in composer affect only the working; publish versions it. Deletion of a step that had a gift: the gift award won't happen for new attempters (correct, versioned). Old snapshots keep the step + its gift. Perfect.
- **Preview fidelity vs acceptable:** Per-step mini + optional sequence sim give *high authoring-time fidelity* for the step content, render, interaction, answer behavior, hint/gift reveal — without always-on heavy side-by-side. Still fulfills "acceptable" by having the prominent "Test in real player (saves + opens as test user)" that exercises the *full real stack* (PWA, real attempt creation, real coins from this quest's gifts, real sync, real offline after download). Best of both: fast inner loop + real outer validation. Higher fidelity than pure lean or import, cheaper/safer than always-on rich V2.
- **Reordering in linear:** Drag on composer list is the gold standard for sequences. Visual order = execution order. Simulator can "play" the reordered to validate flow.
- **Deletion of steps in published quests:** Same safe versioning. Composer can show "N players on older versions that include this step" (if we track per-version usage lightly). Delete is low-risk.
- **Mapping to old reusable element complexity:** *Direct and superior attack.* Old had 14 page_types + duplicated editor types + 55/63 wfs of conditionals for every variant + self-ref wiring for "next" and "hint". Here: templates are *semantic first-class citizens* (Physical Task template knows it's confirmation-only, no answers field ever appears). No self-refs (order from list). Fields conditional cleanly in the composer editor (React conditional render on kind, not 100s of "when Page_type = X show Y"). The mini-preview + simulator use *shared player components* (the thing we should build anyway for DRY between admin/player). Reorder is one sortable primitive, not custom state + buttons per reusable. Result: the authoring surface code can be larger in features but *much smaller and cleaner in accidental complexity* than the old monster reusables. The "55+ workflows" equivalent is now a handful of focused, typed, composable pieces + pure domain functions (matchAnswer, validateForPublish, serializeSnapshot). This is what "we control the whole stack" enables.
- **Recommended data entry for answers/gifts (core of this variant):** 
  - **Answers:** AnswerListEditor (array of controlled inputs or contentEditable chips). Add, remove, reorder within list, paste-multiline importer, live test box using client matcher. Serializes cleanly to string[] for bundle. Directly improves on the "simple multiline" decision without violating spirit (multiline is still supported as *input method*). Prevents exactly the "wrong answers list" class of errors that get frozen.
  - **Gifts:** GiftTemplate or flag that surfaces dedicated sub-editor: narrative text + coins number (with domain presets pulled from old Gift_Coins / 5-coin patterns) + preview of award moment. Can be a step kind or attached to any (but recommend primary "Gift" step kind for clarity in linear sequence). In snapshot: the gift fields travel with the step so bundle knows to award on completion of that step.
- **How it supports offline bundle generation:** Excellent. Composer always maintains data in (or easily convertible to) the exact shape needed for snapshot (answers as string[], media as manifest, geo as object, etc.). Pre-publish "dry-run serialize" exercises the bundle path. Validation gates ensure the thing you publish will produce a valid, complete bundle (no missing answers that would break client validation). The serializer can be the same function used by the offline downloader/bundler. Templates ensure consistent presence of required bundle fields. For historical import (V3 synergy): old page_constructor records → transform script → YAML or direct import into composer → validate → publish as new versions.
- **Maintainability (constructor code itself readable/maintainable):** Medium-high, but *designed for it*. Pieces: StepTemplateLibrary (static config + icons), SequenceComposer (dnd list of StepCard), StepEditorPanel (switches on template/kind, composes sub-editors), AnswerListEditor (self-contained, exports the match tester), GeoMediaEditors (reusable), MiniPlayerPreview (thin wrapper over shared <PlayerStep step={draft} isPreview />), PrePublishValidator (pure fn + checklist UI), useQuestDraft hook or state machine. All small, single-responsibility, heavily typed (discriminated unions for kinds prevent impossible states like answers on physical). Shared code with player = less total code, consistency. Testable in isolation (validator unit tests with bad/good cases; answer matcher tests). Readable: a dev can read StepEditorPanel and understand the whole authoring model. Risk of unmaintainable: if templates proliferate without a registry, or editor panel grows to 500 lines of conditionals (mitigate with subcomponents per kind or form config). Compared to old: order of magnitude better (no 1,163 wfs, no 36-field bags, no multilingual everywhere). Compared to lean V1: more code, but the extra is *domain value* (templates, gates, structured editors) not accidental UI state. If we start with lean and evolve toward this, the components are additive.
- **Author productivity:** Highest. Templates + structured + immediate feedback + gates = authors produce correct, polished content faster with fewer "oops published bad" cycles.
- **Correctness (hard to publish bad content):** Highest. Mechanical errors (the ones that freeze badly) are hard/impossible to ship past the gates + structured entry + visualizers. Semantic errors still possible but authors have better tools to catch them (mini previews, sim, test matcher). Given the offline frozen-snapshot model, this is the variant that best protects the business from "bad content in the wild for paying players who started on vN".

**Skepticism summary (self):** This is richer than "acceptable MVP" preview and more UI than pure lean or import. It adds scope (templates, map embed, dnd lib, validator, structured answer component, mini previews). For a true minimal launch it may be too much — risk of delaying the "admin can create+publish+preview end-to-end" success criteria while building composer toys. However, the core (templates + AnswerListEditor + basic gates + mini per-step using shared renderer + explicit publish) can be staged: lean forms first, then replace the answers textarea with the list editor (low cost, high correctness win), add 2-3 templates, add validator as pre-publish step, add mini-preview later. The invention is "evolutionary from lean" not "all at once". It directly mitigates the highest risks called out in the task (error proneness on answers/geo/media, correctness for frozen versions). For maintainability: if we keep components small and share with player, the constructor code stays more readable than a hacked rich V2 or a syntax-heavy V3 for mixed authors. Worth the investment because authoring is the *only* way content enters the system, and bad content has permanent cost under the versioning model.

---

## 6. Recommended Data Entry for Answers and Gifts (Cross-Variant, Optimized for Correctness + Bundle)

**Answers (the highest-leverage risk area):**
- **Do not use raw uncontrolled multiline as the *only* UI** (even though decision says "simple multiline" — the decision was for representation and initial client matching, not mandating the worst possible input widget).
- **Recommended:** Structured list editor (rows/chips) as primary. 
  - Add/remove/reorder answers explicitly.
  - "Import from lines" / paste helper that does the split (so power users or V3 import still have the "one per line" flow).
  - Trim + filter empty on every change + on serialize.
  - Live "test a submission" box that uses the *exact* isCorrect( submitted, currentList ) logic that will ship in the client bundle for that version. Author sees immediately " '42 ' would fail today".
  - Visual count + list of current values (no mystery newlines).
- Why: Directly reduces "wrong answers list" errors that get snapshotted and frozen for offline attempters. Still produces clean `string[]` for the bundle snapshot. Matches "simple" spirit while adding guardrails. In code: pure component, easy to unit test the normalizer + matcher.
- In all variants: the answers[] in the draft is what publish puts verbatim into the version snapshot (no further transform).

**Gifts:**
- Treat "gift" as either a dedicated step kind (recommended for linear visibility: players see "you earned a prize" moment) *or* an orthogonal flag on narrative/physical/terminal steps.
- Data entry: Clear subform (only visible when relevant): gift narrative text (can be multiline), coins award (number input + presets from domain: 5 for completion bonuses, whatever old Gift_Coins values were), optional media for the gift "unboxing".
- In bundle/snapshot: the gift fields must be present on the step so client can award locally on completion (per offline model) and server can reconcile.
- Old mapping: Gift_Coins lived on page_constructor + page_type=gift + special Slide_give_prize reusable. New: explicit, no magic number on random pages.
- In composer/templates: "Gift / Reward" template pre-creates the step with the subform open and a sensible default coins value.

This data entry is recommended regardless of variant chosen for the overall surface; it plugs directly into the bundle serialization path.

---

## 7. How Each Variant (and the Rec) Supports Offline Bundle Generation

Recall (03): Bundle = self-contained snapshot with full ordered steps + content + **plain acceptable answers list for client validation** + media + geo + version + hash. Publishing = the act that makes a new snapshot available.

- **V1 Lean:** Direct. Working draft state (after any multiline split) → publish → serialize (or the steps table) → snapshot row + bundle artifact. Simplest code path. Weakness: if the split logic or form allows junk in the list, junk goes into every bundle for that version.
- **V2 Rich Preview:** Stronger. Because preview/sim exercises the renderer *and* can call the same serialize fn, "what I preview" == "what goes in bundle". Live answer test in preview uses the bundle's matcher. Media uploads in editor are the same assets referenced in bundle. Forces the data model to stay bundle-shaped.
- **V3 Import:** Strongest for data fidelity. The YAML/JSON *is* nearly the snapshot shape. Parse + validate → internal → publish uses the identical structure. Export of a published version gives exact audit of what was bundled. Ideal for migration and for power users who want to diff versions in git.
- **V4 Composer (rec base):** Excellent + proactive. Draft state in composer is *designed* as the pre-serialization form (answers already normalized list, templates guarantee fields). Pre-publish gates + "dry run serialize" mean you cannot easily generate a broken bundle. Templates + structured editors ensure answers/geo/media are present and valid when serialized. The validator can be the same as (or stricter than) what the downloader/bundle packer uses.
- **Cross-cutting:** All variants need a single source of truth for the GameStep snapshot shape (type or schema). Publish flow owns "take current authored → immutable versioned snapshot → trigger bundle materialization (copy media, embed answers, hash, store or CDN)". Constructor never mutates published snapshots. For old attempts: retain the ability to serve the exact historical snapshot (or the client re-downloads from its original bundle if local cleared).

The constructor's job w.r.t. bundles is: produce *correct, complete, versioned* authored content that the publish/bundle pipeline can trust without heroic cleanup.

---

## 8. Recommendations (for Maintainability of Constructor Code, Author Productivity, Correctness)

**Primary Recommendation: Start with disciplined Variant 1 (lean), but implement the *data entry and gates* from V4 immediately, and design for evolutionary addition of V4 composer elements (templates, structured AnswerListEditor, mini-previews, validator) and V3 import as power-user path. Do not build full always-on V2 side-by-side in v1 (respect the locked "acceptable" decision and self-critique).**

**Rationale (tied to all criteria):**
- **Maintainability of constructor code:** Lean base = smallest, most readable surface (list + focused per-step form + explicit actions). Adding V4 pieces *incrementally* (first replace the answers textarea with AnswerListEditor + paste helper — 1 component win on correctness; then registry of 4-5 templates that just prefill the form; then per-card mini using already-shared player renderer; then checklist as a pure validateDraft(draft) called on publish) keeps files small and focused. Avoids V2's preview sync complexity in launch window. V3 import can be a separate "Import" tab or page that produces the same draft shape. The old 55/63 wf hell is avoided because we use typed composition + shared domain logic, not per-type imperative state machines. Constructor code stays reviewable by one engineer.
- **Author productivity:** Lean + structured answers + templates + mini + gates gives most of V4's velocity benefit without the full cost upfront. Internal team gets fast creation (templates), fast fix for the #1 error source (answers), fast visual check per step (mini), and "real player" for final (acceptable). Iteration still better than pure raw-lean. If measurement shows preview friction is killing quality, *then* add more integrated sim (post-launch or as v1.1).
- **Correctness (hard to publish bad content):** The V4 data entry + gates are non-negotiable given the frozen-snapshot risk. Raw multiline + no gates = too easy to ship the exact errors the task calls out. Structured + live test + pre-publish checklist makes bad mechanical content *harder* to publish than in old system (old had no such enforced gates; relied on author +  the 55 wfs of scattered logic). This protects players and revenue (bad first experience on paid quest = refunds? bad reviews? support load).
- **Alignment with locked decisions + self-critiques:** Explicit Publish + external test player preserved. Linear seq supported. No branching. "Simple multiline" honored via paste helper (the representation is still the list of strings). "No high-fid required at launch" respected (mini per-step and optional sim are lighter than full WYSIWYG side-by-side). Import alternative from 04 self-critique is included as secondary path.
- **Bundle + versioning support:** All paths lead to the same clean snapshot shape. Versioning story (current working → publish = snapshot) is identical and simple across.
- **Migration / old mapping:** The structured model (kinds + answers[] + flags + explicit gift/ hint fields) makes transforming old page_constructor (14 types + Answer list + Gift_Coins + self-refs + multi-lang cut) mechanical. Composer or import can be the target for migrated content.
- **Risk mitigation:** If lean base is shipped first, we hit the v1 success criteria ("admin can create complete quest... publish... preview end-to-end") fastest. The correctness upgrades (answers editor + gates) are high-ROI and low-regret additions that don't expand the "preview" surface.

**Concrete Implementation Path (Status + Path):**
- **Current status (as of this analysis):** Purely specified (business/04 + 08 decisions). No constructor code exists in workspace. Old Bubble authoring is fully deprecated (dupe types + 55/63 wf reusables + 36-field bags to be cut).
- **Path:**
  1. Define shared types + serializer first: `GameStep`, `QuestDraft`, `serializeToSnapshot(draft): QuestVersionSnapshot`, `validateForPublish(draft): {errors, warnings}`, client `isAnswerCorrect(submitted, answers: string[])` (used in preview test *and* real player *and* bundle).
  2. Build lean V1 surface using the shared types (metadata form, steps list with basic reorder via array, StepForm with kind select + conditionals + *structured AnswerListEditor from day 1* + media/geo/hint/gift fields + Save + Publish that calls validate + serialize).
  3. Implement "Test in real player" that persists draft, creates/finds test grant for admin, links to real player flow (or special ?test=1 mode).
  4. Add 3-5 templates in library (Physical, Answer, Narrative, Gift, Terminal) that create well-formed drafts.
  5. Add per-step mini-preview (reuse player components against draft).
  6. Add pre-publish checklist UI + gate on the Publish button.
  7. Add import tab: paste YAML/JSON → parse/validate → load into composer list (V3 path).
  8. Later (or if velocity data demands): richer sim or side preview.
- Keep constructor code in its own feature slice (e.g. `admin/quests/constructor/*`): small components, no leakage of player attempt state except via explicit preview/sim hooks.
- Every publish creates a new immutable version snapshot. Support for serving historical snapshots for in-progress attempts is a dependency (see ANALYZE-02 if exists).
- For deletion/reorder on published: UI copy + backend invariant: you edit the *next* content only.

**Trade-off Accepted:** We are deliberately exceeding "minimal form + raw multiline" in data entry and adding gates because the cost of *not* doing so (frozen bad answers/geo/media for real paid players under offline model) is higher than the added (still maintainable) code. This is the relentless critical analyst position.

---

## 9. Cross-Cutting Risks, Open Questions, and Self-Critique of This Analysis

**Risks exposed:**
- Any variant that makes "publish bad" easy amplifies the offline versioning risk (03): buggy vN lives forever for attempters who started on it. Analytics on submitted answers per version becomes mandatory for authors to notice and correct in vN+1.
- Preview strategy: if external test player friction is too high in practice, authors will not use it → quality collapse. Measure this.
- Linear assumption: if real content has frequent "optional side observations" or player choice, forcing sequence in composer hurts expressiveness (noted in 04/07).
- Media in bundles: constructor media handling must produce refs that the ~5MB offline packer can actually cache without 404s or bloat.
- Team reality: if internal authors are not text-inclined, V3 will be shelfware; forms/templates win.
- Overbuilding: V4 full on day 1 delays MVP. Staged is mandatory.
- Maintainability backslide: even with good intentions, the StepEditor can grow conditionals for every new flag. Enforce component-per-kind or config-driven forms.
- Old data: migrating 556 page_constructor records with their 14 types + scattered Gift_Coins + Answer lists + self-refs into clean linear steps + answers[] will require manual review per quest + the structured editor will help but not eliminate author time.

**Open Questions (to feed 07_ and synthesis):**
- Exact client matching rules for the answers list in first version (exact? includes/trim? numeric coercion?). The constructor test box must match exactly.
- Do we retain full historical snapshots server-side (for re-download of exact old version for in-progress attempts after local clear), or only the answers list + minimal?
- Preferred primary format for V3 import/export (YAML? JSON? both?) and whether authors will keep "source" in git or just the DB.
- Is "gift" always its own step, or can every step type "also be a gift on completion"?
- How many templates initially (to avoid V4 bloat)?
- City bounds for geo validation (to make bad geo harder)?
- Admin test player experience: one-click from constructor, or separate "impersonate test user" flow?

**Self-Critique of this report:** I applied maximum skepticism to the current lean (as required) and to richer options (including calling out scope violation). I invented V4 as a concrete, staged evolution rather than hand-wavy. All claims are mapped back to source lines in business/ + discovery/ counts. However, without real usage data from the internal team or walk-through of 2-3 actual current quests' step lists (as repeatedly requested in 07_/09_), some velocity/correctness assumptions remain hypothetical. The recommendation is conservative (lean base + high-value correctness upgrades) precisely because of the "no high-fid at launch" lock. If the parallel ANALYZE reports on versioning/offline/GameStep produce different invariants, this must be revisited.

**Relation to other ANALYZE tasks:** This directly informs ANALYZE-02 (versioning/publishing mechanism), ANALYZE-03 (GameStep model must be what the composer edits), ANALYZE-01 (snapshot shape from constructor), migration (09). The shared serializer/validator is a cross-cutting primitive.

---

## 10. Conclusion + Deliverable Status

The current lean spec is a solid, decision-aligned MVP that can be built with highly maintainable code and avoids every pathology of the old 55/63-wf reusable editors and 36-field + 14-type duplication. However, it under-addresses the error proneness and "hard to publish bad" requirements in a world where published versions are frozen for offline attempters. Variants 2-4 each improve specific axes (preview fidelity, structural correctness, velocity for certain authors) at cost of complexity or scope.

**Recommended hybrid path (lean base + V4 data entry/gates/templates/minis + V3 import) best balances the three mandates: readable/maintainable constructor code, author productivity for the internal team, and correctness (mechanically hard to ship the wrong answers list, bad geo, or missing media).**

It maps cleanly to the old complexity (eliminates it), uses recommended structured entry for answers/gifts, and produces clean input to the offline bundle pipeline on explicit Publish.

**Status:** ANALYSIS COMPLETE.  
**Path:** Report written to mandated location. Feed to main thread for synthesis (SYNTH-001), cross-review with other ANALYZE-* outputs, then implementation planning once business/ docs are updated with any new decisions. Revisit if real quest examples or team feedback contradict assumptions.

**Full report is the deliverable at the path above.** No other files written. All analysis used only allowed tools and stayed in workspace.

---

*End of ANALYZE-07 report.*  
*Maximum skepticism applied throughout. Grounded in every cited source.*