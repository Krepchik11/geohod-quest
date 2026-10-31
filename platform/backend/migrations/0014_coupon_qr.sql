-- QR invitations (2026-10-31): a coupon limited to one quest can carry a QR
-- code that opens the quest page with the code already applied (backend
-- src/coupons.rs). The QR holds the short link /go/<qr_slug>: the slug is made
-- once, when the admin asks for the QR, and never changes, so the coupon's code
-- stays editable and a printed QR keeps working. `gift_from` is the optional
-- «Подарок от …» line the quest page shows to whoever came by the QR.
ALTER TABLE coupons
    ADD COLUMN qr_slug   TEXT UNIQUE,
    ADD COLUMN gift_from TEXT;

-- QR scans per UTC day: a counter and nothing else — no IP, no device, no
-- player. Deleting the coupon drops its scans.
CREATE TABLE coupon_scans (
    coupon_id TEXT   NOT NULL REFERENCES coupons (coupon_id) ON DELETE CASCADE,
    day       TEXT   NOT NULL,
    scans     BIGINT NOT NULL,
    PRIMARY KEY (coupon_id, day)
);

-- Same rule as every table in 0001_init.sql: no Data API access.
ALTER TABLE coupon_scans ENABLE ROW LEVEL SECURITY;
