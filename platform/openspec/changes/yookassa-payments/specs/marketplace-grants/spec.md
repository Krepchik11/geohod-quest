# marketplace-grants

## MODIFIED Requirements

### Requirement: Checkout routes through the PaymentProvider seam with per-request provider selection
Single-quest checkout (no cart) SHALL accept optional coupon (numeric % 0-100 or code stub), player/quest, and an optional `provider` (`"mock"` default, `"yookassa"`). Free quests (price=0) and coupon-100% SHALL bypass every provider exactly as before. The mock provider SHALL stay synchronous always-approve, returning a `payment_ref` recorded as the grant's `source_ref`. `provider=yookassa` on a deployment without YooKassa credentials SHALL fail closed with 501. Checkout SHALL resolve the player via the identity rules; an already-owned quest SHALL return the stored grant idempotently without charging any provider or consuming a coupon.

#### Scenario: Mock payment approval is audited on the grant
- **WHEN** checkout runs without a provider field (or `provider=mock`) for a priced quest
- **THEN** the mock approves synchronously, and the created grant carries its payment_ref as source_ref; a repeat checkout returns the existing grant unchanged.

#### Scenario: YooKassa selected but not configured
- **WHEN** checkout names `provider=yookassa` and the deployment has no `YOOKASSA_SHOP_ID`/`YOOKASSA_SECRET_KEY`
- **THEN** the server responds 501, no pending payment is recorded, and no grant is created.

## ADDED Requirements

### Requirement: YooKassa checkout defers the grant to a verified settlement
`provider=yookassa` SHALL create a YooKassa payment (`capture: true`, redirect confirmation whose `return_url` points at the quest page carrying our payment id) and respond with `{payment: {payment_id, confirmation_url}}` and NO grant; play access (attempt creation) SHALL remain 403 while the payment is pending. The in-flight payment SHALL be persisted (our id, YooKassa's id, player, quest, optional coupon code, charged amount, status). While a pending payment exists for (player, quest), a repeat checkout SHALL return the SAME `confirmation_url` without creating a second YooKassa payment. Settlement SHALL be reachable from both a webhook (`POST /api/payments/yookassa/webhook`, answering 200 for verified, unknown, and forged notifications, and 5xx only on transient internal failure so YooKassa retries) and an owner poll (`GET /api/payments/{id}`), SHALL verify the payment status by re-fetching it from the YooKassa API (the notification body is never trusted), and SHALL be once-effective: a compare-and-set `pending → succeeded` elects one winner to create the grant (`source=Payment`, `source_ref` = YooKassa payment id). A `canceled` payment SHALL mark the row canceled, grant nothing, and let a fresh checkout start a new payment.

#### Scenario: Successful payment settles once from either path
- **WHEN** a pending YooKassa checkout's payment reaches `succeeded` and both the webhook and the owner poll observe it
- **THEN** exactly one settlement creates the grant with the YooKassa payment id as source_ref; the other path sees the settled row; the poll returns `{status: "succeeded", grant}` and the player can create attempts.

#### Scenario: Canceled payment grants nothing and frees the retry
- **WHEN** the payer abandons or the bank declines and YooKassa reports `canceled`
- **THEN** the row is marked canceled, no grant exists, attempt creation stays 403, and a new checkout creates a fresh YooKassa payment.

#### Scenario: Forged webhook is harmless
- **WHEN** an attacker posts a fabricated `payment.succeeded` notification for a pending payment
- **THEN** the server re-fetches the payment from YooKassa, sees it is not succeeded, changes nothing, and still answers 200.

### Requirement: Coupons on redirect payments are redeemed only at settlement
A partial-discount coupon on a YooKassa checkout SHALL price the charged amount at initiation but record the redemption ONLY when the payment succeeds (the settlement winner redeems). A canceled payment SHALL leave the coupon's caps untouched. If the redemption fails at settlement (caps exhausted meanwhile), the grant SHALL still be created — the money is taken — and the failure logged. Coupon-100% SHALL keep granting immediately as CouponRedemption with no provider involved.

#### Scenario: Abandoned payment does not burn the code
- **WHEN** a player applies a limited coupon, starts a YooKassa checkout, and the payment is canceled
- **THEN** the coupon's usage counters are unchanged and the code remains redeemable.

### Requirement: Available payment providers are advertised to the storefront
`GET /api/payments/providers` SHALL list the providers this deployment can charge through (`mock` always; `yookassa` when configured), so the purchase sheet can offer a payment-method choice; with a single provider the sheet SHALL not render a selector.

#### Scenario: Selector data reflects deployment config
- **WHEN** the storefront asks for providers on a deployment with YooKassa credentials
- **THEN** the response lists mock and yookassa, and the purchase sheet renders the method choice defaulting to YooKassa.
