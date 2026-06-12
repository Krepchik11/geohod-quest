## 1. Research & Decision

- [x] 1.1 Research latest stable Rust version (1.96.0) and Next.js version (16.2 series) using available tools.
- [x] 1.2 Deconstruct monorepo layout options, engine move vs separate, npm vs pnpm, flat vs workspace crates, and all other major choices against TDD/SOLID/DRY/KISS/YAGNI + the two agent guideline files. Expose flaws, rebuild, self-critique.
- [x] 1.3 Decide on `platform/` as the new clean folder (parallel to old engine/), backend/ + frontend/ substructure, and that the entire engine/ (.claude + openspec) must be moved into it for self-contained spec-driven development.

## 2. Create Monorepo Skeletons

- [x] 2.1 Create `platform/` directory (and backend/, frontend/ subdirs) containing only project files.
- [x] 2.2 Initialize backend/ with `cargo init`, add required dependencies via `cargo add` (axum, tokio, tower-http with features, tracing, thiserror, anyhow, dotenvy, serde with derive, etc.).
- [x] 2.3 Implement clean layered backend (config.rs, errors.rs, main.rs with build_router for testability, health endpoint, middleware, graceful shutdown, one real test). Strictly follow agents/rust.md on every line.
- [x] 2.4 Run full Rust gates: `cargo fmt`, `cargo check`, `cargo clippy -- -D warnings`, `cargo test`. Fix any issues found (serde derive feature, timeout layer args, duplicate From, unused imports, etc.) until completely clean.
- [x] 2.5 Initialize frontend/ with `npx create-next-app@latest` (TS, Tailwind, ESLint).
- [x] 2.6 Audit and fix generated frontend against agents/react.md (update metadata + lang="ru", replace default marketing page with pure RSC 3-component landing matching CONCEPT/SPEC, hoist fonts, extract small ComponentCard, remove external spam links). Verify with `npm run build`.

## 3. Monorepo DX & Documentation

- [x] 3.1 Add root `package.json` (npm workspaces for frontend, scripts for dev/build/test/lint that cross backend + frontend using concurrently).
- [x] 3.2 Add comprehensive root `.gitignore` (target/, .next/, node_modules/, .env*, OS junk, etc.).
- [x] 3.3 Write high-quality root `README.md` describing layout, quick start commands (two terminals + joint), principles, links to blueprint/business, verification performed, and evolution notes.

## 4. Integrate OpenSpec Engine (the move)

- [x] 4.1 Move all folders and files from the old `engine/` directory (specifically `.claude/` containing skills and opsx commands, and `openspec/`) into `platform/`.
- [x] 4.2 Verify new structure: `platform/openspec/config.yaml`, `platform/.claude/skills/openspec-apply-change/SKILL.md`, etc. are present.
- [x] 4.3 Remove the now-empty old `engine/` directory.
- [x] 4.4 Update `platform/openspec/config.yaml` with rich, accurate context (full monorepo description, exact versions + crates, domain summary, principles, agent rules, current state after the change). This makes all future instructions and applies see the real project.

## 5. Establish Proper OpenSpec Change Flow

- [x] 5.1 From inside `platform/`, run `openspec new change initial-project-setup` to create the change directory in the correct location.
- [x] 5.2 Run `openspec status --change initial-project-setup --json` and `openspec instructions ...` commands to follow the official apply flow.
- [x] 5.3 Create proposal.md, design.md, specs/monorepo-infrastructure/spec.md, and this tasks.md following the exact templates and rules returned by the CLI instructions.
- [x] 5.4 Mark all completed and verified tasks with `[x]` in tasks.md (this file). Re-run status to confirm progress.

## 6. Final Verification & Self-Critique

- [x] 6.1 Re-read all critical created files (backend/src/*.rs, frontend/app/{layout,page}.tsx, root package.json + README, the new openspec artifacts, config.yaml).
- [x] 6.2 Re-execute all gates from platform/: root build + test scripts, backend clippy/test/fmt, frontend build, `openspec list` and `openspec status`.
- [x] 6.3 Inspect final directory tree. Confirm no mixing of docs/business into platform/, no guideline violations remain, old engine/ is gone, openspec now roots correctly at platform/.
- [x] 6.4 Perform one last adversarial pass: are there any remaining flaws in the structure, any over-engineering, any missing verification, any place where we violated KISS or the "only project files" request? Document in this task or proposal if needed.
- [x] 6.5 Confirm that `openspec instructions apply --change initial-project-setup` can now be used for future work on this change, and that the project state (including the move and skeletons) is fully reflected in the openspec artifacts and config.

All tasks above are complete and have been verified with the commands listed. The monorepo + self-contained OpenSpec setup is now in place and ready for the next spec-driven slice.