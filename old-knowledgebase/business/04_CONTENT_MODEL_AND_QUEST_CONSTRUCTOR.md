# Content Model and Quest Constructor (MVP) — Business Concept v0.1

## Philosophy

The quest is a **sequence of game steps**. The constructor's job is to let the internal administrator team build, preview, reorder, and publish these sequences efficiently.

We are not building a general-purpose page builder or rich web app editor. We are building a **quest step sequencer** tailored to the two primary task types + supporting narrative, media, hint, gift, and terminal steps.

## GameStep as the Atomic Unit (Simplified from Old Data)

From clarifications + old artifacts, a step needs to support:

**Primary completion modes (mutually exclusive for a step):**
1. **Physical / No-answer task** — "Go to X, find the object, optionally perform an action (touch the hands of the statue and feel the cold metal)". Player completes by explicit confirmation in the app ("Done", "I found it", "I performed the action"). May have associated geo for display/map.
2. **Answer-required task** — Player must figure out and enter the correct value (text, number, short phrase). Examples: knowledge question, text from memorial plaque, count of windows, solution to rebus/puzzle. Server (and protected bundle) knows the acceptable answer(s).

**Supporting step behaviors (can be combined with above or standalone):**
- Narrative / Story advance (text + "continue").
- Media display (image gallery, video).
- Hint / Reveal (gated by coin spend; reveals geo pin or extra image/text).
- Gift / Reward (narrative prize + possibly coin award to player).
- Start / Greeting.
- End / Congratulations + review prompt.
- Error / Guidance screen (rare).

Old `Page_type` had 14 values (style, hint, lead, gift, error, start, video, question, greetings, question0, namerequest, congratulations, questionnoanswer, screenafterquest). Many of these are presentation variants of the above. The constructor should let admins choose the semantic behavior + rich content, not 14 different "page types".

## Minimal Data a GameStep Needs (Conceptual — Refined via ANALYZE-03 + Coins/Constructor Cross-Check)

- Quest + position (ordering).
- Rich content (primary differentiator for immersion/atmosphere; Russian v1):
  - title/internal, main_text/task desc, place_text, button variants (confirm vs advance), question prompt, durations, gift narrative, hint reveal text.
- Media refs (primary image(s), hint_image, video 10-30s).
- Optional geo (display + map pin only).
- Completion semantics (small, version-frozen data — not 14 Page_types or flag explosion):
  - `completion: { mode: 'physical' | 'answer'; acceptable?: string[]; allow_note?: boolean }`
    - physical: uniform explicit confirmation ("I did it", optional note). No acceptable list. (Locked "no difference"; rich content + custom buttons provide per-step feel.)
    - answer: submit → client matches `acceptable` list (from constructor multiline, one per line).
