# v1 Requirements, Priorities, and Explicit Cut List (Business Concept v0.1)

## Must Have for v1 (Non-Negotiable)

**Core Player Experience**
- Discover and view quest details (catalog + detail).
- Purchase flow (with coupon support) or free add-to-collection.
- Receive lifetime AccessGrant.
- Download quest bundle for offline play (PWA).
- Play through a linear sequence of steps while offline:
  - Physical confirmation steps.
  - Answer submission steps (with local feedback via protected answers + server re-validation on sync).
  - Hint purchase with in-game coins (reveal geo on map).
- Create multiple attempts; reset or continue any of them.
- Sync progress when online (idempotent, eventually consistent).
- Post-completion review (simple grade + optional text).
- View personal collection, in-progress attempts, completed quests.

**Core Admin / Constructor (Internal)**
- Auth as Administrator (email + password in MVP).
- Create/edit/publish quests.
- Build and reorder sequence of GameSteps with the required content fields, task kinds (physical vs answer-required), list of acceptable answer strings, media (including short 10-30s videos), geo (display only), coin-gated hints, gifts that award coins.
- Preview: Save, then switch to the real player experience logged in as a test user (acceptable for MVP).
- Basic visibility: list of grants/purchases, attempts (with version info) per quest, reviews.
- Create and manage coupons (percentage discounts).
- View and manage free quests.
- (Import of historical grants + attempt data is desirable for data migration.)

**Commerce & Backend**
- YooKassa (or equivalent) payment + webhook processing that reliably creates AccessGrants (idempotent).
- Coupon application and redemption recording.
- Free quest grant path.
- In-game coin balance and spend recording (per attempt + master balance reconciliation).

**Cross-Cutting Hard Requirements**
- Full PWA + offline support as described.
- Russian language only.
- No events domain.
- Simple roles (Admin vs Player).
- Clean auth surface (no legacy magic links or mandatory old Telegram flow).
- No GDPR/data retention obligations to implement.

## Should Have (Strongly Desired if Time Allows)

- Reasonable error handling and recovery on sync conflicts or quest version drift.
- Admin stats and simple charts (most popular quests, completion rates, revenue).
- Basic search/filter in player catalog (by level, city, tags, price).
- Media caching strategy that doesn't blow up storage (at least images; decide on video).
- Clear "you are offline / sync pending" UI in the player.
- Admin ability to unpublish a quest (hides from new buyers but existing grants still work).

## Could Have / Future (After v1 Stable)

- Events/calendar as a separate product (if it ever revives).
- External authors or revenue share.
- English or Serbian.
- Richer branching in quests.
- Real-money coin purchases.
- Team play or shared attempts.
- Advanced anti-cheat or photo proof for physical steps.
- Full quest version history and content rollback.
- Public API or embeds.
- Advanced analytics, A/B testing of steps, heatmaps of wrong answers.

## Explicit Cut List (Things We Are Not Building in v1)

- Any part of the event, calendar, booking, work time, program, FAQ, meeting point domain.
- 40+ supporting data types that existed only for the dead parts or UI state.
- Multi-language infrastructure and all *_ENG / *_SRB fields.
- "Author" role and associated permissions/workflows.
- Magic link generation and consumption for auth.
- Password reset flows (for existing users).
- The 1,163 imperative workflows and 444 SetCustomState patterns.
- In-app complex reusable element editors with dozens of workflows each.
- Database triggers for event capacity.
- Unknown plugins (the 41+ and 31+ action plugins).
- "666" / copy-paste backend workflows.
- Persistent geo tracking on the user record.
- Basket / multi-item checkout (assumption: one quest at a time for v1).
- Subscription recurring billing (old `buy_a_qest` semantics).
- Any client-side only "correct" that is never re-validated by server.
- Full branching graph instead of sequence (unless proven mandatory by content examples).

## Success Criteria for v1 (How We Know We Are Done)

- An internal admin can create a complete quest with a mix of physical and answer steps, publish it, and preview it end-to-end.
- A player can register/login, see the quest, buy it (with and without coupon) or add a free one, download, play the full sequence offline (including submitting answers and buying a hint), have progress recorded, sync on reconnect, and see it in their completed list.
- A second attempt can be started, reset, and played.
- Payment webhook creates the grant reliably (tested with retries).
- No dependency on any event-related tables or pages.
- The domain model and code are dramatically simpler and more maintainable than the 47-type / 1163-workflow original.

## Risks If These Are Not Met

- Offline + server validation tension not resolved → either cheating or broken offline experience.
- Constructor too weak → admins cannot efficiently produce content; velocity collapses.
- Auth migration or new signup friction high → lose the existing user base.
- Sync logic has races → lost progress or coin overspend for real players.
- Media or quest size makes offline impractical on real devices.

This list, together with the domain model and the offline doc, forms the contract for what "the rebuild" means.
