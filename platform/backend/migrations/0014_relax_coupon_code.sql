-- Coupon codes are free-form: any non-empty trimmed string (still stored
-- uppercased for case-insensitive matching). The old latin/digit/dash 3–32
-- format rule is gone — src/coupons.rs::normalize_code now only rejects
-- empty codes, so the DB mirrors that single rule.

ALTER TABLE coupons DROP CONSTRAINT coupons_code_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_code_check CHECK (btrim(code) <> '');
