# PLAN

> Implementation handoff plan. The design project (HTML canvases + `player/`, `commerce/`,
> `myquests/`, `ctor/`, `pwa/` source) is the primary UX/UI source of truth.
> Precedence: design files > SPEC > CONCEPT for UI; SPEC > design for data/invariants.
> Stack context: `platform/` monorepo (Rust Axum backend + Next.js/React RSC frontend),
> OpenSpec change tracking, agent quality gates (fmt/clippy -D/tests; frontend build).

## Phase 0 — Ingest the Design (before any feature code)
- Fetch the design project files. Read in order: CONCEPT.md → SPEC.md → `Квест-флоу.html`
  (+ `player/theme.css`, `player/components.jsx`, `player/quest-data.js`, `player/matcher.js`,
  `player/prototype.jsx`) → `Коммерция.html` → `Мои квесты.html` → `Конструктор.html` →
  `PWA-синк.html` → `review/Визуальный контроль.html`.
- Port design tokens into the frontend design system as two scoped token sets:
  `site` (blue/Inter+Jost/pill, from `commerce/site-theme.css`) and
  `player` («Бумага», from `player/theme.css`). Do NOT merge them — they are intentionally
  distinct systems.
- Port the SVG asset set from `assets/icons/` AS-IS (viewBoxes already fixed). Adopt the SVG
  audit rule from SPEC «Asset Hygiene» as a CI check for any newly imported asset.
- Recreate the visual fixture (`review/Визуальный контроль.html`) as a frontend story/test page;
  it is the visual regression baseline for iconography and headers.
- Treat the prototype JSX as reference implementation, not production code: lift structure,
  class contracts, and copy; rewrite as typed React components with tests.

## Phase 1 — Shared Types & Pure Functions (technology-agnostic first)
- Types: GameStep (7-template discriminator, 2 completion modes — SPEC shape verbatim),
  QuestDraft, QuestVersionSnapshot, AccessGrant, AttemptFact, CoinFact, FeedbackReport.
- Pure functions (one implementation, used by ctor + player + bundler + tests):
  - `isAnswerCorrect(submitted, acceptable)` — contract fixed in SPEC; reference
    `player/matcher.js`. TDD: port its semantics first, goldens before code.
  - `validateForPublish(draft) → {errors, warnings, estBundleMB}` — gate list verbatim from
    SPEC «Publish gates» / `Конструктор.html` checklist screen.
  - `serializeToSnapshot(draft)` — bundle shape from SPEC «Bundle Contents».
  - `projectState(facts)` / `projectBalance(facts)` — deterministic folds; **balance may be
    negative**; client and server folds must be identical (parity golden).
- UI copy: lift RU strings from `player/quest-data.js` (UI_COPY.classic is the shipped tone;
  keep the structure so tone variants remain cheap).

## Phase 2 — Goldens & Adversarial Tests (before slices)
- Export 2–3 real quests from the legacy Bubble system (archived discovery/ scripts + Data API)
  into JSON fixtures; map legacy page types onto the 7 templates.
- Goldens per SPEC «Conceptual Tests»: full playthroughs (all 7 templates), hint flow timing
  (popup strictly from 2nd wrong), negative-balance scenario, completion-bonus idempotency,
  reset-keeps-coins, multi-device union + advance-offer, version freeze, matcher parity,
  gate rejections.
- Property/adversarial: duplicate fact uploads, publish during active attempt, long offline
  queue replay, concurrent reset+play.

## Phase 3 — Implementation Slices (priority order)
1. **Constructor** (protects the frozen-snapshot model; bad content lives forever):
   - Pages screen with sortable list + per-page gates + versions panel (no status select).
   - Template picker: grid with live mini-previews using the real player components
     (design: `Конструктор.html` picker A; list variant B is the documented alternative).
   - Per-step editor exactly as designed: content, 4 comic zones, AnswerListEditor
     (+ paste-lines + live test via shared matcher), gift + freeze note, hint, navigator toggle,
     live phone preview (+ revealed-hint toggle).
   - Publish: checklist screen (errors block), dry-run serialize, publish modal, immutable
     version creation + bundle build.
   - «Открыть как тест-игрок»: persist draft, temp grant, open the real player flow.
