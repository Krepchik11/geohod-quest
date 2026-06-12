# marketplace-grants (delta)

## MODIFIED Requirements

### Requirement: Checkout + coupon % (incl 100%) creates grant; free identical
Single-quest checkout (no cart) SHALL accept optional coupon (numeric % 0-100 or code stub) and player/quest, compute effective (100% treated as free-equivalent), and create idempotent grant with appropriate source. Free quests (price=0 or explicit flag) SHALL use identical grant creation + post-grant attempt/snapshot/facts mechanics (source=FreeQuest; no special paths). The Payment path SHALL route through a `PaymentProvider` interface; the MVP provider is a mock that always approves and returns a `payment_ref`, which SHALL be recorded as the grant's `source_ref` for audit. Coupon-100% and free paths SHALL bypass the provider (nothing to charge). Checkout SHALL resolve the player via the identity rules (registered ids require a valid session token; anonymous ids are accepted tokenless).

#### Scenario: Coupon 100% creates grant with CouponRedemption source, identical to free
- **WHEN** marketplace checkout for published quest, user enters coupon 100 (or clicks "get free" on free quest), "purchase" succeeds (stub)
- **THEN** grant created with source=CouponRedemption (or FreeQuest); player can immediately download/play the snapshot (same as paid); post-grant facts/attempts (gifts +5 "МИХАЙЛО ПУПИН" etc) identical in shape/projection to paid grant path; no price charged (YAGNI stub); no payment_ref recorded (provider bypassed).

#### Scenario: Paid "buy once" + coupon <100 both succeed to grant
- **WHEN** checkout with no coupon (Payment source) or coupon=20 for quest
- **THEN** grant created (source=Payment or CouponRedemption for partial-coupon Payment path per existing policy); eligibility true; attempt facts flow using same snapshot as listed.

#### Scenario: Mock payment approval is audited on the grant
- **WHEN** checkout runs the Payment path (no coupon or coupon < 100) through the mock provider
- **THEN** the provider approves, returns a payment_ref, and the created grant carries that payment_ref as source_ref; a repeat checkout returns the existing grant unchanged (idempotent, original source_ref preserved).

### Requirement: Marketplace peer surface lists published quests with comic + template summary; publish surfaces; grants/purchases through surface
Marketplace SHALL list ALL currently published quests live from the backend (`GET /api/quests`); each entry SHALL include primary comic (derive from snapshot media.task or first non-null role or stub) + 4-template summary (e.g. counts or ordered list of templates from snapshot.steps). Publish (from ctor explicit Publish after gates) SHALL surface the snapshot (register id + name + comic + summary in backend). All "buy once"/"get free"/coupon flows SHALL go through the marketplace surface (not direct API or other entry) using the current identity (no hardcoded player ids); each listed quest SHALL have its own buy action (mocked payment — a click grants access); owned status (has grant for the current player) SHALL be visible in list (e.g. "Owned - play" vs "Buy once") and flip immediately after purchase.

#### Scenario: Ctor publish surfaces new snapshot to marketplace list
- **WHEN** ctor completes gates + clicks Publish on edited quest (or mystery golden), serialize + surface call
- **THEN** marketplace list (re-fetch) includes the quest with primary comic (from its media) + template summary (from its steps); old attempts unaffected; the new quest is buyable with its own buy button.

#### Scenario: Buy/get-free through marketplace creates grant and updates owned
- **WHEN** user in marketplace list clicks "Buy once" (or "Get free", or enters 100% coupon) on a published entry
- **THEN** grant created idemp for the CURRENT player identity (anonymous device id or logged-in account), list updates to show "Owned", play link enabled to /quest?golden=... with eligibility.

#### Scenario: Multiple published quests are each independently buyable
- **WHEN** two or more quests are published and the marketplace renders
- **THEN** every published quest appears with its own buy/owned state computed for the current player; buying one does not affect the owned state of the others.
