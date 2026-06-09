# PLAN

## Phase 1 — Core Model Lock & Propagation (Immediate)
- Propagate the latest tightened model from this blueprint + 08_DECISIONS_LOG + client alignment into the primary business documents:
  - 01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md (GameStep shape with roles/navigator/physical_action/bonus_animation, FeedbackReport entity, AttemptFact/CoinFact as source of truth, invariants, ER).
  - 03_OFFLINE_PWA_AND_PROGRESS_MODEL.md (rewrite main bundle spec and sync section — not just notes; facts append + re-project; expanded bundle contents including comic roles, navigator data, animation/voice refs; 4-template rendering; popup/nav/menu support; local log contract).
  - 04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md (mandatory 4-template picker with pre-fills, per-role comic zones, navigator config, animation flags, popup wiring, visual pre-publish gates + checklist + size est, structured AnswerListEditor + live exact client match test, gift subform, mini-previews using real player components, "test in real player" exercising full client flows, import tab).
  - 00_PRODUCT_VISION_AND_SCOPE.md, 06_V1_REQUIREMENTS_AND_CUT_LIST.md, 07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md (update must-haves, risks, assumptions, open questions with client specifics: 3 components with Marketplace peer, 4 templates as primary, comic per page + 4 roles, navigator button + shortest route, animated+voiced task bonuses + rating spend or, hints only via wrong popup + no separate button, any-page "Оставить отзыв" for errors + separate post rate/comment, visual/UX gates in ctor).
- Re-estimate realistic bundle size (~5 MB target) using actual comic assets, navigator data, and voiced audio from real quests.
- Export real quest data (page_constructor records for 2-3 full quests + all 556 steps where possible) for goldens, validation of mappings (how often "optional action", typical comic role usage, navigator frequency, wrong-answer counts for popup UX), and migration dry-runs.

## Phase 2 — Shared Types, Pure Functions, Goldens
- Define and implement shared types (technology-agnostic first, then language-specific):
  - Expanded GameStep (completion + supporting with navigator/physical_action/bonus_animation + media roles).
  - AttemptFact / CoinFact / FeedbackReport shapes.
  - QuestDraft, QuestVersionSnapshot, AccessGrant, etc.
- Pure, heavily testable functions (same code used by ctor, player, tests, bundle packer):
  - isAnswerCorrect(submitted, acceptableList) — exact client matching rules.
  - validateForPublish(draft) → {errors, warnings, estBundleMB}.
  - serializeToSnapshot(draft) → exact bundle shape.
  - projectState(facts) / projectBalance(facts) — deterministic fold (client and server must match exactly).
- Golden fixtures from real exported quests:
  - Simulate complete playthroughs exercising 4 templates, navigator button + shortest route, wrong answers → popup hint exchange, animated+voiced bonuses, mid-quest FeedbackReport, reset, multi-device facts, version drift, long offline.
  - Assert: correct projections, no lost/double facts, frozen snapshot amounts used, client match outcome == recorded, replay produces identical history.
- Property-based and adversarial tests for races (concurrent devices, reset during play, overdraft on reconnect, version publish while attempt active).

## Phase 3 — Implementation Slices (in priority order)
- Constructor (admin/quests/constructor):
  - Metadata form + sortable step list.
  - 4-template picker (client names: Первый экран, Задание без ответа, Задание с ответом, Продолжить) that pre-fills mode + supporting + button/confirm copy.
  - Per-step editor with structured AnswerListEditor + "Paste lines" + live "Test match" (exact client fn).
  - Gift subform (narrative + coins + "this freezes in snapshot" note).
  - 4-role comic upload zones (task/character/hint/atmosphere) + thumbnails.
  - Navigator geo picker + "enable navigator button (optional hint / shortest route)" toggle (visible on physical/Task-no).
  - Animation/voice asset assignment for task bonuses.
  - Popup hint wiring (default for answer tasks).
  - Per-step mini-preview (real shared player component against current draft).
  - Pre-publish checklist + gates (primary comic required for Task templates, valid answers count, geo sanity, est size, no terminal warning, etc.) + "dry-run serialize".
  - Explicit Publish (creates immutable snapshot + triggers bundle).
  - "Save + open in real player as test user" (persists draft, creates temp grant, opens real PWA flow exercising full client UX: popup, navigator, anim/voice, any-page "Оставить отзыв", rating spend).
  - Import tab (YAML/JSON paste or file → strict parse/validate → load into list). "Export current as YAML".
  - Small focused components, shared renderers with player, no god objects.
