## Why

Two quality signals reach us from players — **quest ratings** (5-star finale rating +
optional text, `Fact::QuestRated`) and **error reports** (mid-quest «Сообщить об
ошибке», `Fact::FeedbackReported`) — but there is no admin surface to act on either
globally, and no way to moderate a bad-faith or spam review. Today:

- The only feedback surface is `GET /api/admin/versions/{snapshot_id}/feedbacks`, a
  flat `Vec<Fact>` for **one** snapshot, with **no reporter identity** (only
  `device_id`), **no status**, and no grouping by step.
- There is **no** review-moderation path at all: a `quest_rated` fact, once appended,
  is permanent and cannot be hidden; a spam/abusive review stays on the quest page and
  in its average forever.
- `rating_avg` is computed **per attempt** and only for the **current published
  version**. A player who replays double-counts; publishing a new version resets the
  average to zero-history while old text reviews stay visible — the product page can
  show a 5★ review next to «no ratings yet». This is a latent correctness defect.
- The verified Telegram `@username` (`TelegramClaims.preferred_username`) is read from
  the OIDC token and **discarded**; `auth_identities` has no username column. So even
  once we resolve a reporter to their account, a Telegram-only user has no reachable
  contact.

Facts are immutable and append-only (the core invariant); moderation therefore MUST be
a separate mutable overlay, never a mutation of facts.

## What Changes

- **Moderation overlay store (root cause).** A new `ModerationStores` store family
  (InMemory + Pg + enum, mirroring every existing family) backed by migration `0016`
  with two tables, entirely separate from `facts`:
  - `hidden_reviews(player_id, quest_id, hidden_at, hidden_by)` — presence = hidden;
    keyed to **player + quest** (spans versions). Unhide deletes the row.
  - `resolved_feedback(quest_id, snapshot_id, step_position, acknowledged, resolved_by)`
    — a **count watermark**. Resolve upserts `acknowledged = current report count`;
    reopen deletes.
- **Read-side folds (pure, facts + overlay, no fact mutation).**
  - **Rating fold reworked to one honest grain:** *one effective rating per
    (player_id, quest_id)* = that player's latest attempt rating, across **all
    versions**, with hidden pairs dropped. This powers the product page, the catalog,
    and the admin list — so all three agree, and the double-count + version-reset
    defects are removed at the source. Star-only ratings count toward the average but
    are not text reviews.
  - **Feedback status is a count-watermark fold:** a group (quest, snapshot, step) is
    *resolved* iff `acknowledged` is set AND the group's current report count is `≤`
    `acknowledged`; otherwise *open*. Because reports are append-only, a new report
    grows the count past `acknowledged` and reopens the group automatically — no
    write-side coupling to the append path, and immune to timestamp granularity.
- **Global admin endpoints (admins-only, full identity).** All guarded by
  `require_admin_actor` (session `role == admin` OR `X-Admin-Token`):
  - `GET /api/admin/reviews`, `POST /api/admin/reviews/hide`, `.../unhide`.
  - `GET /api/admin/feedback`, `POST /api/admin/feedback/resolve`, `.../reopen`.
  Each rating/report is enriched with the resolved author identity — display name,
  provider kind, and a reachable contact (email → `mailto:`, Telegram → `t.me/<user>`,
  anonymous → none).
- **Telegram @username capture.** Migration `0016` adds `auth_identities.username`;
  `telegram_auth_handler` persists `preferred_username`; identity readers expose it.
- **Frontend.** Two new admin tabs — `app/admin/reviews` (Отзывы) and
  `app/admin/feedback` (Обратная связь) — appended to the existing admin nav, built on
  the shared `AdminShell`/`AdminGate`/`SpaceHeader` chrome and the `lib/api.ts` client,
  mirroring the approved design (quest + rating/status filters, per-player review cards
  with hide/unhide + an average before→after confirm, step-grouped feedback with
  open/resolved + a past-versions archive).

**BEHAVIOR CHANGE:** public `rating_avg` / `rating_count` (product page + catalog)
switch from per-attempt/current-version to per-player/all-versions and become
hide-aware. Existing quests' displayed averages may shift; the change is deliberate
and specced below.

## Capabilities

### Added Capabilities

- `content-moderation`: the mutable moderation overlay, the hide-aware per-player
  all-versions rating fold, the global reviews-moderation and feedback-inbox admin
  surfaces (backend endpoints + the two frontend tabs), and their admin-only gating.

### Modified Capabilities

- `player-identity`: the Telegram identity SHALL persist the verified `@username`
  (`preferred_username`) so an account's Telegram handle is a queryable contact.

## Impact

- **Backend:** `migrations/0016_moderation_and_telegram_username.sql` (new),
  `src/store.rs` + `src/pg_store.rs` (new `ModerationStores` family; `auth_identities`
  username; per-player/all-versions/hide-aware rating + review reads), `src/facts.rs`
  (quest-level rating fold + feedback grouping/watermark projectors), `src/main.rs`
  (six routes + handlers, admin identity resolution, `AppState` field, wiring), a small
  admin identity/contact helper.
- **Frontend:** `lib/api.ts` (wire types + six client methods), `app/admin/shell.tsx`
  (two tabs), `app/admin/reviews/page.tsx` + `app/admin/feedback/page.tsx` (new) with
  their styles, `app/admin/__tests__/` (two page tests), `lib/__tests__/` (client +
  fold-preview tests).
- **Tests (TDD, RED first):** Rust unit tests for the rating fold + feedback watermark
  + identity resolution; store parity (InMemory ≡ Pg) for the overlay; route tests for
  all six endpoints incl. admin gating and the reopen-on-new-report rule; updated
  `scenario_product_page` for the new averaging; vitest for the two tabs + client.
  `cargo test`/`clippy`/`fmt`, `npm run test`/`lint`/`build` all green.
- **Non-goals (YAGNI):** no per-review reply/threading, no author-side moderation, no
  soft-delete of facts, no rating-spend/boost (cut from v1), no email sending, no
  bulk-moderation UI, no changes to the append/idempotency/offline paths.