- Supporting (additive, validated composable; attach to any completion):
  - `gift?: {coins: number; narrative: string}` (award on this step's completion or terminal; snapshot-frozen amount).
  - `hint?: {cost: number; reveal_geo?: bool; reveal_content?: string}` (per-step spend).
  - `video?: MediaRef`, `terminal?: {review_prompt: bool}`, `narrative_advance?: bool`.
- Author notes (constructor only).
- (Snapshot version id baked at publish.)

This structure (from GAMSTEP hybrid rec, refined leaner for KISS): content-first + tiny discriminated completion data + composable supporting. Directly supports offline bundles (serialize the above + answers list plainly), versioning (old attempts use their frozen rules/amounts), and coins (gift amounts per snapshot). Avoids old 36-field multilingual + 14-type + flag-bag mess while respecting all locked decisions (uniform physical confirm, simple list answers, per-attempt/per-step coins, linear, explicit publish for snapshots).

## Quest Constructor MVP Capabilities (What Admins Must Be Able To Do — Updated with Cross-Slice Insights)

1. Create new quest (metadata form).
2. Add/edit steps in ordered list: rich content editors + completion picker (physical confirm vs answer list with multiline "one acceptable per line") + supporting toggles/fields (gift coins+text [snapshot-frozen], hint cost+reveal, video, terminal/review, narrative advance). Validation prevents invalid combos (e.g. physical + answers list).
3. Reorder (drag/pos; affects current draft only; publish snapshots the order).
4. Delete (with note: only future versions; old snapshots/attempts retain historical steps).
5. Explicit **Publish** button: validates, creates new QuestVersion/snapshot (full serializable GameStep data + answers list + gift amounts from this moment), makes downloadable/purchasable in catalog. Old attempts frozen to prior snapshot.
6. Preview: "Save + switch to real player logged in as test user" (locked acceptable MVP; no embedded high-fid live preview required at launch). Note from constructor analysis: iteration friction exists (context switch); plan evolution (e.g. import Markdown/JSON alternative or batch-test links) for velocity. Test full linear flow, coin effects, hint reveals, answer match, geo pins, offline simulation where possible.
7. Basic stats read-only (grants, attempts with version info, reviews, coin totals if relevant).
8. (Implicit) On publish: produce exactly the bundle-serializable shape (content + completion data + supporting + version id + integrity) for offline PWA.

**Error proneness / velocity notes (from constructor slice + GAMSTEP):** Multiline answers and raw geo/media are high-error (dups, blanks, wrong pins, missing assets) — add client-side preview of parsed list + map sanity + media thumbnails in step list. "Hard to publish bad" is weak in pure lean; strengthen with publish-time validation + author warnings ("this physical step has an answers list — did you mean answer mode?"). Old reusables (Edit_Page 55 WFs, Existing_Quest 63) are the cautionary tale — keep constructor code small, typed, focused (no god component).

**Out of MVP (or later):** branching (linear only), full version history/rollback for content, collaborative editing, rich WYSIWYG, external authors, photo proof or advanced rules (future CompletionRule subtypes).

**Out of MVP constructor (or later):**
- Complex branching / conditional steps (the old `Next_page` self-refs suggest some existed; we treat as linear sequence unless proven otherwise).
- Version history / rollback of quest content (log changes, but full time-travel later).
- Collaborative editing (multiple admins at once).
- Rich text beyond what is needed for the step content (no full WYSIWYG unless the content demands it).
- External author workflows.

## Relationship to Offline Bundles

The constructor must produce (or the publishing flow must generate) content that can be fully serialized into the offline bundle, **including the acceptable answers in protected form**.

When an admin changes a published quest:
- Existing downloaded bundles remain valid for the attempts started against them.
- New downloads get the new content version.
- In-progress attempts from old bundles continue to be accepted (server can still validate against the version recorded on the attempt, or against current — decision needed).

## Open Content Questions (High Impact — some resolved)

- How many distinct "kinds" of steps do we actually need in the UI of the constructor, vs. a few core + rich content + flags? (Physical vs Answer-required are the two primary task types; others are supporting: narrative, media/video, gift, hint-gated, terminal.)
- For answer steps (resolved direction): list of acceptable strings (synonyms, numbers, phrases). Simple matching initially. Normalization later.
- Video: sometimes used, typical 10-30 seconds. Must be cacheable in the ~5 MB bundle (or referenced in a way that works offline — embedded or pre-cached).
- Hint model: per-step coin spend reveals the geo object on the map (plus any associated hint content).
- "Namerequest" and similar special flows — still needed in current quests?
- Constructor preview (resolved): "Save + switch to real player logged in as test user" is acceptable for MVP. No high-fidelity in-constructor live preview required at launch.

## Why the Old Workflows Are Not a Good Guide

The old system had 55+ workflows just on "Edit_Page" reusable + 63 on "Existing_Quest". This was the cost of building an in-place editor with Bubble's element + workflow model. We will design a much cleaner constructor (likely form-based + live preview component) because we control the whole stack and are not fighting no-code limitations.

## Self-Critique

- "Sequence" assumption may be too strong. If real quests use significant branching or optional side steps, forcing linear will hurt content quality.
- Live preview in the constructor is easy to say and hard to build well (state management between editor and preview, media uploads, etc.).
- If the team is small and internal, a very simple Markdown + JSON or even a spreadsheet import might be higher leverage than a fancy web constructor for v1. We should question whether "quest constructor" UI needs to be rich immediately.
- We still need to map the concrete examples ("Mystery of the Fortress" statue hands) to exact step fields so the player renders the right prompts and confirmation UI.
