-- Performance indexes for the per-quest count paths.
--
-- `bonus_awards` and `access_grants` are both PK'd on (player_id, quest_id), so
-- `quest_id` is NOT the leading column and any lookup or aggregate keyed on it
-- alone falls back to a sequential scan. The editor's per-quest pages
-- (get/create/set-status) count completions and buyers for ONE quest, and now do
-- so with `WHERE quest_id = $1` (completions_for_quest / buyers_for_quest) instead
-- of a whole-table GROUP BY — these indexes make that lookup an index scan.
CREATE INDEX IF NOT EXISTS idx_bonus_awards_quest ON bonus_awards (quest_id);
CREATE INDEX IF NOT EXISTS idx_access_grants_quest ON access_grants (quest_id);
