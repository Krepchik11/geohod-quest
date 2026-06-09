# Business / Conceptual Documentation (New Foundation)

This directory contains the clean, from-scratch business view, domain model, and requirements for the GeoQuest quest playing + commerce rebuild.

**These documents supersede the old `docs/` (which were reverse-engineered from the Bubble app and contain significant dead weight, duplication, and no-code implementation scars).**

The old `discovery/` and `docs/` folders are now **historical reference only**. They are useful for understanding what existed and for data migration of real quests/purchases, but the conceptual model, scope decisions, and invariants here are authoritative for the new system.

## Documents (read in rough order)

1. `00_PRODUCT_VISION_AND_SCOPE.md` — What we are building and what we explicitly killed.
2. `01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md` — Core aggregates (Quest, GameStep, QuestAttempt, AccessGrant, etc.), relationships, and invariants.
3. `02_COMMERCE_ACCESS_AND_COUPONS.md` — Lifetime grants, one-time purchase, coupon discounts, free quests.
4. `03_OFFLINE_PWA_AND_PROGRESS_MODEL.md` — **The highest-risk document.** Hard requirement for full offline play + server-authoritative correctness. Contains the central tension and proposed two-phase model.
5. `04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md` — GameStep as the unit, task types (physical vs answer-required), what the internal admin constructor MVP must support.
6. `05_ROLES_PERMISSIONS_AND_AUTH.md` — Only Administrator (internal) + Player. Clean auth surface. No legacy magic links or mandatory Telegram primary.
7. `06_V1_REQUIREMENTS_AND_CUT_LIST.md` — Must / Should / Cut. Success criteria.
8. `07_ASSUMPTIONS_RISKS_AND_OPEN_QUESTIONS.md` — The attack surface. Everything that still needs to be beaten on.

## Process

We are following an adversarial cycle:
- Deconstruct the old system and new inputs.
- Expose flaws harshly (including in our own proposals).
- Rebuild cleaner models.
- Self-critique.
- Iterate with the stakeholder (you) until the model survives scrutiny.

**Current status of these docs:** v0.2 — major updates to offline model (client validates local snapshot fully, no server re-validation on sync, versioned bundles, physical steps as confirmation-only), auth (email+password MVP only), answer representation (list of strings), constructor preview (save + test player), coin economy (earned only via play), import desire, ~5 MB size, no branching v1. Old assumptions updated or removed. Still open questions remain (see 07_).

## How to Use

- Read and **attack** them. Point out where the model is too simple, too complex, or based on a false assumption.
- Answer the open questions (especially in 07 and the inline questions in 03/04).
- Provide concrete examples from real quests (step lists, how "Mystery of the Fortress" statue interaction was implemented, what answers look like, etc.).
- Once a critical mass of decisions is locked, we will produce v0.2 (tighter invariants, full use-case list, error scenarios) and only then consider detailed implementation strategy or tech choices.

The goal is a robust, minimal, maintainable foundation that justifies every piece of retained complexity against real business needs (TDD, SOLID, DRY, KISS, YAGNI mindset applied at the conceptual level first).

## Relation to Tech Stack

Per original request: these are deliberately **business and conceptual only**. Rust + Next.js was mentioned as a target direction, but we will evaluate (or re-evaluate) any stack only after the model here is stable and the hardest trade-offs (especially offline validation + PWA bundle strategy) are explicit.

## Maintenance

When decisions change, update the relevant file(s) and note the version/date. Do not let implementation details leak backward into these docs.
