# YooKassa payments

## Why

The marketplace charges real money for quests, but the only `PaymentProvider` is
the always-approving mock — every «Купить» grants access without taking a ruble.
The seam was designed for exactly this swap (`payments.rs` doc: *"a real provider
(e.g. YooKassa redirect + webhook) will implement"*). YooKassa is the natural
provider for the audience (Russian cards, SBP, no cross-border friction).

The mock must stay: it is the local-dev / staging path and the owner wants to
pick the provider per checkout while YooKassa is being trialled.

## What

- **Provider selection at checkout.** `POST /api/checkout` gains an optional
  `provider` field: `"mock"` (default, unchanged behavior) or `"yookassa"`.
  `GET /api/payments/providers` advertises which providers this deployment has,
  so the purchase sheet can render a payment-method choice.
- **YooKassa redirect flow.** `provider=yookassa` creates a payment via
  `POST https://api.yookassa.ru/v3/payments` (Basic auth `shopId:secretKey`,
  `Idempotence-Key`, `capture: true`, `confirmation: {type: redirect,
  return_url}`) and answers `{payment_id, confirmation_url}` instead of a grant.
  The client redirects the payer to YooKassa and returns to the quest page.
- **Pending payments.** New `pending_payments` table + tri-layer store
  (InMemory/Pg/enum) tracks the in-flight payment: our id (doubles as the
  idempotence key), YooKassa's payment id, player, quest, optional coupon code,
  charged amount, status `pending|succeeded|canceled`.
- **Settlement, twice-reachable, once-effective.** A webhook
  (`POST /api/payments/yookassa/webhook`) and a lazy owner poll
  (`GET /api/payments/{id}`) share one settle function: verify the payment's
  real status against the YooKassa API (never trust the notification body),
  CAS `pending → succeeded`, and only the transition winner creates the grant
  (`source=Payment`, `source_ref` = YooKassa payment id) and redeems the stored
  coupon. `canceled` marks the row and grants nothing; a fresh checkout starts a
  new payment. The poll path means local dev settles without a public webhook.
- **Coupons pay out at settlement.** A partial discount prices the YooKassa
  amount at initiation, but the redemption is recorded only when the payment
  succeeds — a canceled payment must not burn the code. Coupon-100% and free
  quests keep bypassing providers entirely.
- **Frontend.** Purchase sheet: payment-method selector (card via ЮKassa /
  test payment) when both providers exist, redirect state, and — on return via
  `?payment={id}` — polling with the SPEC-mandated success and
  «деньги не списаны» failure states on the quest page.
- **Config/deploy.** `YOOKASSA_SHOP_ID` + `YOOKASSA_SECRET_KEY` (all-or-nothing,
  loud warn on a partial set, 501 fail-closed when absent), secret key delivered
  as a podman secret in the Quadlet unit; webhook URL documented for the
  YooKassa dashboard.

## Non-goals

- Refunds, receipts (54-ФЗ fiscalization), saved payment methods, recurring
  charges — none are in the product spec yet.
- `waiting_for_capture` flows: payments are created `capture: true` (one-stage).
- Multi-currency: prices are whole rubles (`published_quests.price BIGINT`).

## Rationale

- **Verify-by-refetch beats IP allowlists.** YooKassa authenticates webhooks
  only by source IP; behind Caddy that means trusting `X-Forwarded-For` parsing.
  Re-fetching the payment by id from the API makes forged notifications
  harmless regardless of transport details, and doubles as the poll-path check.
- **Coupon at settlement.** Redeeming at initiation (as the synchronous mock
  path does — where settlement IS initiation) would consume caps for payments
  the payer abandons.
- **attohttpc + `spawn_blocking`** reuses the exact JWKS-fetch idiom and TLS
  stack (`rustls`/webpki) — zero new dependencies for outbound HTTP.
