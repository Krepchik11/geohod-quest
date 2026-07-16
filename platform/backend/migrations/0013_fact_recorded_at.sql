-- Admin statistics (date-bucketed analytics).
--
-- Facts deliberately carry no clock in their wire shape (dedup is by natural
-- key; projections must be order/time independent). recorded_at is
-- storage-level metadata — the server receive instant, Unix seconds UTC —
-- so time-bucketed analytics ("завершено за период") can exist at all.
--
-- facts.attempt_id is NOT NULL REFERENCES attempts (0001), so backfilling
-- from the attempt's created_at covers EVERY existing row — the column can be
-- NOT NULL from day one and readers never need a COALESCE fallback. The
-- backfill value is an approximation (the attempt's start instant), the best
-- available for rows written before this migration.
ALTER TABLE facts ADD COLUMN recorded_at BIGINT;

UPDATE facts
SET recorded_at = a.created_at
FROM attempts a
WHERE a.attempt_id = facts.attempt_id;

ALTER TABLE facts ALTER COLUMN recorded_at SET NOT NULL;

-- Range scans behind /api/admin/stats. The finish-events query filters
-- completions by recorded_at, so the index is partial on that fact kind —
-- a plain recorded_at index would be dead weight for the dominant fact kinds.
CREATE INDEX idx_facts_completed_recorded_at ON facts (recorded_at)
    WHERE data->>'type' = 'attempt_completed';
CREATE INDEX idx_attempts_created_at ON attempts (created_at);
CREATE INDEX idx_access_grants_granted_at ON access_grants (granted_at);
