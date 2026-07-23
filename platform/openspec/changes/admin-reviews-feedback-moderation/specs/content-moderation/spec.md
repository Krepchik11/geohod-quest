# content-moderation

## ADDED Requirements

### Requirement: Moderation state is a mutable overlay separate from the immutable fact log

The system SHALL keep all moderation decisions in a dedicated mutable store family
(`ModerationStores` — InMemory + Postgres behind one enum, mirroring every other store
family) that is **never** mixed into the append-only `facts` log. Facts SHALL remain
immutable and untouched by any moderation action (no fact is edited, deleted, or
re-appended to hide a review or resolve a report). The overlay SHALL hold exactly two
kinds of record:

- a **review hide**, keyed by `(player_id, quest_id)` — its presence means hidden;
- a **feedback resolution watermark**, keyed by `(quest_id, snapshot_id, step_position)`
  — an `acknowledged` report count (how many reports the admin marked resolved).

Both InMemory and Postgres backends SHALL implement identical behavior; the Postgres
table(s) SHALL have row-level security enabled like every other table. Moderation reads
(hidden set, resolution watermarks) SHALL be pure inputs to the read-side folds below.

#### Scenario: Hiding a review appends no fact and deletes no fact

- **WHEN** an admin hides a review for `(player_id, quest_id)` and later unhides it
- **THEN** the player's `quest_rated` fact(s) are byte-for-byte unchanged before, during,
  and after; only an overlay row is inserted then removed; re-reading the raw fact log
  yields the same facts throughout.

#### Scenario: InMemory and Postgres overlay behave identically

- **WHEN** the same sequence of hide/unhide and resolve/reopen operations is applied to
  the InMemory backend and to the Postgres backend
- **THEN** the resulting hidden set and resolution watermarks are equal, and the derived
  review/feedback projections computed from each are equal.

### Requirement: Rating aggregation is per-player, all-versions, and hide-aware

The public rating average and count for a quest (product page `GET /api/quests/{id}` and
the catalog list) SHALL be computed as a pure fold with exactly one **effective rating
per `(player_id, quest_id)`**: for each player who rated the quest, the effective rating
is that player's **latest** attempt rating (by attempt creation, then fact order),
regardless of which snapshot/version the attempt was bound to. The average SHALL be the
mean of the effective ratings whose `(player_id, quest_id)` is **not** in the hidden set;
`rating_count` SHALL be the number of such non-hidden effective ratings. A star-only
rating (empty text) SHALL count toward the average and count but SHALL NOT appear in the
text-review list. When no non-hidden effective ratings exist, the average SHALL be 0 and
the count 0.

The text-review list on the product page SHALL likewise contain at most one entry per
`(player_id, quest_id)` — the player's latest rating that carries non-empty text —
excluding hidden pairs, newest first.

#### Scenario: A replaying player counts once, at their latest rating

- **WHEN** a player rates a quest 3★ on a v1 attempt, then replays on v2 and rates 5★,
  and a different player rates 1★
- **THEN** the quest average is (5 + 1) / 2 = 3.0 with count 2 (the 3★ is superseded, not
  added), and the player appears once in the review list with their 5★ rating.

#### Scenario: Hiding a review drops it from the quest page and the average

- **WHEN** a quest has effective ratings 5★ and 1★ (average 3.0, count 2) and an admin
  hides the `(player_id, quest_id)` of the 1★
- **THEN** the product page average becomes 5.0 with count 1, the 1★ author no longer
  appears in the review list, and unhiding restores 3.0 / count 2 exactly.

#### Scenario: A ratings from an old version still count after a new publish

- **WHEN** a player rated a quest on v1, the quest publishes v2, and no one has rated v2
- **THEN** the product page still shows the v1 rating in the average and the review list
  (all-versions), rather than resetting to «no ratings yet».

### Requirement: A global reviews-moderation surface lists every rating with author identity and hide controls

The system SHALL expose an admin-only `GET /api/admin/reviews` returning **every** rating
across all quests as one row per `(player_id, quest_id)` — including **star-only** ratings
— each carrying: the quest (id + display label), the effective stars, the optional text,
a human «when», the resolved author identity, and whether the pair is currently hidden.
The author identity SHALL include the player id, a display name, a provider **kind**
(`google` | `telegram` | `email` | `anon`), and a reachable **contact**: an email
(`mailto:`) for an email/Google account, a Telegram `@username` (`t.me/<username>`) for a
Telegram account that has a captured username, and none for an anonymous player or a
Telegram account with no username. The endpoint SHALL return hidden rows too (flagged),
so the surface can show and unhide them.

`POST /api/admin/reviews/hide` (`{player_id, quest_id}`) SHALL insert the hide (idempotent)
and `POST /api/admin/reviews/unhide` (`{player_id, quest_id}`) SHALL remove it. Both SHALL
be admin-only and SHALL take effect immediately on the folds above.

#### Scenario: The list includes star-only ratings and resolves contacts by kind

- **WHEN** an admin requests `GET /api/admin/reviews` for data containing a Google review,
  a Telegram review whose account captured `@milan_bg`, a Telegram review with no username,
  and an anonymous star-only rating
- **THEN** each row reports the correct kind and contact (`mailto:` for Google, `t.me/milan_bg`
  for the Telegram user, «no @username» for the handleless Telegram user, none for the
  anonymous one), and the star-only anonymous rating is present with `hasText = false`.

#### Scenario: Hide then unhide via the endpoints round-trips

- **WHEN** an admin POSTs `/api/admin/reviews/hide` for a pair and then `/unhide`
- **THEN** the row is flagged hidden after the first call and un-flagged after the second,
  the quest average reflects the exclusion then the restoration, and both calls are
  idempotent (repeating either is a no-op).

