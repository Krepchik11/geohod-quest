-- Access roles (admin-users spec): every registered account carries a role.
-- Adding the column with a NOT NULL DEFAULT backfills existing rows to 'player'
-- in one statement (no separate data migration). The CHECK mirrors auth::validate_role
-- so the three known values are enforced at the database too, not just in code.
ALTER TABLE players
    ADD COLUMN role TEXT NOT NULL DEFAULT 'player'
    CHECK (role IN ('admin', 'editor', 'player'));

-- Admin user-management lists registered accounts newest-first; the created_at
-- index keeps that ordering cheap as the table grows.
CREATE INDEX idx_players_created_at ON players (created_at DESC);
