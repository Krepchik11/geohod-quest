# Parallel Adversarial Analysis — Master Coordination

**Initiated:** Heavy-lifting long-running task per user request (Chief Staff Engineer + Critical Analyst mode with full cycle on every feature).

**Goal:** One-by-one (and in parallel where possible) deep skeptical analysis of *every* business feature/requirement from the `business/` foundation documents + locked decisions + historical discovery data. For each:
- Deconstruct edge cases/races/bottlenecks/violations.
- Expose flaws harshly (old system, current proposals, alternatives).
- Rebuild multiple distinct solutions (3+ per area).
- Self-critique each.
- Iterate internally.
- Recommend best-practice under TDD/SOLID/DRY/KISS/YAGNI + max robustness/maintainability/readability.
- Produce rich, standalone documentation.

**Process:**
- Master todo breakdown created (see main conversation todos or this dir).
- Multiple independent subagents launched in parallel for different slices (background long-running).
- Each subagent produces a detailed `*-variants.md` report in this directory applying the mandated cycle with extreme skepticism.
- Main thread (me) will:
  - Monitor/fetch outputs.
  - Cross-review with additional skepticism.
  - Resolve conflicts/trade-offs.
  - Perform synthesis (SYNTH-001).
  - Produce final "Project Blueprint" with all approaches described, chosen one + rigorous why, updated overall docs, recommended patterns, risks, how constraints are satisfied.
- Additional reviewer subagents will be spawned on merged artifacts for final adversarial passes until it "survives scrutiny".

**Spawned Subagents (initial wave — more can be added):**
- ANALYZE-01: Offline PWA Snapshot & Validation Model (subagent_id 019ead82-7b9f-76f0-ac45-21521ada0e68)
- ANALYZE-02: Quest Versioning, Publishing & Snapshot Retention (019ead82-7ba2-7bd2-9243-5279df099c48)
- ANALYZE-03: GameStep Model & Completion Semantics (019ead82-7ba2-7bd2-9243-528540773fed)
- ANALYZE-04: Coins/Hint Economy & Earning Mechanics (019ead82-7ba3-7f01-8357-7f9403a60059)
- ANALYZE-07: Quest Constructor MVP & Authoring UX (019ead82-7ba3-7f01-8357-7fa97f35f04d)
- ANALYZE-05: QuestAttempt, Replay, Reset, Continue & Sync (newly launched)
- ANALYZE-09: Data Migration/Import & Historical Fidelity (newly launched)

**How to monitor (for transparency):** Use `get_command_or_subagent_output` with the subagent_ids above (block=true for waiting on long ones).

**Current artifacts will accumulate here:**
- Per-feature `*-variants.md` (multiple solutions + full cycle + rationale).
- Later: merged trade-off analysis, FINAL-BEST-PRACTICE-BLUEPRINT.md, updates back to main `business/` docs.

This is deliberate heavy lifting to make the project the best possible through continuous skepticism. No approach is safe until proven.

Next steps after initial wave completes: Fetch reports, launch remaining (commerce, non-functionals, domain cross-cut), then synthesis + review iteration.

All outputs will prioritize the constraints and produce maximum documentation.