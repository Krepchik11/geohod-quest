-- v2 §6 (auth): soft email confirmation + single-use auth tokens
-- (password reset R1 + email confirmation). Tokens are stored HASHED —
-- a database leak must not yield working reset links.
ALTER TABLE users ADD COLUMN email_confirmed_at BIGINT;
CREATE TABLE auth_tokens (
    token_hash TEXT   PRIMARY KEY,
    player_id  TEXT   NOT NULL,
    kind       TEXT   NOT NULL CHECK (kind IN ('reset', 'confirm')),
    expires_at BIGINT NOT NULL,
    used_at    BIGINT
);
CREATE INDEX idx_auth_tokens_player ON auth_tokens (player_id);
