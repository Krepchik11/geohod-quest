# Commerce, Access Grants, and Coupons (Business Concept v0.1)

## Business Rules (Clarified)

- **Buy once, own forever**: A successful purchase (or 100% coupon / free grant) for a specific player + specific quest creates a permanent AccessGrant.
- Coupons provide **percentage discounts** at purchase time (different percentages supported). A 100% coupon effectively makes the quest free for that redemption.
- Free quests exist and behave like any other quest for the player (added to collection, downloadable, playable with full progress tracking). They simply do not require a real-money transaction.
- Coupons are part of the buying model and must be supported in the quest constructor / admin surface (creation, assignment, tracking usage).

## Core Flows

### Purchase Flow (Happy Path)
1. Player views quest in catalog (price shown).
2. Player initiates purchase (optionally enters coupon code).
3. System validates coupon (if any): applies discount, checks limits/validity/ownership.
4. Player completes payment via YooKassa (or equivalent).
5. On successful payment confirmation (webhook or client confirmation + reconciliation):
   - Create idempotent AccessGrant (player + quest).
   - Record the Payment with external reference.
   - If coupon used: record redemption (decrement usage counters).
6. Player can immediately download the quest for offline play or start an attempt.

### Free Quest / Auto-Grant
- A quest marked as free (price = 0 or explicit `is_free` flag) allows any authenticated player to obtain an AccessGrant without payment (e.g., "Add to collection" or on first view/play attempt).
- Same grant semantics as paid.

### Coupon Application
- Coupons can be:
  - Quest-specific or platform-wide.
  - Limited total uses or per-user (typically once per user).
  - Time-bounded.
- Discount is calculated at purchase time; the final charged amount is what the payment provider sees.
- Redemption is recorded and tied to the resulting grant.

### Replay / Additional Attempts
- AccessGrant is **not consumed**. A player with a grant can create as many QuestAttempts as they like (replay allowed).
- No additional charge for replays or resets.

## Entities (recap with commerce focus)

- **Quest**: has `base_price` (number, nullable/0).
- **Coupon**: code, discount_percent (integer 1-100), scope (quests list or null), max_uses, uses_count, per_user_limit (default 1), valid_from, valid_to, active.
- **AccessGrant**: player_id, quest_id, granted_at, source (enum: purchase, coupon, free, admin), source_reference (payment_id or coupon_redemption_id or null).
- **CouponRedemption**: coupon_id, player_id, quest_id (if scoped), used_at, resulting_grant_id.
- **Payment**: external_id (YooKassa), player_id, quest_id, original_amount, discount_amount, final_amount, currency, status, provider_payload (for audit), created_at, confirmed_at.

## Invariants

- An AccessGrant is created at most once per (player, quest) pair for the "paid or granted" lifetime (idempotency on webhook retries, double-clicks, etc.).
- Coupon usage counters are only incremented on successful grant creation.
- A player cannot have a negative or fractional discount that results in negative charge.
- Free quests (price 0 or is_free) must not require a Payment record to produce a grant.
- Grants survive quest price changes and content updates.

## Edge Cases & Risks (to be designed for)

- Coupon used after payment started but before confirmation.
- Partial refunds or chargebacks — does the grant get revoked? (Current assumption: no, for v1 simplicity; log it.)
- Same coupon code redeemed by two players at the exact same moment (race on usage counter).
- Admin-created manual grants (bypassing payment).
- Quest is unpublished or price changed between add-to-cart and payment confirmation.
- Player buys via coupon 100%, then the same quest is later made free for everyone — no problem (grant already exists).

## What the Old System Did (for reference only — we are not copying)

Old `buy_a_qest` (Subscription) + `payment` + `coupon` + `basket_buy` + `no_buy`. It mixed subscription-like records with one-time purchases. We are simplifying to pure lifetime AccessGrant per quest.

## Open Questions for Next Round (some resolved)

- (Resolved) Single quest purchase flow only for v1. No cart.
- Are there "gift" purchases (buy for another player) in v1 or later?
- (Resolved) Coins earned only through play (completions + gifts in steps). No real-money purchase path, no admin manual adjustments in v1.
- Exact YooKassa integration points and what must be re-implemented exactly (webhook `payment.succeeded` handling, amount reconciliation, description containing quest name, etc.).
- Admin UI for coupon creation and usage reports — is this part of MVP or later?
- Historical data import scope: grants + basic attempt metadata is high value; full per-step history from old answer_cards would be great but may require reconstruction.
