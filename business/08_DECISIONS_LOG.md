# Decision Log (v0.2 — Key Locked Choices)

This file records high-impact decisions made during the business/conceptual phase so future readers (and implementers) understand the "why" and the trade-offs accepted.

## 2026-06 — Offline Validation & Versioning

**Decision:** Client fully validates answer correctness against the quest snapshot/version it downloaded. Server records submissions and the local validation outcome but performs **no re-validation** of correctness on sync. New attempts and new downloads use the latest published quest version; old attempts are bound to the version they started with.

**Rationale / Input:** Explicit stakeholder direction to enable full offline validation by the client. "No revalidation on-sync. Next quest will be started with synced new version."

**Trade-offs accepted:**
- Buggy or suboptimal answers in a published version are frozen for anyone who started an attempt on that snapshot.
- The client implementation of matching becomes the source of truth for recorded outcomes on that version.
- Requires a quest publishing/versioning mechanism and (ideally) retention of historical snapshots if we want players to be able to re-download exact old versions for in-progress attempts.
- Analytics on submitted answers per version becomes important for authors to improve future content.

**Rejected alternatives (for v1):** Two-phase (client local + server authoritative re-check), provisional submissions ("will verify later").

## 2026-06 — Physical Steps

**Model:** Physical / "no answer required" steps have no acceptable-answer list. Completion is the player's explicit confirmation action in the app after they have performed the real-world task. "No difference" between different physical steps — all use the same simple confirmation mechanism. Optional short note supported. Geo display + hint-coin reveal only.

**Status:** Locked. "No difference" means we do not need subtypes or different completion UIs for v1 physical tasks.

## 2026-06 — Auth for MVP

**Decision:** Email + password only for both players and administrators in the initial release. Other providers (Telegram, OAuth, passwordless, etc.) are explicitly post-MVP.

**Rationale:** Simplest clean surface for the rebuild. Avoids carrying forward legacy auth complexity.

## 2026-06 — Answer Representation (v1)

**Decision:** For answer-required steps, authors provide a list of acceptable strings (synonyms, numbers, phrases) via a **simple multiline input** in the constructor (one value per line). Client does basic membership / matching against the list from the local snapshot. Advanced normalization is deferred.

**Rationale:** Direct input. Enables offline client validation.

## 2026-06 — Constructor Preview

**Decision:** "Save the quest, then switch to the real player logged in as a test user" is acceptable for MVP. No requirement for high-fidelity live preview embedded inside the constructor at launch.

## 2026-06 — Coins Economy (v1)

**Decision:** Coins are earned exclusively via quest completions and gifts/rewards defined inside quest steps (exact triggers and amounts to be taken from current project behavior). Administrators cannot manually adjust player coin balances. No real-money purchase flow for coins in v1.

**Mechanics extraction:** See investigation in business/ docs and discovery data (Gift_Coins per page_constructor step, 5-coin awards on certain quest completions tracked via Getting_5_coins_for_completing list on user, Balance_coin on user, Buy_hint spend on answer_card, countCoinMadeIt on quest, You_made_it / Complited flags). Full timing lives in the old quest page workflows and reusable "steps_for_accruing_coins_" elements.

## 2026-06 — Purchase Flow

**Decision:** Single quest purchase only for v1 (no shopping cart / multi-quest checkout).

## 2026-06 — Data Import

**Decision:** Importing historical AccessGrants (bought + free quests) + attempt history is desired ("yes"). Full per-step history from old answer_cards is included in scope where feasible.

## 2026-06 — Quest Size

**Decision / Fact:** Expected total downloadable size per quest ≈ 5 MB (images + occasional 10-30s videos + structured content). This is considered manageable for PWA offline caching.

## 2026-06 — Branching

**Decision:** No branching in v1 quests. Linear sequence only. Branching noted as a valuable future feature.

## 2026-06 — Scope

- Events / calendar domain: dead, fully excluded.
- Roles: only Administrator (internal team) + Player.
- Language: Russian only for v1.
- Legacy auth (magic links, password reset for existing users): not supported in the new system.

