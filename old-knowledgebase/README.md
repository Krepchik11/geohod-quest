# Old Knowledgebase (Archived Materials)

This directory contains all historical documentation, analyses, data, and artifacts that were used during the exploratory and design phases to produce the **primary blueprints** now located in `../blueprint/`.

## Contents
- `business/` — Product vision, domain models, commerce details, offline/PWA models, content/constructor requirements, roles/auth, V1 requirements, assumptions/risks, decisions log, "why the questions", and extensive `analysis/` (variant explorations, reviews, synthesis, FINAL-BEST-PRACTICE-BLUEPRINT.md, etc.).
- `docs/` — Earlier structured documentation (executive summary, application overview, data model, API surface, workflows, pages/journeys, integrations, security, migration mapping, etc.) reverse-engineered from the legacy system.
- `discovery/` — Raw and parsed data from the original Bubble.io app (workflows, data types, element definitions, pages, API events, etc.), plus Python scripts used for discovery and doc generation.
- `geoquest.bubble` — The original Bubble export file.

## Purpose
These materials are preserved **for occasional reference** if specific historical questions, data mapping needs (e.g., for goldens or migration), or "why did we decide X?" inquiries arise later.

**They are no longer the primary source of truth.**

## For Development
- All conceptual guidance, model definitions, invariants, and the recommended development sequence live exclusively in `../blueprint/`.
- See especially:
  - `../blueprint/CONCEPT.md`
  - `../blueprint/PLAN.md` (including the "Immediate Next Actions (Do These Before Code)" section)
  - `../blueprint/SPEC.md`
  - `../blueprint/TECH.md`

Start new feature work by following the blueprints. The old knowledgebase is a backup only.

---
Archived as part of cleaning the project to start development cleanly from the blueprints (June 2026).
