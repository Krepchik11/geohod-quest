# Design: Initial Project Setup (Monorepo + OpenSpec Self-Containment)

## Overview
This change bootstraps the runnable monorepo and integrates the OpenSpec workflow tooling directly into it. The goal is a clean, verifiable starting point that enforces the project's extreme quality standards from the first line of code.

## Layout Decisions
- **Root**: `platform/` — explicitly "only project files" as requested. Sits at `quests/platform/` alongside (but not mixing) `blueprint/`, `business/`, and the now-moved-from `engine/`.
- `backend/`: Self-contained Cargo binary. Started flat (single crate) per KISS/YAGNI. Will be promoted to workspace members only when real crates (domain, persistence, etc.) are justified by failing tests or duplication.
- `frontend/`: Standard Next.js app dir inside npm workspace. No premature `packages/ui` or `packages/types` (YAGNI until the first shared contract or component is extracted during a real feature slice).
- `openspec/` + `.claude/`: Moved verbatim from the old isolated `engine/`. This makes the monorepo the single checkout for both implementation and its spec-driven governance. Slash commands and skills now travel with the code.
- Root orchestration: npm workspaces (only for the JS side) + `concurrently` for convenient joint dev. Pure Cargo commands remain the source of truth for Rust.

## Technology Choices & Version Pinning (after research + skepticism)
- Rust 1.96.0 (exact match to latest stable at time of creation) + `rust-toolchain.toml` (reproducible + forces rustfmt/clippy).
- Axum 0.8 (current, ergonomic, tower-native) + the exact crates mandated or strongly implied by `agents/rust.md` (tracing, tower-http layers, thiserror/anyhow, dotenvy, serde).
- Next.js 16.2 + React 19 (current stable series). Created with official flags for Tailwind + ESLint + TS.
- npm (not pnpm) only because `corepack` / global pnpm was unavailable in the execution environment. Workspaces + scripts still deliver monorepo DX. Upgrade path is trivial (`pnpm import`).

All choices were attacked:
- "Just put everything in one flat dir" — rejected for clarity between Rust and JS concerns.
- "Use Turborepo from day 1" — rejected (YAGNI; caching pain not yet felt).
- "Start with full DB + domain models" — rejected (YAGNI; model still being hardened in business/ docs).
- "Leave engine/ separate forever" — rejected; self-containment wins for long-term spec-driven velocity.

## Architecture Highlights (Skeletons Only)
**Backend (Rust)**:
- `src/config.rs`: Pure from-env loader, documented, returns `anyhow::Result`.
- `src/errors.rs`: Single `AppError` variant for handlers, `tracing::error!` + consistent JSON, `IntoResponse`.
- `src/main.rs`: `build_router` extracted for direct testing (axum `oneshot`), layers (Trace, Cors, Timeout), graceful shutdown, `#[tokio::main]`, one real `#[tokio::test]`.
- Strict: no `unwrap`/`expect` in non-test paths except documented startup invariants; all public items documented.

**Frontend (Next.js)**:
- `app/layout.tsx`: `lang="ru"` (v1 requirement), updated GeoQuest metadata, fonts hoisted at module level (matches react.md hoisting guidance).
- `app/page.tsx`: Pure Server Component. Three cards directly reflecting the locked "three components" from CONCEPT + client requirements. No `'use client'`, no state, no effects. Small extracted `ComponentCard` for readability/future memoization.
- Build produces static routes cleanly.

## Move of Engine Tooling
`mv engine/.claude platform/.claude && mv engine/openspec platform/openspec` (then rmdir of the now-empty engine/).

Rationale: The OpenSpec skills, commands (`/opsx:apply` etc.), and config must be co-located with the code they govern. This also means the rich context we added to `config.yaml` (domain + principles + current state) is now the single source that future `openspec instructions` and AI sessions will see.

## Verification Strategy (enforced in tasks)
Every major step ends with an explicit gate:
- Rust: `cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- Frontend: `npm run build`
- Root: orchestration scripts + `openspec status` / `openspec list`
- Final tree inspection + re-read of critical files for guideline violations.

## Risks & Trade-offs Acknowledged
- Empty `engine/` left behind temporarily (cleaned in final task).
- npm instead of pnpm (documented; low risk).
- No real domain code yet — deliberate. The skeletons are intentionally minimal so the first real slice (e.g. shared GameStep types + pure projection functions + goldens) can be added without fighting legacy structure.
- The adversarial cycle was applied to the move itself: "Why move the tooling now?" → self-containment and correct context for all future applies wins over "keep engine separate for cleanliness."

This design survived the internal critique pass. It is the minimal structure that still gives us excellent DX, strict quality enforcement, and proper OpenSpec integration from day one.