---

**Process note:** These decisions were reached through the adversarial interview cycle. They should be revisited only with new evidence or changed business priorities. Any implementation that contradicts this log without an updated decision entry is out of sync with the conceptual foundation.

## 2026-06 — Event-sourced Progress, Sync, Attempts, Coins & Facts (from ANALYZE-05 + reviewer + cross slices)
**Decision:** All play progress, completions, coin earns/spends, resets, navigator uses, hint purchases, and related actions are **immutable append-only facts/events** (AttemptFact / StepCompletionFact + narrow CoinFact ledger). QuestAttempt current state and Player master coin balance are **deterministic projections** (fold) of the fact log, not mutable source of truth. Client maintains local event log + identical projection for full offline play. Sync = idempotent append of pending facts (keyed by fact_id + attempt + snapshot + step + kind + device+local_seq) + pull + re-project + explicit corrections. Server is durable append point + projector. No direct mutation of attempt aggregates or scalar balances for progress/coins.

**Key schema elements (locked direction):**
- AttemptFact: fact_id, quest_attempt_id, snapshot_id, step_position, fact_type ('physical_confirmed' | 'answer_submitted' | 'hint_purchased' | 'gift_claimed' | 'attempt_completed' | 'reset_requested' | ...), payload {submitted_value?, local_is_correct (client claim, never server-overridden for outcome), coins_delta?, note?, device_id, local_seq, client_ts}, server_received_at.
- CoinFact (unified or linked): fact_id, player_id, attempt_id?, quest_id, snapshot_id, step_position?, fact_kind ('GIFT' | 'COMPLETION_BONUS' | 'HINT_SPEND' | 'RATING_SPEND' | 'LEGACY_CREDIT' | 'CORRECTION'), amount (signed), frozen_amount_source (from bound snapshot), idempotency_key (attempt+step+kind+snapshot), created_at.
- Projection policies: per-(attempt,step,snapshot) LWW by (client_ts + device + local_seq) for current view; full log retained for audit/replay/analytics; additive for coins with dedup keys; reset: prefer "new independent attempt id" (history preserved on old; banked rewards survive); epoch alternative documented if needed.
- Multi-device: canonical attempt_id on first fact; facts union by key; devices adopt via "my attempts" list.
- Version: every fact carries snapshot_id; projections filter to attempt's pinned snapshot. Historical snapshots retained for re-dl of in-progress/cleared old attempts (cross 02/01).

**Reset policy:** Default = new QuestAttempt id (independent per 01/03 locked); old attempt facts frozen for replay/audit. Banked global rewards + grant survive. "Reset only selected" honored cleanly.

**Why (robustness first):** Survives every deconstructed race (dual-device advance+spend, reset concurrent, version drift + re-dl, coin earn/spend interleaving, overdraft, clock skew, partial sync) without lost/double or heroic merges. Unifies coins (AN04) + progress + GameStep kinds (physical_confirmed vs answer_submitted carrying submitted + local_is_correct). Client local truth (no re-val) respected: local_is_correct carried as claim. Deterministic client/server fold (golden tests). Audit/replay/"what was balance at D?"/import first-class. Directly mitigates business/06 "sync logic has races → lost progress or coin overspend".

**Trade-offs accepted:** More concepts/machinery than "just upload current completions + last-write or union" (but that collides with documented risks and recreates Bubble scattered mutations). Temporary device inconsistency until sync (inevitable in offline). Storage for facts (negligible for linear quests; prune after projection snapshots if replay not needed; retain audit). Projection lag/corrections UX.

**Rejected:** V1 mutable + union (fatal per 06/AN05 deconstruct); pure CRDT (overkill/YAGNI for linear human-paced + still needs log); strict server (fights full offline + client local val).

