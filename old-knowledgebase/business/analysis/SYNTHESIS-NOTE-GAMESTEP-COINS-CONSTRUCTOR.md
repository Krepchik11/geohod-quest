# Synthesis Note: Cross-Slice Review of GAMSTEP (ANALYZE-03), COINS (ANALYZE-04), CONSTRUCTOR (ANALYZE-07)

**Date:** 2026-06-09 (post first wave completions)
**Main-thread role:** Chief Staff Engineer + Critical Analyst — review subagent outputs with fresh skepticism, integrate, cross-check for conflicts/trade-offs, refine, feed SYNTH-001.
**Sources reviewed:** The three completed `business/analysis/*-variants.md` + originating business/01/03/04/08 + discovery/parsed (for grounding) + other running task context.

## 1. Summary of Subagent Outputs (High Signal)

**GAMSTEP (GameStep taxonomy + physical/answer + supporting):**
- Deconstructed 15+ edges (lies, undo, atmosphere loss from "no difference", rebus/non-string scaling, numeric tolerance, multiple paths, version freeze of bad rules, client match bugs, old 14 Page_type expressiveness vs maintainability).
- Exposed current lean (primary mode + flags) as compliant but at risk of "trivial confirm" (explicit source self-critique) + flag bloat + loss of per-step differentiation.
- 4 variants cycled fully (lean, richer first-class kinds, content+embedded rules, strategy/composition).
- **Rec:** Hybrid V3 (rich content + small embedded `CompletionRule: ConfirmationRule | AnswerListRule | null`) + light V4 (composable supporting behaviors for gift/hint/etc.). Respects *all* locked (uniform physical confirm + optional note, list strings for answers, client offline match, linear, snapshot freeze, coins via gifts). Improves maintainability vs old 14 types/1163 WFs (one shape + tiny data rules vs per-type slides + scattered mutations). Content carries atmosphere (addresses "reduces the magic"). Migration: old Page_type + Answers presence + Gift_Coins → rule + supporting. Self-critique: may still be over-layer for v1 if 80%+ steps are simple; data limitation (no raw 556 steps) noted; "maintainability" must be validated in code.
- Edge matrix + migration notes excellent.

