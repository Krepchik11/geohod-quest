# Tasks

## 1. Provider seam + pure YooKassa client (TDD)
- [x] 1.1 `payments.rs`: kept the synchronous mock trait untouched; the redirect flow is its own seam (`YookassaGateway`) and checkout dispatches per request — `PendingPayment`/`PendingStatus` domain types added here instead of a forced shared `PaymentStart` (the two flows genuinely differ: sync/infallible vs async/fallible).
- [x] 1.2 `yookassa.rs` pure helpers + unit tests: `format_amount` (BIGINT rubles → `"N.00"`), `build_create_payment` body (amount/capture/confirmation.redirect+return_url/description ≤128/metadata), `parse_payment` (id, status, confirmation_url), `parse_notification` (event, object.id).
- [x] 1.3 `yookassa.rs` I/O shell: `YooKassaGateway` (attohttpc via `spawn_blocking`, Basic auth, `Idempotence-Key`) behind a `Gateway` seam with a scripted test fake (mailer-recorder pattern); `YOOKASSA_API_BASE` override.

## 2. Config
- [x] 2.1 `config.rs`: `YookassaConfig` from `YOOKASSA_SHOP_ID` + `YOOKASSA_SECRET_KEY` (all-or-nothing, loud warn on partial — MediaConfig pattern); tests.

## 3. Pending-payment store (tri-layer parity)
- [x] 3.1 Migration `0011_pending_payments.sql` (0010 was taken by quest attributes): table + `provider_payment_id` index + `(player_id, quest_id)` lookup + RLS enabled no policies.
- [x] 3.2 InMemory + Pg + `PaymentStores` enum: `insert`, `get`, `find_pending_for` (player, quest), `settle_succeeded` (CAS pending→succeeded, returns whether this call won), `mark_canceled`.

## 4. Checkout + settlement routes (TDD)
- [x] 4.1 `CheckoutRequest.provider` (`mock` default); `provider=yookassa` → price the order (coupon previewed, not redeemed), create YooKassa payment, insert pending row, respond `{payment: {payment_id, confirmation_url}}`; no grant, attempt creation still 403. Pending reuse: an open pending row for (player, quest) returns its stored `confirmation_url` without a second YooKassa payment.
- [x] 4.2 Shared `settle_payment`: refetch payment from gateway; succeeded → CAS + `create_grant_idemp(Payment, source_ref=yookassa id)` + redeem stored coupon (winner only; redeem failure logged, grant still made); canceled → mark row.
- [x] 4.3 `GET /api/payments/{id}` (row owner auth): lazily settles a still-pending row via the gateway, returns `{status, grant?}`.
- [x] 4.4 `POST /api/payments/yookassa/webhook`: parse notification, settle by provider payment id; 200 for verified, unknown, and forged notifications, 5xx only on transient internal failure (so YooKassa retries); no auth (verification = API refetch).
- [x] 4.5 `GET /api/payments/providers`: `["mock"]` or `["mock","yookassa"]`.
- [x] 4.6 Wire `AppState`: mock + optional YooKassa gateway from config (both state builders); `provider=yookassa` unconfigured → 501.
- [x] 4.7 Route tests: pending checkout (no grant, 403 attempt), poll settles via fake, webhook settles / ignores unknown / cancels, double-settle single redemption, pending reuse, coupon-partial redeems only on success, coupon-100 and free untouched, mock default unchanged, 501 unconfigured.

## 5. Frontend
- [x] 5.1 `lib/api.ts`: `CheckoutResult` union (`grant` | `payment.confirmation_url`), `paymentStatus(id)`, `paymentProviders()`.
- [x] 5.2 `PurchaseSheet.tsx`: method selector (ЮKassa card / test payment) when both available, default ЮKassa; confirm → redirect via `confirmation_url` with «Переходим к оплате…» state; mock path unchanged.
- [x] 5.3 `AboutClient.tsx`: on `?payment={id}` poll `paymentStatus` (backoff); succeeded → owned flips + success note; canceled → «Оплата не прошла — деньги не списаны» + retry.
- [x] 5.4 Styles: reuse `psheet__*` / commerce.css language for the selector + result states.
- [x] 5.5 vitest: selector render/choice, redirect on confirm, return-poll success and canceled paths.

## 6. Deploy + docs
- [x] 6.1 `.env.example`: `YOOKASSA_*` block.
- [x] 6.2 `deploy/geohod-quest-api.container`: `Environment=YOOKASSA_SHOP_ID=` + `Secret=geohod-quest-yookassa-secret-key,type=env,target=YOOKASSA_SECRET_KEY` (commented until secret exists).
- [x] 6.3 `DEPLOYMENT.md`: podman secret creation, dashboard webhook URL (`payment.succeeded`, `payment.canceled`), shop id placement.

## 7. Verify
- [x] 7.1 `cargo test` — 155 pass; the 2 Postgres suites need a live DB (no container runtime in this env — pre-existing, fails identically on the clean tree). `clippy`: zero findings in new code (`-D warnings` baseline already red on untouched files). `fmt --check` clean.
- [x] 7.2 `npm run test`, lint, build.
- [x] 7.3 Drove the REAL HTTP path live: local YooKassa API mock + running backend — checkout(450 RUB) -> pending + confirmation_url, pending reuse, forged webhook harmless (200, still pending), genuine webhook settles (grant source_ref = gateway payment id), poll replays settled, canceled frees a retry with a fresh payment, foreign-player probe 404, providers endpoint lists both. Frontend covered by 376 vitest tests + production build.
