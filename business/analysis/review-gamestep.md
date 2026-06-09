# REVIEW: ANALYZE-03 gamestep-completion-variants.md (Chief Staff + Critical Analyst Cross-Review)

**Reviewer:** Grok Build subagent (Chief Staff Engineer + Critical Analyst).  
**Date:** 2026-06-09.  
**Scope:** Adversarial deconstruct/expose/rebuild/self-critique *of the report itself*, not re-doing the original analysis. Grounded strictly in: the report file + business/01_DOMAIN..., 03_OFFLINE..., 04_CONTENT..., 08_DECISIONS_LOG.md + discovery/parsed/option_sets.json (14 page_type incl. questionnoanswer/question/question0/gift/lead/...), data_types.json (page/page_constructor fields: Answers list.text, Page_type, Gift_Coins=number, Main_text_RU/Place_RU/Page_name_RU/Button_text_RU/lat/long/Hint_Image/Video_link/Hint/Next_page), element_definitions.json (Slide_Question_no_answer 7WFs, Slide_Question 12WFs, Slide_Lead 7, Slide_give_prize 8, Slide_Congratulations 9 w/ steps_for_accruing_coins_, Slide_Error 21WFs, Slide_Video/Start/Greetings/Hint, mapbox; Edit_Page 55WFs, Existing_Quest 63WFs), SYNTHESIS-NOTE-GAMESTEP-COINS-CONSTRUCTOR.md, FINAL-BEST-PRACTICE-BLUEPRINT.md, 00/06/07/09, and record_counts (556 pages/steps, 21 quests, 1163 WFs). No raw page_constructor rows (report + sources note this limitation explicitly; "Mystery of the Fortress" is the only concrete physical example in business docs). Extreme skepticism; no softening. Short/ruthless.

---

## 1. Deconstruct: Missed Edges/Races + Weighting in Report's Own Deconstruct/Matrix

Report's deconstruct (its §2 edges + §8 matrix) is thorough on locked constraints (uniform physical confirmation-only "no difference", list-of-strings answers from multiline, client full local validation vs snapshot per 08+03, linear no-branch v1, trust honesty, snapshot freeze, coins via gifts/completions, old 14 Page_type as overloaded mess to cut). It correctly cites 07_ risk ("Physical step completion mechanic feels too trivial... reduces the magic"), 03_ "I completed a physical step but later want to undo" → attempt reset only, offline "client match bug = permanently wrong is_correct", version freeze, rebus/numeric/partial/multi-path/linear pressure, invalid combos, undo-after-sync, multi-player, future geo/photo (explicitly cut per 06/08).

**Missed or under-weighted in report's own analysis:**
- Bundle/serialization overhead for rule objects (V3/V4) vs flat fields: 556 steps * (wrapper + type discriminator + nested config) vs flat `completion: {mode, acceptable?, allow_note?}` + top-level supporting. Report flags "bloat vs oversimplification" and "rule objects add indirection" but does not call out cumulative size/CPU for ~5MB PWA target (locked in 08) or parse cost in client snapshot load. Old page_constructor was 36 fields; report attacks dupe but under-calls the delta its hybrid adds back.
- Constructor data-entry races specific to "rule picker": report's V3 rebuild has "optional 'completion rule' picker" + "rule+content combos"; this creates new invalid states (rule on pure narrative? empty rule?) beyond the "physical + answers list" it does call out. Sources (04_ updated post-synthesis, 06_) specify "task kinds (physical vs answer-required), list of acceptable...", no "rule attachment" language. Synthesis explicitly calls this out as added complexity in cross-check.
- Gift coin timing/award edge under "supporting": report good on centralizing vs old scattered (Slide_Congratulations steps_for_accruing_coins_, Gift_Coins on page_constructor, answer_card Complited/You_made_it), but its hybrid (rule on "gift step" or supporting on rule?) risks shifting "award on rule complete" vs "on step advance" ambiguity. Locked (08+03+04+synth): gift is per GameStep snapshot, award on its completion record. Pure supporting on step (not rule) keeps timing clean.
- "Rich content as differentiator" assumption attacked in report's self-critique (§10) but still foundational to its rec. With *zero raw step data* (explicit limitation in report §1 + 09_ + 07_ "walk through 2-3 real quests... identify gaps"), cannot validate whether old 14 types' variety (questionnoanswer vs question vs lead vs gift vs video) was mostly chrome (replaceable by content + custom button_text/Place_RU) or semantic (different flows that uniform + flags would have broken). Report infers from element WF counts (Slide_Error 21WFs shows state hell, not content needs); this is weak evidence. Sources repeatedly flag this gap (07_ open on "exact UI differences", 04_ "we still need to map the concrete examples", 09_ "Source of real quest content... for migration and to validate our GameStep model").
- Matrix misses cross-device merge for physical confirms under "undo" row (03_ "last-write or union" for multi-device; report notes ambiguity for "lied then corrected" but not for honest confirms across devices).
- Over-weight on "atmosphere/future variety" vs under-weight on explicit 08_ language: " 'No difference' means we do not need subtypes or different completion UIs for v1 physical tasks." Report's V2/V3/V4 all introduce differentiation *in the model* (kinds/rules/strategies) even while claiming uniform mechanism. Locked intent was to cut that.
- Under-weight on "exactly one primary" invariant (01_ post-refine + 04_): report's "supporting as flags/combos" and V3 "rule can be on a gift step" risks violating "exactly one" more than pure mode+supporting.

