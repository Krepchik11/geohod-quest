# Tasks

Order is TDD: each code task is preceded by the failing test that demands it. Backend
first (the read folds are the correctness core), then the frontend tabs.

## 1. Moderation overlay store + migration (data model)
- [x] 1.1 Migration `0016_moderation_and_telegram_username.sql`: `hidden_reviews(player_id, quest_id, hidden_at BIGINT, hidden_by TEXT, PK(player_id,quest_id))`; `resolved_feedback(quest_id, snapshot_id, step_position INT, resolved_at BIGINT, resolved_by TEXT, PK(quest_id,snapshot_id,step_position))`; `ALTER TABLE auth_identities ADD COLUMN username TEXT`; RLS enabled on both new tables (mirror `0012`); expression index `facts((data->>'type'))` for the global scans.
- [x] 1.2 `store.rs` tests: hide/unhide idempotent; `hidden_review_keys` set; resolve upserts `resolved_at`, reopen deletes; `feedback_resolutions` map. `InMemoryModerationStore` green (4 tests pass).
- [x] 1.3 `ModerationStores` enum (InMemory `Arc<Mutex<..>>` + Postgres) with async dispatch mirroring `GrantStores`; `PgModerationStore` SQL. `AppState.moderation` field; wired in `in_memory_state()` + both Postgres `AppState`s.
- [ ] 1.4 Store-parity assertion in `pg_full_suite`: same hide/unhide/resolve/reopen sequence yields equal hidden set + watermarks on InMemory and Pg (Pg self-skips without `DATABASE_URL`). [deferred to the pg-suite step]

## 2. Telegram @username capture (player-identity)
- [x] 2.1 `AuthIdentity` gains `username: Option<String>`; round-tripped through `create_identity` / `identities_for_player` / `identities_for_players`. New `set_identity_username` refreshes on re-login (overwrites when present, leaves the prior value on an absent claim). Verified by the route tests below.
- [x] 2.2 `AuthIdentity` + Pg readers/insert carry `username` (migration 0016 adds the column); `telegram_auth_handler` threads `claims.preferred_username` through `SocialIdentity` into create/link + the refresh path.
- [x] 2.3 Route tests `telegram_username_is_captured_and_refreshed` (capture → changed handle overwrites → absent claim leaves it) + `telegram_handleless_user_has_no_username`. 18 telegram tests green.

## 3. Quest-level rating fold — per-player, all-versions, hide-aware
- [x] 3.1 `facts.rs` unit tests (`effective_rating_takes_last_and_reads_text`, `fold_rating_rows_is_mean_over_non_hidden`, `quest_reviews_excludes_star_only_and_hidden_newest_first`) + `store.rs` (`quest_rating_rows_one_per_player_latest_across_versions`, `..._folds_hide_aware_average`). Pure quest-level fold implemented: `PlayerRatingRow` + `effective_rating`/`fold_rating_rows`/`quest_reviews`/`quest_reviews_total`.
- [x] 3.2 Replaced `reviews_for_quest` with per-`(player,quest)` `quest_rating_rows` + the pure `quest_reviews` (500-char clamp kept; author label resolved in the handler). Old `ReviewRow` + `rating_stats_for_snapshots` removed (InMemory + Pg + enum).
- [x] 3.3 `get_quest_product_handler` + `list_quests_handler` now fold `quest_rating_rows` with the hidden set from `state.moderation` (concurrent reads; grouped by quest).
- [x] 3.4 `scenario_product_page` still green under the new averaging; a dedicated route test (`admin_reviews_list_identities_star_only_and_hide_from_average`) asserts the product-page average shifts 4.0→14/3 when the anon rating is hidden and restores on unhide.

## 4. Global feedback grouping + resolution (count) watermark
- [x] 4.1 `facts.rs` unit tests (`group_feedback_buckets_by_quest_snapshot_step_newest_first`, `group_resolved_only_while_no_report_exceeds_the_acknowledged_count`). Pure `group_feedback(reports, resolutions)` implemented. **DESIGN CHANGE:** switched from a timestamp watermark to a COUNT watermark — resolved iff current report count ≤ `acknowledged` — because second-granularity timestamps could not guarantee a same-second report reopens (append-only counts are clock-independent). Step label/version/current-vs-archive resolved in the handler from the frozen snapshot + published meta.
- [x] 4.2 `all_feedback_reports` (InMemory via parallel `fact_times`; Pg via `data->>'type'` scan joined to attempts, `recorded_at` carried) + `store.rs` test `all_feedback_reports_gathers_context_and_excludes_non_feedback`.

