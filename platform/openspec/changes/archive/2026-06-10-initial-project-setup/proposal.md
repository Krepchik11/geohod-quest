## Why

The project had its OpenSpec "engine" (config, skills, slash commands) isolated in a sibling `engine/` directory, while the actual runnable code (backend + frontend) needed a clean monorepo home. To enable true spec-driven development going forward, the entire project—including its planning tooling—must live together in one self-contained monorepo (`platform/`). This allows changes, tasks, and specs to be versioned and applied directly against the Rust + Next.js source with full context.

This initial setup also establishes the high-quality, skeptical foundation (TDD/SOLID/DRY/KISS/YAGNI + strict agent guidelines) before any domain code is written.

## What Changes

- Created new `platform/` directory as the monorepo root containing *only* project files.
- Initialized `backend/` as a clean Rust 1.96 + Axum binary following every rule in `agents/rust.md` (rust-toolchain.toml, thiserror/anyhow, tracing not println, no prod unwraps, doc comments, tests, fmt + clippy -D, etc.). Health endpoint + basic layered architecture (config, errors, router/state) with passing gates.
- Initialized `frontend/` as Next.js 16 + React 19 (RSC-first) following every applicable rule in `agents/react.md` (module hoisting, no bad patterns in seed, pure Server Components, accurate domain landing reflecting the 3 components + 4 templates, lang=ru, etc.). Passing production build.
- Moved **all** folders and files from the old `engine/` (`.claude/` skills + commands for /opsx:* and `openspec/`) directly into `platform/`. The old `engine/` is now empty and will be removed.
- Updated `openspec/config.yaml` with rich project context (monorepo layout, exact tech + versions, full domain summary from blueprint/business, non-negotiable principles and agent rules, current state).
- Bootstrapped this change (`initial-project-setup`) using `openspec new change` and populated the full planning artifacts (proposal, design, tasks, minimal specs) so the work is properly tracked in the spec-driven flow.
- Added root npm workspace orchestration (scripts for dev/build/test/lint spanning backend + frontend) + high-quality README + .gitignore.
- All quality gates verified multiple times (cargo test/clippy/fmt, next build, root scripts).

**No breaking changes** to any existing specs (none existed).

## Capabilities

### New Capabilities
- `monorepo-infrastructure`: The foundational monorepo layout, OpenSpec self-containment (engine move), clean skeleton initialization for backend (Rust/Axum) and frontend (Next.js), and the initial change tracking setup. This enables all future spec-driven slices (facts model, GameStep, offline bundles, constructor, etc.).

### Modified Capabilities
(none — this change introduces infrastructure and process; no existing requirement-level specs were modified)

## Impact

- New top-level `platform/` becomes the single source for code + planning.
- `backend/`, `frontend/`, `openspec/`, `.claude/` now co-located.
- `../blueprint/` and `../business/` remain the source of truth for domain (referenced from config and README).
- Future `openspec apply`, status, and instructions will run with full monorepo context and the agent guidelines embedded.
- Root scripts and CI-friendly structure added.
- No user-facing API or data model changes yet (YAGNI).

This change is complete once the artifacts are written, tasks are tracked, and the move + skeletons are verified.