- Player / Quest experience (PWA):
  - Render steps according to the 4 templates.
  - Local validation against embedded acceptable lists.
  - Physical confirm UI (uniform + optional action note + custom button text from content).
  - Answer input + submit → on wrong: immediate popup "Spend X for hint?" (only way to buy hint in v1).
  - Navigator button on Task-no / physical steps (device maps:// or in-app using bundled geo; gated_by_hint option).
  - Animated + voiced bonus awards when gift or terminal reached.
  - Global menu available on every page (including mid-quest) with "Оставить отзыв" (FeedbackReport with step context).
  - Post-completion Review flow (rating + comment, optional coin spend to boost).
  - Local event log + projection while offline.
  - "Offline mode" indicator + pending sync status.
  - On reconnect: upload pending facts, receive authoritative state + corrections (clear banners: "balance corrected", "hint unrevealed").
  - Bundle download, cache, and re-download path for historical snapshots.
- Sync / Progress backend:
  - Append-only fact log (AttemptFact + CoinFact + FeedbackReport facts).
  - Idempotent append endpoint (by fact_id + natural keys).
  - Projectors for current QuestAttempt state, player balance, per-version analytics.
  - Correction protocol (explicit compensation facts for overdraft, duplicate, version mismatch, etc.).
  - Historical snapshot retention + manifest for re-materialization.
  - Multi-device merge by facts (union).
- Commerce / Marketplace:
  - Lifetime AccessGrant (idempotent, source-audited).
  - Single quest checkout + coupon % (including 100%).
  - Free quests (identical mechanics).
  - Marketplace as peer component: lists published quests with primary comic + template summary; publish flow surfaces to it; grants/purchases flow through the surface.
  - Optional per-dl "download ticket" for stronger offline binding/audit (if chosen).
- Admin visibility:
  - Per-version stats (grants, attempts, completion rates, submitted wrong answers, hints used, navigator clicks, FeedbackReports per step).
  - List of FeedbackReports per quest/version (read-only for authors).

## Phase 4 — Polish, Migration, Measurement
- Ctor import/export (YAML preferred) as power path for bulk ops and migration.
- Per-version analytics surfaced in ctor and admin views.
- Migration job (one-time, idempotent): historical grants + answer_card data → synthetic legacy snapshots + facts. Audit diffs vs old scalars. Mark imported items.
- Measure (post-MVP where possible):
  - Real bundle sizes with actual comics + audio + nav data.
  - Constructor velocity and defect rate with new visual/UX fields and gates.
  - Sync correction rate.
  - Player feedback on any-page "Оставить отзыв", navigator button, popup hint UX, animated bonuses.
  - Abuse patterns on rating spend (if enabled).
- Update invariants and 08_DECISIONS_LOG with any new learnings. Re-run adversarial review if client data or real quest exports reveal new edges.

## Explicit Cuts (v1)
- No real-money coin purchases.
- No external authors.
- No magic links / password reset for legacy users.
- No branching in quests.
- No data retention / GDPR deletion flows (none required).
- No multi-quest cart.
- No recurring subscriptions.
- No high-fidelity live embedded preview in ctor at launch (save + real player test is acceptable).
- No advanced answer normalization at launch (basic membership is enough).

## Risks to Address (from all sources)
- Bundle size pressure (comics 4 roles per page + voiced audio + navigator data on top of images/videos). Mitigation: optional roles, compression, size estimation gate in ctor, progressive loading where possible.
- Constructor velocity with added fields (4-role uploads, navigator, animation, popup wiring, visual gates). Mitigation: templates with good defaults, presets, staged rollout of richer features, "test player" for quick validation.
- Frozen bad content (especially visuals and "optional action" copy) lives forever for players who started on that version. Mitigation: strengthened pre-publish gates + checklist + mini-previews + per-version analytics on submitted wrongs / reports per step.
- New mid-quest state (popup spends, navigator button uses, any-page FeedbackReports, animated bonus triggers, rating spends) creates additional sync races. Mitigation: facts mandatory (no mutable attempt state), idempotency keys, explicit corrections, client/server projection contract.
- Rating spend abuse (players farming coins on easy quests to boost ratings on paid ones). Mitigation: optional / off-by-default, derived net-coins + reviews as primary rating signal, per-quest limits if needed.
- "Optional action" in physical steps feeling trivial. Mitigation: rich content + custom button text + comic task image + optional action metadata for copy differentiation; still uniform confirm mechanism.
- Propagation debt (meta files updated but primary 01/03/04/00/06/07 not yet reflecting client alignment and facts model). Mitigation: treat this plan as mandatory before detailed implementation or tech stack decisions.
- Real data validation still missing (repeated gap across all analyses). Mitigation: export real quests as first action in Phase 1.

## Immediate Next Actions (Do These Before Code)
1. Update the primary business documents (01, 03, 04, 00, 06, 07) from this blueprint + latest 08_DECISIONS_LOG + fresh client review.
2. Export real quest data (at least 2-3 full quests + step statistics) for goldens and mapping validation.
3. Re-estimate 5 MB bundle size with actual assets.
4. Define shared types + the pure functions listed in Phase 2.
5. Write the first set of goldens and the client/server projection fidelity test.
6. Start with the constructor slice (4-template picker + structured answers + visual gates) because it directly protects the frozen-snapshot model.

This plan is derived directly from the converged best-practice sections across the FINAL-BEST-PRACTICE-BLUEPRINT, 08_DECISIONS_LOG (including client incorporation), client-requirements-fresh-review-2026.md, 00/01/03/04, and the adversarial analyses. It prioritizes robustness (facts, snapshots, client local authority, gates), maintainability (one clean GameStep, small focused components, shared code), and extreme ease of understanding while satisfying the explicit client "Описание сайта" requirements.