**Cross impacts & required updates:** See blueprint §6 + review-progress-sync.md. Update 01 (add facts aggregates + "QuestAttempt/player balance = deterministic projections of immutable facts; no direct mutation for progress/coins"), 03 (rewrite sync to "append pending facts + re-project + corrections"; retention + local log contract + device+seq), 04 (unify CoinFact), 08 (this entry), constructor (must emit supporting.gift/hint that generate facts; templates map to event types). Client reqs: support 4 templates (events per kind), navigator (supporting + optional event), wrong-popup hint trigger, any-page FeedbackReport facts, coins for rating (projection or RATING_SPEND fact).

**Documentation:** business/analysis/progress-attempt-sync-variants.md + review-progress-sync.md; FINAL-BEST-PRACTICE-BLUEPRINT.md §6; 01/03/04 updates.

## 2026-06 — Client Requirements Incorporation ("Описание сайта" alignment + resolutions)
**Decision:** The explicit client description ("Сайт состоит из трех компонентов: маркетплейс квестов, квест, конструктор квестов"; smartphone sequence of web pages; 2 task types with "move + optional action" statue example + "enter correct"; **4 templates** as primary (Первый экран, Задание без ответа, Задание с ответом, Продолжить); comic-like image **per page** for task/character/hint/atmosphere; **navigator button** for location tasks as optional hint; bonuses animated/voiced for tasks + spend on hints **or for rating**; hints via **wrong answer popup** exchange; feedback "Оставить отзыв" from **menu any page** for errors + separate rate/comment after) is authoritative for UX/gameplay/product details and must be incorporated (or violations explicitly called). Resolutions prioritize client fidelity while preserving core robustness strengths (one GameStep shape, snapshot freeze, facts for progress/coins, rich content primary, client local val, linear, internal-only, lifetime grants).

**Resolutions locked (from mismatch analysis + mini-cycles):**
- Structure: Elevate **Marketplace** as peer top-level component (catalog + grants discovery surface listing constructor-published quests with comic primary + previews). Publish flow surfaces to marketplace.
- 4 templates: Map as **primary UI** for player render (First = is_start/narrative; Task no answer = physical; Task with answer = answer; Continue = narrative_advance). Constructor: template picker (prefills mode + supporting). Richer supporting (gift/nav/hint) allowed **on** the 4.
- Physical (no-answer): Keep uniform explicit confirm mechanism (locked "no difference"/honesty, no subtypes). Add optional action metadata + rich per-step content/copy (statue hands example already shared); optional navigator. "Move + sometimes perform action" captured via content + optional `supporting.physical_action?` or button_text.
- Navigator: Optional supporting data on physical/location steps: `navigator?: {lat, lng, label?, hint_only?}`. Constructor geo picker + "enable navigator button" toggle. Player: button on Task-no (device maps or in-app). Hint can gate reveal.
- Comics/graphic per page: Role-based in GameStep media: `{primary/task, character, hint, atmosphere}` (comic style author-driven or flag). Per-step assignment in ctor (zones + thumbs). Bundle includes all. Hint role = the coin-gated one. Player renders per template/role.
- Coins/bonuses: Earn on tasks (gifts + completion bonuses, snapshot-frozen). Add supporting for `bonus_animation?: {asset_ref, voice_ref?}` (client plays on award). Extend CoinFact kinds for 'TASK_BONUS', 'RATING_SPEND' (or boost). Spend "or for rating": optional post-quest flow (spend to enable/higher-grade Review or derive player rating stat from net coins earned + reviews). Keep hints primary.
- Hints: Primary trigger = **wrong answer popup** on Task-with (after fail: "Spend X to exchange?"). Uses per-step supporting.hint.cost. Still allow proactive per-step affordance if UX demands. Log in completion.
- Feedback: New thin **FeedbackReport** (any-page global menu "Оставить отзыв", error/bug-focused, auto-attaches current step/quest/attempt context, synced like completions). Keep/enhance **Review** (post-completion rate + comment). Global menu in all 4 templates. Constructor/quest stats: read-only list of reports per version.
- Cross (hardened by client flows): **Event-sourced facts mandatory** for all (template advances, navigator uses, popup exchanges, mid FeedbackReports, anim triggers, rating spends) — resolves AN05 races exacerbated by new mid-quest state. Offline bundle **must** pack comics (roles), navigator data, animation/voice refs (beyond prior geo/hint). Constructor gates + minis now include "every Task template has primary comic?", navigator valid, etc. "Hard to publish bad" amplified for visuals.
- Marketplace integration: Constructor publish → "list in marketplace" (with comic primary + template summary). Grants/purchase flow through marketplace surface.

