# Design: design-fidelity-frontend

## Context

Audit (3 parallel design-vs-frontend comparisons, 2026-06-11) measured: My Quests ~25% fidelity (admin layout misuse, no states), commerce ~40% (no coupon states/result screens/entry variants), constructor ~55% (no versions panel, no checklist/modal), player paper theme missing 5 tokens + all keyframes + anims gating, PWA correction UI absent. PLAN Phase 0 explicitly prescribes the approach: design CSS is reference implementation — lift tokens, copy, component structure; rewrite JSX as typed components (matcher was the only verbatim-port module; CSS is copy-adapted).

## Goals / Non-Goals

**Goals:**
- Pixel-faithful port of the five design CSS families into scoped frontend stylesheets; pages restructured onto the designed class vocabulary and RU copy.
- The two SPEC sync corrections get their designed UI, driven exclusively by the existing pure `deriveSyncCorrections`.
- Fixture page as the visual regression baseline; lint debt zeroed.

**Non-Goals:**
- Service worker / real offline (P4) — sync sheet renders the local pending queue, the banner reflects current sim/online state.
- comic/modern art directions (cut: paper is the single global player art).
- Real video playback, photo galleries, policy pages (PLAN "secondary gaps").
- Backend changes (none needed — P1/P2 surfaces suffice).

## Decisions

1. **CSS strategy: dedicated ported stylesheets, globals.css keeps only base/reset + site core it already has.** New files under `app/styles/`: `player-paper.css`, `commerce.css`, `myquests.css`, `admin-ctor.css`, `pwa-sync.css`, imported from `app/layout.tsx` after globals. Rationale: verbatim-adapted copies stay diffable against their design sources (review = file-to-file diff); editing the existing 26 KB globals.css in place would interleave derived-and-wrong rules with ported ones. Conflicting weaker rules already in globals.css for the same selectors (.p-*) are DELETED from globals.css, not overridden — one source per class family.

2. **Paper-only player port.** `theme.css` ships three art directions; CONCEPT decided one global paper direction. Port the shared `.p-*` structure + paper block only, with paper token values inlined as the `.pframe` defaults (no `[data-art]` switching surface to maintain — YAGNI; the data-attribute stays as a no-op marker for fixture parity).

3. **Anims gating per SPEC Asset Hygiene:** every `@keyframes`-using rule is written so the end state is the base style; `[data-anims="off"] *` kills animation+transition; a `@media (prefers-reduced-motion: reduce)` block mirrors it. Player frame sets `data-anims` from a flag (default on).

4. **Correction popups live in the player, fed only by `deriveSyncCorrections` output stored in reducer state** (`pendingCorrections`), set after sync, cleared on dismiss/accept. Advance-offer accept = `dispatch(advance to server_step+1 clamped)`. No new protocol surface.

5. **Sync sheet = menu sub-view** listing local facts with human RU labels per fact kind and ждёт/отправлено chips (sent = fact accepted by last sync — tracked as a `syncedKeys` set of natural-key strings in component state; P4 replaces this with the real queue).

6. **Profile/entry data**: profile tiles fold the local fact log (balance, rating = max(balance,0), completed count); quest-detail entry variant chosen from grants list + price (price still demo data — commerce pricing is P5 scope). Honest placeholder over fake wiring.

7. **Lint fixes are mechanical, not architectural**: type the wire shapes (`unknown` + narrow), replace `<a href="/...">` with `next/link`, move fetch-on-mount setState into the recommended pattern. No page logic changes ride along.

## Risks / Trade-offs

- [Deleting .p-* rules from globals.css breaks pages relying on the old weaker styles] → the player is the only .p-* consumer; fixture + manual pass over /quest after port.
- [Ported CSS drifts from design source over time] → file-per-source mapping documented at the top of each ported file; future edits diff against design/.
- [Sync sheet "sent" tracking is approximate until P4] → labeled in code; queue semantics arrive with the real offline queue.

## Migration Plan

Frontend-only, additive + page rewrites. Gate: vitest, lint (now zero-error), next build, manual fixture pass. No data concerns.

## Open Questions

None blocking.
