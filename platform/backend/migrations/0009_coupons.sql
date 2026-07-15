-- Coupons: admin-managed discount codes redeemed at checkout.
--
-- `coupon_id` is the immutable identity; `code` is the human-facing handle,
-- unique but editable. Statuses (active/paused/expired/exhausted) are DERIVED
-- in code from `paused` / `valid_until` / the redemption count — only `paused`
-- is stored. `quest_ids` NULL means "all paid quests"; a JSONB array restricts
-- applicability. Redemptions are unique per (coupon, player, quest) — the same
-- granularity as access_grants — which makes a checkout retry idempotent and
-- closes the double-consume race (see src/coupons.rs).

CREATE TABLE coupons (
    coupon_id       TEXT   PRIMARY KEY,
    code            TEXT   NOT NULL UNIQUE
                     CHECK (code ~ '^[A-Z0-9-]{3,32}$'),
    discount_type   TEXT   NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
    discount_value  BIGINT NOT NULL CHECK (discount_value > 0),
    -- Inclusive last valid UTC date, 'YYYY-MM-DD'; NULL = no expiry.
    valid_until     TEXT,
    -- Total / per-player redemption caps; NULL = unlimited.
    max_redemptions BIGINT CHECK (max_redemptions > 0),
    per_user_limit  BIGINT CHECK (per_user_limit > 0),
    -- NULL = all paid quests; JSONB array of quest ids otherwise.
    quest_ids       JSONB,
    paused          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TEXT   NOT NULL
);

-- Admin list orders newest-first.
CREATE INDEX idx_coupons_created_at ON coupons (created_at DESC);

CREATE TABLE coupon_redemptions (
    coupon_id         TEXT   NOT NULL REFERENCES coupons (coupon_id) ON DELETE CASCADE,
    player_id         TEXT   NOT NULL,
    quest_id          TEXT   NOT NULL,
    amount_discounted BIGINT NOT NULL,
    redeemed_at       TEXT   NOT NULL,
    PRIMARY KEY (coupon_id, player_id, quest_id)
);

-- Postgres wire protocol only (see 0001 for the rationale).
ALTER TABLE coupons            ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;