**Why chosen (skeptical):** Client "Описание сайта" is product/UX mandate (explicit structure, 4 templates, comics per page/roles, navigator button, popup hints, any-page feedback, animated/voiced + rating spend, statue action example). Ignoring = blueprint invalid. Resolutions preserve KISS (one GameStep + small supporting; facts for robustness; snapshot freeze) while mapping client to data/UI. Mini-cycles per point attacked edges (bundle size, "hard 4" vs richer, rating abuse, popup interruptive, etc.) and chose balanced (UI-primary 4 + richer ok; uniform confirm + content/metadata; optional nav; role images; facts extensible; FeedbackReport + Review split).

**Trade-offs/risks accepted:** Bundle size pressure (~5MB; comics + audio higher — compression, optional roles, measure with real data). Constructor velocity (more per-step fields — mitigate with templates/presets/gates). New sync surfaces (popup/nav/feedback events) → facts non-negotiable. Frozen bad visuals permanent (stronger pre-publish gates + per-version analytics). "Spend for rating" may feel pay-to-win (make optional/derived stat primary).

**Cross impacts:** See client-requirements-mismatch-analysis.md (full table + slice impacts). Update 01 (GameStep media roles + navigator + FeedbackReport + template derivation or field + CoinFact extensions + invariants), 03 (bundle spec for comics/nav/anim/voice + facts in sync + local support for popup/nav), 04 (ctor 4-template picker + per-role comic zones + navigator config + animation flags + popup wiring + strengthened visual gates + "test player" exercises new flows), 06/00/02 (marketplace as peer + 3-component structure), 07 (assumptions on visuals/feedback), 08 (this entry). Progress/Sync (AN05 + review): events for new flows mandatory. Blueprint: new dedicated alignment section + revisions to 1/2/3/4/6.

**Documentation:** business/analysis/client-requirements-mismatch-analysis.md (point-by-point table, mini-cycles, impacts, self-crit); FINAL-BEST-PRACTICE-BLUEPRINT.md (client section + cross); CONCEPTUAL_DESIGN_RU.md (full synthesis incorporating client); updates to 01/03/04/06/00/08.

## 2026-06 — Additional Cross Notes (from parallel reviews + client + remaining slices)
- Commerce (ANALYZE-06): Lifetime AccessGrant (idempotent, source-audited: Payment | CouponRedemption | Free | Admin). Hybrid event-sourced grants core (PaymentConfirmed/CouponRedeemed → GrantIssued projection) + minimal lifetime projection + optional per-dl "download ticket" for stronger offline binding/audit (cross 01/03/02). Single quest v1. Grant required before dl/attempt/earn. Import synthesizes from old buy_a_qest/payment/coupon.
- Versioning (ANALYZE-02): Explicit Publish deliberate. Full immutable snapshot (or manifest + content-addressable) at publish. Indefinite retention for any snapshot with active/recent attempts (min: acceptable lists + positions + gift amounts + comic refs + media for re-dl). Synthetic legacy snapshots at import (v0 from export-time data). Concurrent publish races: atomic or last-wins with warning. What triggers new version: answers changes + structural (reorder/delete) definitely; minor text fixes debatable (prefer explicit). 
- All slices converge on: facts/events for robustness (progress/coins/grants), snapshots for freeze/offline/client authority, one clean GameStep + rich content primary, strengthened ctor gates + structured entry (answers editor + live test + templates + minis), marketplace as peer, client req visuals/flows supported without sacrificing maintainability invariants.

These entries (plus prior) constitute the current locked foundation. All implementation must align or explicitly update this log after adversarial review.
