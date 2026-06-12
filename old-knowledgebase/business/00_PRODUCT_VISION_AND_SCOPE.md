# GeoQuest — Product Vision and Scope (Business Concept v0.1)

**Status:** Draft — based on reverse-engineered Bubble artifacts + direct clarifications (2026-06).  
**Scope:** Quest playing engine + commerce + internal quest constructor only.  
**Explicit exclusions:** Events/calendar/tours, multi-language beyond Russian (v1), external authors, complex gamification beyond hint coins.

## Core Value Proposition

GeoQuest enables an internal team to create, publish, and sell **sequential real-world or narrative game experiences** ("quests") to players.

A quest is a designed sequence of **game steps**. Each step requires the player to:
- Observe/find something in the physical world (sometimes with a specific action), or
- Solve for and submit a specific answer (knowledge, observation, puzzle).

Players pay once (or receive via coupon/free) and gain **lifetime access** to play the quest as many times as they want, with the ability to reset progress or continue previous attempts.

The product must work as a **Progressive Web App (PWA)** with first-class **offline support**: a player must be able to download a quest and complete (most of) it without network connectivity, with progress syncing when connectivity returns.

## What Success Looks Like (Business)

- Internal administrators can efficiently build and iterate on quests using an in-product constructor.
- Players discover quests, purchase (or get free/coupon) access, download for offline, play through the sequence (with immediate feedback where possible), and have their progress and completions recorded authoritatively.
- Revenue comes from one-time quest purchases (with coupon discounts) and possibly in-game coin top-ups for hints.
- No dependency on the dead event/calendar system.

## Explicit Scope Decisions (Locked from Clarifications)

**Included in v1 scope:**
- Quest catalog / discovery (for players)
- Quest player (online + full offline PWA)
- Commerce: one-time purchases, coupons (percentage discounts), free quests (same mechanics, price 0 or auto-grant)
- Lifetime access grants per user per quest
- Multiple attempts per user per quest + reset/continue
- In-game coins for purchasing hints (hint reveals geo object on map)
- Internal-only Administrator role + quest constructor (MVP authoring)
- Russian language only (v1)
- Server-authoritative correctness for answer steps (with offline play accommodations)
- Basic reviews/ratings (post-completion)
- Admin visibility into purchases, attempts, popular quests

**Explicitly out of v1 (or dead):**
- Events, calendar, bookings, work times, programs, meeting points, etc. (entire parallel domain — confirmed dead)
- Author role (no external or semi-privileged content creators)
- Multi-language (EN/SRB fields and switching) — design so it is not painful to add later, but do not implement
- Magic links, password reset flows for existing users (cleaner auth surface)
- Complex leaked UI state on User records
- "Constructor" duplication patterns from old model
- Unknown plugins and dead workflows (666, etc.)

## Key Non-Functional / Hard Constraints

- **Offline-first PWA**: Load full quest content + be able to advance through steps, submit answers/tasks, spend coins on hints, all while offline. Media (at minimum images, ideally short videos) must be cached locally.
- Server remains source of truth for correctness, completions, and grants.
- No GDPR / data retention legal requirements (simplifies deletion/export).
- Growth rate unknown — design for small-to-medium scale initially (tens of quests, thousands of active players) but with clean boundaries so scaling paths are obvious later.

## Guiding Principles for the Rebuild

- Every piece of complexity in the old system must be justified against the clarified business needs or cut (YAGNI).
- The model must support offline play without turning the client into an untrusted oracle for paid content.
- The quest constructor and player must be delightful for the internal team and players respectively — high readability and maintainability of the domain model is non-negotiable.
- Prefer simple, explicit aggregates and clear invariants over clever normalization or premature generality.

---

**Assumptions in this vision (to be attacked):**
- "Buy once, play forever" + replay with reset/continue is the dominant and sufficient access model.
- Physical "no-answer" steps can be completed by simple player confirmation ("I found it / I performed the action") without additional proof for v1.
- Hint coins are a lightweight in-game economy (not real-money microtransactions at launch).
- The internal team is the only content producer for the foreseeable future.

**Next sections (see sibling docs):**
- Domain model and conceptual schema
- Commerce and access model
- Offline + progress model (the highest-risk area)
- Content model and constructor requirements
- Roles, auth, and permissions
- v1 requirements + cut list + risks