2. **Player PWA** (design: `Квест-флоу.html`):
   - 7 template renderers on one GameStep view; paper tokens; image-first layout; 360-wide
     responsive frame; entrance animations gated (end-state base, reduced-motion respected).
   - Local validation (shared matcher); wrong-flow; persistent hint reveal; coin toasts + chime;
     completion bonus; menu; FeedbackReport sheet; pause/reset (coins survive); final variant B.
   - Local fact log + projection; position persisted; navigator → system maps URL.
3. **Sync backend**:
   - Append-only fact log; idempotent append (fact_id + natural keys); projectors for attempt
     state, balance (negative-capable), per-version analytics.
   - Corrections limited to: balance re-projection notice + attempt-advance offer (multi-device
     union). No compensation flows for overdraft (legal state), none for hints.
   - Snapshot retention + bundle manifest; bundle download endpoint gated by grant.
4. **Commerce / Marketplace** (design: `Коммерция.html`):
   - Lifetime grants (idempotent, source audit). Telegram-auth gate before checkout.
   - Checkout page (provider redirect; no card fields), coupon % incl. 100% → 0 ₽ path without
     provider, success/failure pages, entry states (paid/free/owned), mobile checkout.
5. **My Quests + Profile** (design: `Мои квесты.html`):
   - Collection rows with attempt + download states and version banner; empty state;
     start gate; bundle download UX (3 states); profile tiles (balance, rating, completed).
6. **Admin visibility**: per-version stats (attempts, completions, wrong answers, hints bought,
   navigator clicks, FeedbackReports per step); read-only report lists.

## Phase 4 — Polish, Migration, Measurement
- YAML import/export in constructor (power path; design has the tab placeholder).
- One-time idempotent legacy migration: grants + answer_card history → synthetic legacy
  snapshots + facts; reconcile old scalar balances by diff report (no auto-adjust).
- Measure: real bundle sizes vs 5 MB; constructor velocity with gates; sync correction rate;
  player feedback on hint popup timing and navigator handoff; depth/frequency of negative
  balances (abuse signal).
- Secondary design gaps to close when prioritized: «Все фото» gallery, policy/terms pages,
  desktop contacts section.

## Explicit Cuts (v1) — delta to previous plan
Previous cuts stand (no cart, no external authors, no branching, no real-money coins, no manual
balance adjustments, no magic links, no GDPR flows). Newly decided:
- No RATING_SPEND / review boost.
- No hint revocation, no overdraft compensation, no insufficient-funds UI (negative balance OK).
- No in-app map or bundled routing (system maps handoff).
- No fullscreen video pages (inline block only).
- 4-template model abandoned: ship the 7 templates over one GameStep.

## Risks & Mitigations (updated)
- **Negative-balance farming** (buy hints freely, ignore debt): rating floors at 0; hints are
  the only sink; monitor depth/frequency per player; cap later if abused (YAGNI now).
- **Bundle size** (4 comic roles + video + audio): ctor size-estimate warning gate; compression;
  measure with real assets early.
- **Frozen bad content**: strengthened gates + live preview + test-player path + per-step
  analytics + FeedbackReports per version.
- **Doc/design drift**: precedence rule in CONCEPT; any conflict resolved by editing the losing
  artifact in the same change.
- **Prototype-code seduction**: design JSX is untyped, un-tested reference; port semantics, not
  files. The matcher contract is the only verbatim-port module.

## Immediate Next Actions (for Claude Code, in order)
1. OpenSpec change «design-ingest-and-shared-core»: Phase 0 + Phase 1 types/functions + matcher
   parity golden. Quality gates green.
2. OpenSpec change «real-quest-export-goldens»: legacy export, fixtures, Phase 2 suites.
3. OpenSpec change «constructor-slice»: Phase 3.1 against designed screens.
4. Then player, sync, commerce, my-quests, admin visibility — one OpenSpec change each,
   referencing the corresponding design file as acceptance baseline.
