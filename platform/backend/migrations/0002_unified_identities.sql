-- One identities table, player_id -> user_id.
--
-- 0001 was applied before this change; applied migrations are immutable
-- (sqlx checksums them), so the delta ships here.

-- ---- player_id -> user_id on every table -----------------------------------
--
-- `user_id` is the universal principal id — see the module doc in src/auth.rs.

ALTER TABLE attempts           RENAME COLUMN player_id TO user_id;
ALTER TABLE bonus_awards       RENAME COLUMN player_id TO user_id;
ALTER TABLE access_grants      RENAME COLUMN player_id TO user_id;
ALTER TABLE users              RENAME COLUMN player_id TO user_id;
ALTER TABLE sessions           RENAME COLUMN player_id TO user_id;
ALTER TABLE auth_tokens        RENAME COLUMN player_id TO user_id;
ALTER TABLE coupon_redemptions RENAME COLUMN player_id TO user_id;
ALTER TABLE pending_payments   RENAME COLUMN player_id TO user_id;
ALTER TABLE hidden_reviews     RENAME COLUMN player_id TO user_id;

ALTER INDEX idx_attempts_player_quest         RENAME TO idx_attempts_user_quest;
ALTER INDEX idx_sessions_player               RENAME TO idx_sessions_user;
ALTER INDEX idx_auth_tokens_player            RENAME TO idx_auth_tokens_user;
ALTER INDEX idx_pending_payments_player_quest RENAME TO idx_pending_payments_user_quest;

-- ---- identities: every way to sign in is ONE row ---------------------------
--
-- A tagged union keyed by `method`. A method works iff its row exists; there is
-- no "half-linked" state.
--
--   * password — the built-in email+password login. `identifier` is the
--     account's own user_id (the login ADDRESS lives on users.email, which is
--     an account property, not a credential); `secret_hash` is the argon2 hash.
--     The row exists only once a password is actually set, so a social-created
--     account gains password login exactly when a §6.2 reset creates the row.
--   * google / telegram — `identifier` is the provider's stable subject id
--     (the Google `sub`, the Telegram user id). `handle` is the verified
--     Telegram @username, so a Telegram account is a reachable t.me/<handle>
--     contact — NULL for a handleless Telegram user and every other method.
--
-- One identity maps to exactly one account (PK); one account holds at most one
-- row per method (UNIQUE — unlink and the profile list work per method; the
-- constraint NAME is matched in pg_store::create_identity, rename them
-- together). The per-method CHECKs pin each variant's exact shape, so a NULL
-- is never an accident: a password row without a secret or a google row with a
-- handle cannot be stored. ON DELETE CASCADE drops identities with the account.
CREATE TABLE identities (
    method      TEXT   NOT NULL CHECK (method IN ('password', 'google', 'telegram')),
    identifier  TEXT   NOT NULL,
    user_id     TEXT   NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    secret_hash TEXT,
    handle      TEXT,
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (method, identifier),
    CONSTRAINT identities_one_per_method UNIQUE (user_id, method),
    CONSTRAINT identities_password_shape CHECK (
        method <> 'password'
        OR (identifier = user_id AND secret_hash IS NOT NULL AND handle IS NULL)),
    CONSTRAINT identities_google_shape CHECK (
        method <> 'google' OR (secret_hash IS NULL AND handle IS NULL)),
    CONSTRAINT identities_telegram_shape CHECK (
        method <> 'telegram' OR secret_hash IS NULL)
);
-- Per-account scans (profile method list, unlink, admin batches) are served by
-- the UNIQUE (user_id, method) index — user_id is its leading column.

INSERT INTO identities (method, identifier, user_id, secret_hash, created_at)
SELECT 'password', user_id, user_id, password_hash, created_at
FROM users
WHERE password_hash IS NOT NULL;

-- Provider identities move over. `handle` is Telegram-only under the new
-- CHECKs; the old table never constrained `username`, so anything a google row
-- might carry is dropped rather than tripping identities_google_shape.
-- auth_identities.email is dropped entirely: it was reference-only display
-- data, never the login email. If any account holds two rows of one provider
-- (the old PK allowed it), identities_one_per_method aborts the migration —
-- fail loud beats silently dropping a login.
INSERT INTO identities (method, identifier, user_id, handle, created_at)
SELECT provider, subject, player_id,
       CASE WHEN provider = 'telegram' THEN username END,
       created_at
FROM auth_identities;

ALTER TABLE users DROP COLUMN password_hash;
DROP TABLE auth_identities;

-- Same deny-by-default RLS as every table in 0001.
ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
