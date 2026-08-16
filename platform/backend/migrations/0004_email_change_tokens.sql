-- §6.4 change email: a single-use token that carries the NEW address. The
-- existing confirm token only names a user (it stamps whatever email is
-- current), so a change needs its own kind plus a payload column for the
-- pending address.
ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_kind_check;
ALTER TABLE auth_tokens
    ADD CONSTRAINT auth_tokens_kind_check CHECK (kind IN ('reset', 'confirm', 'email_change'));
ALTER TABLE auth_tokens ADD COLUMN payload TEXT;
