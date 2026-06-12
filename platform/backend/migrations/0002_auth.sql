-- Identity: registration decorates an existing (anonymous, device-minted) player_id.
-- A players row exists ONLY once registered — anonymous players have no row by design,
-- so registration is metadata, never a data migration (grants/facts/bonus keys unchanged).

CREATE TABLE players (
    player_id     TEXT   PRIMARY KEY,
    email         TEXT   NOT NULL UNIQUE,
    password_hash TEXT   NOT NULL,
    display_name  TEXT,
    created_at    BIGINT NOT NULL
);

-- Opaque server-side session tokens (revocation = DELETE; no expiry in MVP, recorded cut).
CREATE TABLE sessions (
    token      TEXT   PRIMARY KEY,
    player_id  TEXT   NOT NULL REFERENCES players (player_id),
    created_at BIGINT NOT NULL
);

CREATE INDEX idx_sessions_player ON sessions (player_id);