**COINS (Economy mechanics + races):**
- Exhaustive extraction from discovery (Gift_Coins on page_constructor, Balance_coin + Getting_5... list on user, Buy_hint/You_made_it/Complited on answer_card, countCoinMadeIt on quest, "steps_for_accruing_coins_" on congrats slide, 82 quest WFs + 9 on Slide_Congratulations as scattered mutation sites).
- Old reality: not a model — ad-hoc ChangeThing in UI state machines + scheduled events. No versioning, no clean per-attempt, timing opaque (visit vs terminal? first-only via list hack).
- Locked (global-ish + reconciliation, per-attempt spends tracked in StepCompletion, snapshot-frozen gift amounts, offline local + server reconcile, no admin, earnings only gifts/completions).
- Deconstructed races (multi-device simultaneous spend, reset-after-earn double, versioned gift amount drift, concurrent bonus, import reconciliation of historical Balance vs events, negative/overspend, "per-attempt wallet vs global" ambiguity).
- Variants: 1. Lean global + event log (idempotent append, project balance); 2. Per-attempt wallet (scoped earns/spends, conversion?); 3. Immutable first-class RewardEvents (projected, strong idempotency via keys).
- **Rec lean toward event log (V1 extended)** for audit, idempotency, versioning (embed snapshot gift value), future real-$ , import seeding. Needs explicit keys, tx around check+append, correction events for offline races. Cross-tie to GAMSTEP: gift amounts live in the versioned GameStep snapshot; earnings emitted on authoritative StepCompletion record (using that snapshot's amounts).
- Strong on "sum earnings - spends" as projection, not mutation.

**CONSTRUCTOR (Authoring UX + data entry + publish):**
- Deconstructed lean ("form + ordered list + multiline answers + explicit Publish + save+test-player preview").
- Velocity: medium (preview friction = context switch + full play for tweaks).
- Error-prone hotspots: multiline (blanks/dups/punct frozen forever), raw geo (no map sanity), media (no thumbnails in editor → wrong asset), kind/answers mismatch, no strong pre-publish gates.
- Versioning: clean (edits to "current draft"; Publish snapshots full state + answers list + gift amounts at instant).
- Old mapping: replaces Edit_Page (55 WFs) + Existing_Quest (63) god-reusables + 14 Page_type dispatch + 444 SetCustomState with small typed components (list + per-step form with conditional sections). Maintainability win *if* we avoid god-component in new code.
- Locked preview "acceptable" but fidelity low for the exact risks (media render, answer match, hint+coin, geo+map, linear after reorder, offline simulation).
- **Recs:** Strengthen data entry (list preview pane, map widget, media thumbnails in step cards, publish-time validation + warnings). Keep lean for v1 but plan evolution (Markdown/JSON import for velocity, batch test links). Bundle generation direct from publish state. Constructor code itself must be the poster child for readable/maintainable (small files, typed drafts, no leaked state).
- Cross-tie: multiline answers + gift coins directly feed the GAMSTEP rule/supporting data; publish must emit the exact snapshot shape (including frozen gift amounts for COINS).

## 2. My Skeptical Review + Cross-Checks (Main Thread)

**Strengths across reports:**
- All respected locked constraints (no contradiction of "uniform physical confirm", "list strings", "client offline only", "explicit publish + snapshots", "per-attempt/per-step coins", "linear", "internal only", "save+test preview acceptable").
- Heavy grounding in discovery (old mess as cautionary, not spec) + business self-critiques.
- Edge/race coverage excellent (version freeze, multi-device, import, reset, atmosphere).
- Maintainability focus (vs 1163 WFs / 47 types / dupe constructors / scattered mutations) aligns with role mandate.
- Documentation quality high (matrices, migration mappings, self-critiques).

**Flaws / Attacks (harsh, no softening):**
- **GAMSTEP rec adds a layer ("embedded CompletionRule") that risks mild YAGNI violation for v1.** If (as subagent admits) 80%+ of real steps are simple physical-confirm or answer-list + gift/hint, a pure discriminated data shape on the step (`completion_mode + acceptable? + allow_note? + supporting object`) achieves 95% of the benefit with less ceremony. Named "Rule" types feel like premature classification (old 14 types were accidental; don't recreate taxonomy in data). The hybrid is "least-bad" but the leaner data-only version (still content-first, still extensible by adding fields to the completion object later) better honors KISS/YAGNI while still addressing atmosphere (via rich content + custom buttons) and scaling (add numeric_range field when needed, not a new rule type now).
- **COINS variants correctly identify that "lean global + reconciliation" is underspecified in locked docs.** Event log is the right direction for robustness, but V2 (per-attempt wallet) has real UX downsides for a cross-quest hint economy (unless conversion is automatic). The "per-attempt vs global" ambiguity in locked + "sum earnings - spends" needs an explicit projection rule (earnings global on first-ever per quest; spends always per-attempt record but affect global). Versioning tie-in (gift amounts from attempt's snapshot) is critical and correctly called out.
- **CONSTRUCTOR correctly flags that "save + test player" + raw multiline/geo/media is the highest-error surface.** "Hard to publish bad" is weak; frozen snapshots amplify it. The velocity cost (iteration loop = minutes) is real for an internal team shipping 21+ quests. Recommendation to strengthen gates + plan import alternative is sound. However, the report under-plays that for *small internal team only*, the absolute simplest (even spreadsheet import + visualizer as primary "constructor") might beat a fancy form for KISS and speed — the "web form" assumption may be over-indexing on "we will build a proper CMS" when YAGNI says "make publishing the hard part, authoring the easy data entry part".
- **Cross-slice conflicts/trade-offs:**
  - GAMSTEP hybrid (rules) + COINS event log + CONSTRUCTOR data entry: all point to "publish-time snapshot of the exact data shape (including answers list + gift coins amounts)" as the single source of truth for offline + earnings. Good alignment.
  - But: adding rule objects increases the "exact data shape" that must be serialized cleanly for bundles (CONSTRUCTOR) and used for frozen earnings (COINS). If we over-layer rules now, the bundle/publish code and migration get more complex.
  - Per-attempt spends (COINS) + per-attempt attempts (GAMSTEP/locked) fit naturally, but global earnings reconciliation means the "master balance" is a cross-attempt projection — must be explicit.
  - Constructor "no high-fid preview" + GAMSTEP "rich content is the differentiator": tension. If preview is weak, authors can't easily verify that their rich text + custom buttons actually make physical confirms feel different. Risk of "content is rich on paper but generic in practice".
- **Overall maintainability claims:** Strong in principle (one GameStep shape + small data vs 14 types + 100s WFs), but all reports note "must be validated in actual code". The "constructor code itself readable" is a meta-requirement we must enforce (no god components in the new stack).

**Refined integrated recommendation (main thread synthesis for these slices):**
- **GameStep (refined from GAMSTEP hybrid, leaner for KISS):** Rich content primary. Completion as small data object on the step: `{ mode: 'physical' | 'answer', acceptable?: string[], allow_note?: bool }`. Supporting as validated composable object (gift {coins, text} — amount snapshot-frozen at publish; hint {cost}; etc.). No named "Rule" types in v1 data model (pure discriminated data + one or two small handlers in player/constructor). Extensible later by adding fields to the completion object or new supporting keys. This captures the "content first + pluggable semantics" benefit without the ceremony the subagent flagged as potential over-weight.
- **Coins (from COINS rec):** First-class append-only CoinEvent / RewardEvent log (idempotency keys including attempt+step+kind + quest_version for frozen amounts). Master balance = projection (sum earns - spends). Per-attempt spends recorded on StepCompletion. Earnings emitted server-side on authoritative StepCompletion record (using the *bound snapshot's* gift amounts). "First-only" bonus via existence check or unique (player, quest, 'COMPLETION_BONUS'). Offline: client projects from snapshot + local completions; sync uploads facts, server projects authoritative + corrections. This directly mitigates the races the report deconstructed.
- **Constructor (from its rec + cross):** Keep lean form+list+explicit Publish+save+test as baseline (satisfies locked). But *immediately strengthen*: (a) parsed answers list preview pane in step editor (trim/filter blanks, show count, basic dup warning); (b) geo map mini-preview or city sanity; (c) media thumbnails + status in step cards; (d) publish-time validation + author warnings for mismatches (physical with answers list? 0 answers on answer step?); (e) clear "editing current draft; publish creates immutable snapshot for future players" language. Plan evolution to import (Markdown/JSON steps with validation) or better preview affordances post-MVP for velocity. Bundle/publish path must emit the exact refined GameStep shape (completion data + supporting with frozen amounts) + answers list plainly.
- **Cross invariants (new from synthesis):** 
  - All completion/earnings data (acceptable lists, gift coins amounts, hint costs) is versioned in the quest snapshot at publish.
  - Earnings for an attempt use only the amounts/rules from *its* snapshot.
  - Constructor state → publish → immutable snapshot (with answers split from multiline at publish boundary) → bundle + earnings source of truth.
  - Spends per StepCompletion (per-attempt); earnings global projection with per-quest first-only de-dup.
  - No invalid combos at authoring time.

This is more robust than any single slice's lean while still KISS (data shapes, not heavy objects; event log as the accounting primitive).

## 3. Documentation Updates Performed
- Updated `business/01_DOMAIN_MODEL...` (GameStep attributes + invariants) with the refined lean data shape + supporting.
- Updated `business/04_CONTENT...` (minimal data, constructor capabilities, error/velocity notes, bundle tie-in) with cross-slice refinements and stronger gates.
- This synthesis note created as the merge artifact for these three slices.
- Todos advanced; more slices (offline, versioning, etc.) still running for full SYNTH-001.

## 4. Next (Parallel + Merge)
- Fetch outputs from remaining running subagents (offline, versioning, progress/sync, migration, etc.) as they complete.
- Launch reviewers for these three completed reports (or the integrated synthesis).
- When all ANALYZE-* done: full SYNTH-001 (trade-off matrix across *all*, final blueprint with chosen per-area + overall principles, rejected alternatives with why, how constraints satisfied, max docs).
- Revisit after real step data export (repeated recommendation).

The parallel adversarial process is delivering exactly the "multiple solutions + skepticism + best practice with why" requested. This slice synthesis shows the value: individual deep dives + cross-review produces a tighter, more robust integrated design than any one alone. 

Ready for the next wave of outputs or user attacks on this synthesis.