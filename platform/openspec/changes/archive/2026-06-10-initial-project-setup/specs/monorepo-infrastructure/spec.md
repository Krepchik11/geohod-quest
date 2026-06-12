# monorepo-infrastructure

This capability covers the foundational monorepo layout, OpenSpec self-containment, and the initial clean skeletons for the Rust backend and Next.js frontend.

## Requirements

- The project shall live in a single `platform/` directory containing only production code + its own spec management tooling.
- `backend/` shall be a reproducible, high-quality Rust application (pinned toolchain, full agent guideline compliance, passing gates on every change).
- `frontend/` shall be a reproducible, high-quality Next.js application (RSC-first, full relevant agent guideline compliance, passing production build).
- The OpenSpec engine (`.claude/` skills + `openspec/`) shall be moved into the monorepo root so that `openspec` commands, status, and instructions run with complete project context (tech + domain + principles).
- Root-level orchestration (npm workspaces + scripts) shall exist for convenient cross-language dev, build, test, and lint.
- All of the above must be immediately verifiable via documented commands; no "it works on my machine" state.

## Non-Goals (for this capability)

- Any domain model types, facts, GameStep, snapshots, or API surfaces (those belong in later capabilities once the business model is further locked).
- Database, auth, real PWA service worker, or bundle packing logic.
- Multi-crate Rust workspace or shared `packages/` (added only when duplication or a real shared contract appears).

## Open Questions

- Will `platform/` eventually absorb `blueprint/` and `business/` (making the whole thing one checkout), or will they stay as sibling reference material?
- Exact name of the top-level npm package / docker image (deferred).

(This spec is intentionally lightweight because the primary requirements and invariants live in the business/ and blueprint/ documents. This capability exists only to make the *container* for future spec-driven work correct and self-describing.)
