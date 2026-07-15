-- Pending redirect payments (YooKassa): the in-flight state between checkout
-- and settlement. The grant itself stays in access_grants (created only on a
-- verified `succeeded`); this table exists because a redirect provider is
-- asynchronous — the payer leaves for the gateway and the outcome arrives via
-- webhook or an owner poll, either of which must find the order again.
--
-- `id` is our identifier (also the YooKassa Idempotence-Key and the return_url
-- token); `provider_payment_id` is YooKassa's. `coupon_code` is held for
-- settlement — redeemed only on success, so a canceled payment never burns the
-- code. Status is one-way pending -> succeeded|canceled; the succeeded flip is
-- a compare-and-set (WHERE status = 'pending') electing a single settle winner.

CREATE TABLE pending_payments (
    id                  TEXT   PRIMARY KEY,
    provider_payment_id TEXT   NOT NULL,
    player_id           TEXT   NOT NULL,
    quest_id            TEXT   NOT NULL,
    coupon_code         TEXT,
    -- Whole rubles actually charged (price minus any partial discount).
    amount              BIGINT NOT NULL CHECK (amount > 0),
    -- Full quest price at checkout time: the discount base settlement passes to
    -- the coupon redemption (no re-fetch, immune to mid-flight repricing).
    price               BIGINT NOT NULL CHECK (price >= amount),
    confirmation_url    TEXT   NOT NULL,
    status              TEXT   NOT NULL CHECK (status IN ('pending', 'succeeded', 'canceled')),
    created_at          TEXT   NOT NULL
);

-- Webhook lookup: notification carries only the provider's payment id.
CREATE INDEX idx_pending_payments_provider_id ON pending_payments (provider_payment_id);
-- Checkout reuse: an open payment for (player, quest) is returned instead of
-- creating a duplicate at the gateway.
CREATE INDEX idx_pending_payments_player_quest ON pending_payments (player_id, quest_id);

-- Postgres wire protocol only (see 0001 for the rationale).
ALTER TABLE pending_payments ENABLE ROW LEVEL SECURITY;
