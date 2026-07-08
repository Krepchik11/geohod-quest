-- 0007: marketing players-count padding.
-- The public store card / product page show a "players" count that is the real
-- distinct completions (derived from the fact log) PLUS this author-set marketing
-- bonus. Stored per published quest; defaults to 0 so existing rows are unchanged
-- and quests never fabricate a count the author did not set.
ALTER TABLE published_quests
    ADD COLUMN players_bonus BIGINT NOT NULL DEFAULT 0;
