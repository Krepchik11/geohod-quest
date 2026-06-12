# Backend Requirements for New Design (from design/uploads + CONCEPT/SPEC/PLAN)

This is the prep document for implementing the Rust Axum backend to support the fully rewritten design.

## Core Model (from new SPEC)
- GameStep with 7 templates: 'start' | 'video' | 'task_no' | 'task_answer' | 'continue' | 'route_video' | 'congrats'
- One GameStep shape (discriminated by template for render, completion for mechanic).
- All amounts/lists (acceptable, gift.coins, hint.cost) **frozen** in published snapshot.
- Negative balance is legal (no blocks, no revocations).

## Facts / Sync (PWA + offline)
- Append-only log of AttemptFact, CoinFact, FeedbackReport.
- Idempotent append (by natural key: fact_id or (attempt, step, type, device)).
- Projectors must be pure and match client exactly:
  - projectBalance(facts) — sum coins_delta (can be negative)
  - projectState(facts) — sets of completed, revealed hints, etc.
- Corrections (limited, v1):
  - Balance re-projection notice after multi-device merge.
  - "Attempt advanced on another device" offer (union of facts, never lose progress).
- No compensation facts for overdraft or hints.

## Grants / Commerce
- Lifetime AccessGrant per (player, quest).
- Sources: payment, coupon (incl 100% → 0 ₽), free, admin.
- Idempotent creation (source audit).
- Grant required before attempt creation or bundle download.
- Checkout: provider redirect (no card fields on our side). Telegram auth required pre-purchase. Coupon collapsed link. 100% coupon or free → same grant path, total 0, "Получить бесплатно".

## Publish / Snapshots / Bundles
- Publish creates immutable QuestVersionSnapshot + bundle.
- Bundle contents: ordered GameSteps + all content + comic images (4 roles) + acceptable lists + frozen supporting (gifts, hints, nav geo) + video refs + version id + integrity.
- Target ~5 MB.
- New attempts always use latest published version; active attempts stay on the version they started with.
- Ctor "Открыть как тест-игрок": persist draft + temp grant + open real player (uses the draft snapshot for that playthrough).

## Constructor (internal)
- Template picker with **live mini-previews** rendered by the real player components (not screenshots).
- Per-step editor: content, 4 comic upload zones (task required on task_*), AnswerListEditor (+ paste lines + live test using exact shared isAnswerCorrect), gift (with "freezes in snapshot" note), hint, navigator toggle (lat/lng), live phone preview (with "show with purchased hint" toggle).
- Publish gates (errors block): has start, has terminal, task image on task templates, acceptable lists non-empty for answer steps, nav coords if enabled, size est warning vs 5MB, dry-run serialize.
- Publish modal: creates immutable version N; new attempts on N, old attempts keep theirs.

## Player PWA
- 7 template renderers (exact structure from design/player/components.jsx + screens).
- Paper visual system (distinct from site blue).
- Wrong flow: 1st wrong → inline; 2nd+ → popup hint purchase (cost frozen per step); after purchase hint stays revealed for the attempt.
- Coins: toasts (compact, sound), gifts + completion +5 (idemp).
- Menu on every page: progress, balance, sound, feedback report (every step), pause/reset (coins survive), offline/sync status.
- Final variant B (default): stats, inline rating.
- Navigator: system maps URL handoff (no in-app map, no routing data in bundle).
- Offline: local facts queue + projection; banners for offline/syncing/done.
- Bundle download gated by grant; manifest for updates.

## Admin / Visibility
- Per-version stats (attempts, completions, wrongs submitted, hints purchased, navigator uses, FeedbackReports per step).
- Read-only lists of FeedbackReports.

## API Surface (suggested, for Axum)
- POST /api/attempts (create with grant check) → attempt_id + snapshot
- POST /api/attempts/:id/facts (idempotent append batch)
- GET /api/attempts/:id/state (or facts + client projects; or server project)
- GET /api/quests/:id/bundle?version= (gated by grant; manifest + assets)
- POST /api/quests/publish (ctor internal; creates snapshot + triggers bundle build)
- POST /api/checkout (player_id, quest_id, coupon? ) → grant (idemp, source audit)
- GET /api/admin/versions/:id/stats
- GET /api/admin/versions/:id/feedbacks
- (Future) GET /api/my-quests (grants + attempt states + download tickets)

## Invariants / Goldens
- Client and server project* must be identical (goldens enforce).
- isAnswerCorrect parity (ctor test == player submit).
- All new goldens must cover 7 templates, hint popup on 2nd wrong, negative balance, multi-device, publish during active, long offline replay.

## Risks (from new PLAN)
- Negative balance farming → monitor per player (rating floor 0).
- Bundle size → ctor est gate + compression.
- Frozen bad content → gates + live preview + test-player + per-step analytics + FeedbackReports.

Implement backend slices after frontend pages are matching the design JSX screens.

See also synced blueprint/PLAN.md (Phase 3 sync, Phase 4 polish/migration).