## 5. Admin identity + contact resolution
- [x] 5.1/5.2 `resolve_admin_identity` (kind priority google>email>telegram>anon; contact mailto / t.me / none) + batch `resolve_admin_identities` over two reads (`get_users_by_ids` + new `identities_for_players`) — no N+1. Covered by the route tests (identity/contact per kind, incl. star-only anon + handleless telegram).

## 6. Global admin endpoints (admins-only)
- [x] 6.1 Route tests: `admin_reviews_list_identities_star_only_and_hide_from_average`, `admin_feedback_groups_resolve_and_reopen_on_new_report` (incl. reopen-on-new-report via the count watermark, current/archive, version, step label), `moderation_endpoints_require_admin` (403 without admin on all six; 200 with `X-Admin-Token`).
- [x] 6.2 Six handlers + wire types (`AdminReviewWire`/`AdminReviewsResponse`/`AdminFeedbackGroupWire`/`AdminReportWire`/`AdminIdentityWire` + request bodies), all `require_admin_actor`; routes registered. **206 backend tests pass, clippy + fmt clean.**

## 7. Frontend — API client
- [x] 7.1/7.2 `lib/api.ts`: wire types (`AdminIdentityWire`/`AdminReviewWire`/`AdminReviewsResponse`/`AdminReportWire`/`AdminFeedbackGroupWire`/`AdminFeedbackResponse` + request bodies) + six methods (`adminListReviews`, `adminHideReview`, `adminUnhideReview`, `adminListFeedback`, `adminResolveFeedback`, `adminReopenFeedback`) via `apiFetch(..., { headers: adminHeaders() })` (204 handled). Testable view-model helpers in `lib/admin-moderation.ts` (relative time, badge/contact, template label, hide-aware `questAverage`) with `lib/__tests__/admin-moderation.test.ts`.

## 8. Frontend — tabs + pages (mirror the approved design)
- [x] 8.1 `app/admin/shell.tsx`: `AdminTab` + `TABS` extended with `reviews` («Отзывы») and `feedback` («Обратная связь»).
- [x] 8.2 `app/admin/reviews/page.tsx`: quest + rating filters, «показать скрытые» toggle, per-`(player,quest)` cards (badge, contact, stars, text / star-only note), hide with a before→after average confirm (`AdminConfirmSheet`, same-grain client fold), unhide, toast, empty state.
- [x] 8.3 `app/admin/feedback/page.tsx`: quest + status filters, step-grouped expandable cards (count, step title+template, version, status chip, reports w/ identity+contact), resolve/reopen, «Архив прошлых версий» collapsible, empty state.
- [x] 8.4 `app/styles/admin-moderation.css` (registered in `app/layout.tsx`) — `amod-*` classes on the shared `ap-*` chrome, design tokens matched.

## 9. Frontend — page tests
- [x] 9.1 `reviews-page.test.tsx`: renders star-only + contacts; hide confirms with a 3.7→4.5 preview, calls `adminHideReview`, drops the row; reveal + unhide; admin-gate denies (mock `ApiError(403)`); count line.
- [x] 9.2 `feedback-page.test.tsx`: renders current group + reports + contacts (mailto/t.me); resolve calls `adminResolveFeedback` and removes it from «Открытые»; «Все» reveals the archive.

## 10. Verify + gates + self-critique
- [x] 10.1 `cargo fmt --check` + `cargo clippy -- -D warnings` clean; `cargo test` 206 pass. The 3 `pg_*` suites are the pre-existing env failure (no DB runnable here — no Postgres binary / Docker daemon / rootless runtime; the repo already documents this) and self-skip when `DATABASE_URL` is unset; the Pg mirror is 1:1 with the tested in-memory spec.
- [x] 10.2 `npm run test` 481 pass, `tsc --noEmit` clean, `eslint` clean, `next build` clean (both `/admin/reviews` + `/admin/feedback` routes built).
- [~] 10.3 Behavior proven by the backend route tests (real Axum router: hide→average shift on the product page, resolve→reopen via the count watermark, contacts per kind) + the frontend page tests + the successful build. The live browser drive is blocked by the same proven env limit (no runnable Postgres; the checked-in `.env` forces a `DATABASE_URL`, so the server can't fall back to in-memory here) — defer to a live-DB env.
- [x] 10.4 Adversarial self-critique (backend + frontend): folds (empty/star-only/replay/hidden/multi-quest), the count watermark (same-second safety, report-count decrease on account deletion), N+1s (batched identity + list_published), admin gating, and PII (public page still first-name-only). No real bugs; documented tradeoffs are the same-second tie-break parity on a pathological case and minor clone/scan cost at small scale. Facts are never mutated by any moderation path (asserted).