### Requirement: A global feedback inbox groups reports by quest, version, and step with full reporter identity

The system SHALL expose an admin-only `GET /api/admin/feedback` returning every
`feedback_reported` fact across all quests, grouped by `(quest_id, snapshot_id,
step_position)`. Each group SHALL carry: the quest (id + label + human version number),
the step label and template resolved from that **frozen snapshot's** `steps[step_position]`,
whether the snapshot is the quest's **currently published** version (else it is archive),
the group's resolution status (see the watermark requirement), and the list of reports
newest-first. Each report SHALL carry its note, a human «when», and the resolved author
identity + contact (same shape and rules as the reviews surface — email `mailto:`,
Telegram `t.me/<username>`, or none). Grouping SHALL use the frozen snapshot identity, so
the same `step_position` under different versions forms distinct groups.

#### Scenario: Reports on the same step of the same version form one identified group

- **WHEN** three players (a Google user, a Telegram user with a username, an anonymous
  user) each report an error on step 4 of the current snapshot of a quest
- **THEN** `GET /api/admin/feedback` returns one group for `(quest, snapshot, step 4)` with
  three reports newest-first, each showing the reporter's identity and contact, the step's
  frozen title/template, the human version number, and `current = true`.

#### Scenario: Reports on a superseded version appear as an archive group

- **WHEN** a quest has feedback on step 4 of v1 (superseded) and on step 4 of v2 (current)
- **THEN** the inbox returns two separate groups — the v2 group flagged current and the v1
  group flagged archive — never merged despite the identical `step_position`.

### Requirement: Feedback resolution is a count watermark; a new report reopens a resolved group

A feedback group SHALL be **resolved** iff its `(quest_id, snapshot_id, step_position)`
has an `acknowledged` watermark AND the group's CURRENT report count is less than or equal
to `acknowledged`; otherwise it SHALL be **open**. `POST /api/admin/feedback/resolve`
(`{quest_id, snapshot_id, step_position}`) SHALL set `acknowledged` to the group's current
report count (closing the whole group). `POST /api/admin/feedback/reopen` with the same key
SHALL clear the watermark (reopening the group). Because reports are append-only (the count
only grows), a newly appended report SHALL push the current count past `acknowledged` and
make the group open again — with no write to the overlay, no coupling to the append path,
and no dependence on timestamp granularity (a report arriving the same second as a resolve
still reopens the group, which a time-based watermark could not guarantee). Both actions
SHALL be admin-only.

#### Scenario: Resolve closes the group; a later report reopens it automatically

- **WHEN** an admin resolves a group that currently has two reports, and later a third
  report for the same `(quest, snapshot, step)` is appended
- **THEN** the group reads resolved immediately after the resolve, and reads open again
  after the third report arrives — without any further admin action or overlay write.

#### Scenario: Manual reopen with no new report

- **WHEN** an admin resolves a group and then reopens it while no new report has arrived
- **THEN** the watermark is cleared and the group reads open; a subsequent resolve closes
  it again.

### Requirement: All moderation reads and writes are admins-only

Every moderation endpoint (`GET /api/admin/reviews`, `/api/admin/reviews/hide`,
`/unhide`, `GET /api/admin/feedback`, `/api/admin/feedback/resolve`, `/reopen`) SHALL be
gated by `require_admin_actor` — accepted only for a Bearer session whose account
`role == "admin"` or a valid shared `X-Admin-Token` — and SHALL fail closed with 403 (or
401 when unauthenticated) otherwise, performing no read or mutation.

#### Scenario: Non-admin is refused with no effect

- **WHEN** a request without admin credentials calls any moderation endpoint (a GET list
  or a hide/resolve mutation)
- **THEN** the server responds 401/403, returns no moderation data, and applies no overlay
  change.

### Requirement: The admin UI presents Отзывы and Обратная связь as two moderation tabs

The frontend SHALL add two admin tabs — «Отзывы» (`/admin/reviews`) and «Обратная связь»
(`/admin/feedback`) — appended to the existing admin navigation and built on the shared
`AdminShell` / `AdminGate` / `SpaceHeader` chrome and the `lib/api.ts` client, mirroring
the approved design. Отзывы SHALL offer a quest filter, a rating filter, a «show hidden»
toggle, per-`(player,quest)` review cards (identity badge, contact link, stars, text or a
«star-only» note), and a hide action whose confirmation previews the quest average
before→after; hidden cards SHALL be visually marked with an unhide action. Обратная связь
SHALL offer a quest filter and an open/resolved/all status filter, step-grouped expandable
cards showing reports with identity + contact, a resolve/reopen action per group, and a
collapsible «Архив прошлых версий» for superseded-version groups. Both tabs SHALL be
reachable only when admin access is granted (the shared gate), the backend re-authorizing
every call.

#### Scenario: The Отзывы tab hides a review and reflects the new average

- **WHEN** an admin opens «Отзывы», hides a review, and confirms
- **THEN** the client calls `POST /api/admin/reviews/hide`, the card becomes marked hidden
  with an unhide control, and the previewed after-average matches the value the product
  page would show (same per-player/hide-aware fold on both sides).

#### Scenario: The Обратная связь tab resolves a group and filters by status

- **WHEN** an admin opens «Обратная связь», marks an open group resolved, then switches the
  status filter to «Открытые»
- **THEN** the client calls `POST /api/admin/feedback/resolve`, the group shows the resolved
  state, and it disappears from the open-only view (reappearing under «Решённые» / «Все»).
