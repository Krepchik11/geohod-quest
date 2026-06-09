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
