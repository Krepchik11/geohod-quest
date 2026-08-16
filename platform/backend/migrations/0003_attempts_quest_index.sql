-- The product page and the reviews endpoint scope rating queries by quest
-- (facts JOIN attempts WHERE a.quest_id = ANY(...)). The only existing index
-- leads with player_id (idx_attempts_player_quest), so a quest-scoped scan
-- could not use it and walked the whole attempts table on a public hot path.
CREATE INDEX idx_attempts_quest ON attempts (quest_id);
