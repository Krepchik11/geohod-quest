-- Social sign-in (Google, Telegram). An account may now be reached by a provider
-- identity, not only email+password:
--   * A Telegram account has NO email and NO password.
--   * A Google account has an email (from the verified token) but no password.
-- So email/password become NULLABLE. The email UNIQUE constraint still holds for
-- non-NULL emails (Postgres treats NULLs as distinct), so many social-only
-- accounts with NULL email coexist.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Linked provider identities. One account (player_id) may hold several rows
-- (e.g. google + telegram); one provider identity maps to exactly one account
-- (PK). `subject` is the provider's stable id: Google `sub`, Telegram user id.
-- `email` is the provider-supplied address (Google), kept for reference/display;
-- it is NOT the account's login email. ON DELETE CASCADE drops identities with
-- the account (§7.4 delete).
CREATE TABLE auth_identities (
    provider   TEXT   NOT NULL CHECK (provider IN ('google', 'telegram')),
    subject    TEXT   NOT NULL,
    player_id  TEXT   NOT NULL REFERENCES users (player_id) ON DELETE CASCADE,
    email      TEXT,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_auth_identities_player ON auth_identities (player_id);