Report's deconstruct is strong on old mess (14 types → 14 Slide_* + 3-21 WFs each + 444 SetCustomState + answer_card flag bag) but its matrix still treats "Current Lean (V1)" as baseline while pushing hybrid that re-introduces named cases.

---

## 2. Expose: Flaws in Report's Variants + Rec (Hybrid V3+light V4)

Report's variants cycle is complete per its mandate (deconstruct/expose/rebuild/self-critique per, matrix, rec, self-critique of whole). However:

- **V1 (current lean, mode+flags, uniform physical):** Report correctly exposes it inherits "reduces the magic" risk (direct from 07_/03_ self-crit) and flag-sprawl risk. But its "still requires many special cases... taxonomy bloat migrated into if/switch" is fair; synthesis accepts this and keeps it *in code handlers*, not data model.
- **V2 (richer kinds):** Report ruthlessly exposes "Taxonomy bloat risk returns immediately... YAGNI... over-engineering for v1... recreates the maintenance surface (per-kind renderers... migration... tests)". Correct; old 14 were accidental (from 09_ "extraction of intent over 1163 workflows / 47 types / duplication").
- **V3 (content + embedded CompletionRule {ConfirmationRule | AnswerListRule | ...}):** Report itself exposes "Rule objects add indirection/complexity... YAGNI for rules beyond the two... may be too abstract for the lean v1 mandate... 'embedded rules' framing may feel heavier than the 'two primary modes' the decisions explicitly chose... more types to maintain than lean mode+flags... constructor more decisions". Its rebuild sketch has named union + `completion_rule?: CompletionRule`. This is the core flaw the report's *own* §10 self-critique flags ("Even the hybrid adds a layer... absolute simplest... might have highest velocity").
- **V4 (strategy/composition):** Similar exposure ("Conceptual overhead... architecture astronaut... still needs the two locked primitives... composition complexity... may be the *least* aligned with the explicit 'lean', 'two primary modes', 'supporting as flags' language chosen in the decisions log"). Report admits "very similar (rules ~ strategies)".
- **The rec (Hybrid V3+light V4: "lean primary rule types + rich content + small composable supporting... `completion_rule: ConfirmationRule | AnswerListRule | null` ... migration maps old Page_type → rule"):** Directly violates KISS/YAGNI for v1. Report's justification ("makes the 'why uniform feels same' problem *author's content problem*... prepares the shape for the edges without overcommitting taxonomy now... Embedded rule makes the *semantics* explicit and versionable per step") is undermined by its own earlier expose of the indirection cost and by the fact that *synthesis cross-review (SYNTHESIS-NOTE §2) already attacked exactly this*: "GAMSTEP rec adds a layer ("embedded CompletionRule") that risks mild YAGNI violation for v1... Named "Rule" types feel like premature classification (old 14 types were accidental; don't recreate taxonomy in data). The hybrid is 'least-bad' but the leaner data-only version... better honors KISS/YAGNI". Blueprint §1 confirms the adjustment: "Main synthesis refinement (post-review): Pure discriminated data shape... (no named "Rule" types in v1 data model to avoid ceremony/YAGNI)... completion: { mode: 'physical' | 'answer', acceptable?: string[], allow_note?: bool } + supporting... This captures V3 benefits... while staying leaner". Report's "rich content as differentiator" (its §6/9) is *insufficiently grounded* given explicit "No raw step data" limitation it states in §1 and "without counts of real Page_type usage from the 556, it's hard to justify" (its own words in V2/V3 critiques). "Taxonomy risks returning" — yes, named rules *are* a mini-taxonomy in data (ConfirmationRule etc. as first-class cases), risking the dispatch sprawl the report attacks in old (per-type slides) and in V2. "Improves on pure current lean" claim is unproven (report's self-crit: "maintainability... must be validated in code"; "if 80%+... the rule object is mild ceremony").

The report's rec second-guesses the locked "two primary modes" + "no difference" + "supporting as flags" language (08_ + 03_ + 04_ pre/post) by reifying rules as data objects. "Content first" is good (and kept in synthesis), but the wrapper is not.

---

## 3. Rebuild: Refinements / 5th Variant Improving on Report's Rec (Strictly Locked-Compliant)

Report's own rebuild sketches and migration notes are good in principle (map questionnoanswer → physical/confirm, question* → answer + Answers list, gift/lead/congrats → supporting + rule or null; Answers list inside; Gift_Coins → supporting.gift; Next_page → linear position). But its hybrid adds named types.

**Proposed refinement (5th / improved variant, directly from main-thread synthesis cross-review + propagated to 01/04/blueprint):** Pure discriminated completion *data shape* (not named Rule types) + rich content primary + composable supporting object. 

```ts
// Conceptual (v1 data model + bundle + snapshot; no "Rule" named types, no wrapper)
type GameStep = {
  id: string; position: number;
  // rich content (primary differentiator; RU v1; custom per-step for atmosphere)
  title: string; main_text: string; place_text?: string; button_text?: string; /* ... media, geo display-only, hint_text etc. */
  // completion semantics (small, version-frozen, explicit per snapshot)
  completion: {
    mode: 'physical' | 'answer';  // exactly one primary (01_ invariant)
    acceptable?: string[];        // ONLY for 'answer'; from multiline constructor (08_); client membership match
    allow_note?: boolean;         // for physical (optional short player note)
  };
  // supporting (additive, authoring-validated; attach to any; snapshot-frozen amounts)
  supporting?: {
    gift?: { coins: number; narrative_text: string };  // award on this step's StepCompletion
    hint?: { cost_coins: number; reveal_text?: string; reveal_geo?: boolean };
    video?: { ref: MediaRef };
    terminal?: { show_review_prompt: boolean };
    narrative_advance?: boolean;  // pure continue; no completion action
    is_start?: boolean;
    /* ... */
  };
  // author-only
  internal_notes?: string;
};
type StepCompletion = {
  step_id: string; attempt_id: string; version: string;
  player_confirmed?: boolean;  // physical
  submitted_answer?: string;   // answer
  is_correct: boolean;         // local client truth vs snapshot's completion data
  coins_spent: number;
  player_note?: string;
  completed_at: Date;
};
```

**How this improves on report's rec while *strictly* compliant:**
- Respects *every* locked (08_): physical = uniform confirm mechanism ("no difference" = no subtypes/UI variants in model; note optional; trust; geo display only; no answers list); answer = list strings (multiline → acceptable[]); no branching; client full local val (match against snapshot.completion.acceptable or always "correct" on confirm); snapshot freeze (the completion object + supporting.gift.coins are the frozen contract); coins via gifts on steps + completions.
- Retains report's "content carries atmosphere" benefit (rich main_text/place/button_text/images per physical step make "I felt the cold metal" different from "stand and observe view" without model subtypes; "no difference" applies only to the confirmation *mechanism*).
- Avoids the named taxonomy/indirection the report itself exposed as YAGNI risk and synthesis rejected ("pure discriminated data... achieves 95% of the benefit with less ceremony"; "data shapes, not heavy objects").
- Extensibility without bloat: future numeric range/partial/photo = add fields to the completion object (or new supporting key) + handler; old snapshots unaffected (no new union cases to migrate); "adding a field to ConfirmationRule" benefit kept without the type name.
- Smaller/simpler: no wrapper object, no "rule type" strings in every step JSON, answers list present only for mode=answer (natural sparsity), supporting object or absent. Constructor: mode picker (physical/answer) + conditional fields (multiline for acceptable) + supporting toggles/fields. Validation: "if mode=physical then !acceptable else acceptable present".
- Vs report's V3 rebuild: same "content first; semantics explicit/versionable per step" but as flat data (self-documenting in JSON: `completion: {mode: 'physical', allow_note: true}`) not `completion_rule: {type: 'confirmation' ...}`. No "rule on narrative" decision surface.
- Migration notes from report adapt cleanly (Page_type presence of Answers + Gift_Coins → completion.mode + acceptable? + supporting.gift; no rule wrapper indirection in target shape).
- Player/offline: identical dispatch (if completion.mode==='physical' → uniform confirm + note; else input + list match). Bundle serializes the shape directly.

This is the "5th variant" that improves the hybrid by stripping the premature naming while preserving its intent. It matches exactly what 01_ (GameStep attrs), 04_ (minimal data + constructor), and blueprint chose post-synthesis.

**Updated edge handling (additions to report's matrix):**
- Bundle size / parse: lean data wins (flat < wrapped rules for 556 steps).
- Constructor invalid states: mode + supporting fields (with publish-time guards for "physical has acceptable?") simpler than "rule picker + combos".
- Gift timing: supporting.gift on step; emit on StepCompletion (snapshot value); no rule mediation.
- Future rule evolution: add to completion object (e.g. `numeric_tolerance?` under answer mode) or new top-level; no new named type in data.
- "Rich content sufficient?": still unproven without export (report's gap remains); but model no longer assumes rules will carry semantics that content cannot.
- Client match bug: still permanent per snapshot (locked); the completion.acceptable[] is the exact frozen list.
- Linear + multiple paths: unchanged (dupe content or "any in list" as before).
- Physical "feels same": content + per-step button_text/place/media is the only lever (per locked "no difference" in mechanism); if real data shows this insufficient, *then* revisit (report's own "when to revisit" + 07_/04_ calls for walking real quests).

---

## 4. Cross-Slice Impacts (Constructor, Coins, Offline, Versioning, Migration)

- **Constructor data entry (04_ + 06_ + SYNTHESIS + blueprint):** Report's hybrid implies "rule picker" UI + "attach rule" flow (more decisions, "does this need a rule?"). Refined leaner shape: direct "completion mode" (physical vs answer-required per 06_ language) + if-answer multiline (one per line → acceptable[] at publish) + orthogonal supporting fields/toggles (gift coins+text [frozen], hint cost, video, terminal, narrative). Matches updated 04_ ("completion picker (physical confirm vs answer list with multiline...) + supporting toggles/fields"; "Validation prevents invalid combos"). Strengthened gates (list preview pane, publish warnings for physical+acceptable present, 0 answers on answer step) apply equally or better (no rule layer to validate). "Save + test player" preview still acceptable (locked); authors verify atmosphere via real play (rich content + custom buttons). Velocity: less indirection. Old Edit_Page (55 WFs) god-reusable avoided either way; new code must stay small (no god form).
- **Coins gift timing/award (08_ + 03_ + COINS rec + SYNTHESIS):** Unchanged. Gift is supporting on GameStep (coins amount snapshot-frozen at publish); award emitted on authoritative StepCompletion record for that step (using *its* snapshot's supporting.gift). Per-attempt spends on StepCompletion; master = projection of immutable facts. Report's "rule on gift step or award on rule complete" ambiguity avoided. Aligns with old extraction (Gift_Coins per page_constructor → supporting; scattered "steps_for_accruing_coins_" centralized). No impact on first-only de-dup or import (idempotent facts).
- **Offline bundle size + validation (03_ + 08_ + OFFLINE + blueprint):** Leaner shape = smaller serialized JSON per step (no rule wrapper/type + nested for 556 steps + media + ~5MB target). Snapshot carries exactly the completion data + supporting amounts + rich content + acceptable list (only for answer steps). Client validates purely locally: physical → confirm records player_confirmed (always "correct"); answer → submitted vs snapshot.completion.acceptable (membership). Sync records facts + local outcome; no re-val. Rule objects would have added (minor) bloat + extra parse/validation surface for "which rule type". Version freeze benefit identical (the completion object is the contract).
- **Versioning/publishing/snapshots (02_ + 04_ + blueprint):** Publish snapshots the *exact* data shape (completion + supporting with frozen values). Old attempts bound to their version's completion data. New downloads get current. Report's "rules serialize cleanly" benefit kept, but simpler (plain object, no union cases). Historical snapshots retained for in-progress attempts (per locked needs).
- **Sync/progress/attempts (03_ + progress variants + 01_):** StepCompletion shape unchanged (player_confirmed or submitted_answer + is_correct from local vs snapshot.completion). No rule.type to persist. Multi-device: facts union on (attempt,step,version). Reset clears completions for replay against same snapshot rules.
- **Migration/import (09_ + report's own §11):** Simpler target: Page_type (questionnoanswer → mode:'physical'; question/question0 → 'answer' + take Answers list; gift/lead/congrats/video/etc. → supporting + appropriate mode or narrative_advance) + Gift_Coins → supporting.gift; answer_card → StepCompletion per version. No rule wrapper to map into. Historical facts for coins (idempotent). Report's mapping adapts directly; less transformation.
- **Analytics/maintainability:** Per-version rule/mode usage still queryable (completion.mode in snapshot). Handlers centralized in player/constructor (small switch on mode, not on named rule type). One GameStep shape (01_ invariant). Vs old: still massive win (no 14 Slide_* + 21 WFs on error + scattered mutations).
- **Risks amplified by report's hybrid:** Slightly larger bundles, more constructor surface for invalid "rule combos", migration code carries rule wrappers unnecessarily, authors learn "rule" concept vs direct "physical or answer + gift?". All avoided in lean data.

---

## 5. Recommendation: Confirm/Adjust Main-Thread Synthesis Version

**Confirm the main-thread synthesis version (pure discriminated completion data + supporting object, no named Rule types in v1).** 

The report's hybrid V3+light V4 rec, while well-cycled and respectful of locked constraints in intent, over-weighted extensibility/atmosphere/future-proofing (its own self-critique §10 admits this) and introduced named discriminated objects (`ConfirmationRule` etc.) into the *data model* that synthesis correctly stripped for KISS/YAGNI. The pure data shape (`completion: {mode, acceptable?, allow_note?}` + supporting) + rich content + small code handlers delivers the report's stated benefits (explicit per-step/version semantics, content as differentiator for "no difference" physicals, prepare for numeric/photo without mutating core, better than pure V1 flags or V2 taxonomy, migration-friendly, offline-clean) with *less* ceremony, smaller surface, and stricter fidelity to 08_ "we do not need subtypes", 03_/04_ "two primary... supporting as...", and "exactly one primary" invariant. "Rich content" risk remains (unvalidated without real 556-row export), but the model does not exacerbate it with extra abstractions.

Do not re-introduce named rules in data for v1. Revisit only after real quest data walk (as report + 07_/04_/09_ demand) + if >~20% steps show patterns the flat shape + content cannot express. Update any lingering references in analysis/ to the refined shape (01/04/blueprint already reflect it).

This review is the additional adversarial pass on the report as requested in SYNTHESIS-NOTE §4 / analysis/README (reviewers on merged artifacts until "survives scrutiny").

---

## Self-Critique of This Review

- **I may have been too harsh on the report's "rich content" reliance:** Sources (including report) all note the data gap; attacking it is correct per "extreme skepticism" mandate, but the report did flag it as limitation and "when to revisit". The synthesis adjustment was the right response.
- **Under-attacked constructor preview tension:** Report + 04_ + 07_ + 08_ lock "save+test acceptable"; weak preview makes "content differentiates physicals" harder for authors to verify in practice (synthesis calls this out). I noted cross-slice but did not expand into a full new edge.
- **No new data:** I did not export raw steps (impossible from parsed artifacts; probe_results had 404s per report). All claims traceable to cited files + greps/reads. If real data existed here, this review would be stronger/weaker accordingly.
- **Process fidelity:** Applied the cycle to the *report* (deconstruct its deconstruct/matrix/weighting; expose flaws in *its* variants/rec; rebuild 5th/refined strictly locked; updated edges; cross-slices; rec on synthesis version; self-crit). Short/ruthless as mandated. Did not broaden to full re-analysis or other slices beyond cross impacts requested.
- **Strength:** Grounding is absolute (every claim paths to 08_ locked text, discovery counts/WF numbers, 01_/03_/04_ exact shapes, synthesis explicit "no named Rule types" rationale). Calls out where report was self-aware vs where it still pushed the heavier option.
- **Weakness:** As a single-pass review, may miss nuances only visible in code (e.g., actual TS serialization size delta of {mode:...} vs {completion_rule: {type:...}}). "Maintainability" for either shape remains to be proven in impl (report's point, accepted).

---

**Status:** COMPLETE. (Tool-assisted: list_dir, multiple read_file on report + 01/03/04/06/07/08 + discovery/parsed/* (option_sets full page_type, data_types page/page_constructor fields, element_definitions full Slide_* + WF counts), grep across business/ for GameStep/physical/completion_rule/etc. patterns + synthesis/blueprint cross-refs. No files created beyond the required review output. Extreme skepticism applied; every point sourced.)

**Output path:** `business/analysis/review-gamestep.md` (this file; new per explicit task).  
**Feeds:** SYNTH-001 / FINAL-BEST-PRACTICE-BLUEPRINT (already aligned) + any further reviewer passes. Next: real page_constructor export + walk of 2-3 quests (repeated rec from report + sources).

All claims directly traceable to workspace sources. No external assumptions. The report's work was solid adversarial output; this review tightens the final data shape decision without invalidating its edge coverage or cycle.