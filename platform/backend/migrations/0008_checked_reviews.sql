-- «Проверено» on a review (admin content-moderation), one row per (player, quest)
-- — the same grain as `hidden_reviews`, and like it an overlay that never touches
-- `facts`. `checked_through` is the review version the admin saw: the rating's
-- server instant (`rated_at`, the newest quest_rated fact of the pair). A later
-- rating or text moves `rated_at` past it, and the review reads unchecked again
-- («ИЗМЕНЁН»). The mark only moves forward: a stale re-check keeps the newer one.
CREATE TABLE checked_reviews (
    user_id         TEXT   NOT NULL,
    quest_id        TEXT   NOT NULL,
    checked_through BIGINT NOT NULL,
    checked_at      BIGINT NOT NULL,
    checked_by      TEXT   NOT NULL,
    PRIMARY KEY (user_id, quest_id)
);

ALTER TABLE checked_reviews ENABLE ROW LEVEL SECURITY;

-- Baseline: every review that exists when checking ships counts as checked, so the
-- «new reviews» counter starts at zero instead of at the whole imported history.
-- `checked_by = 'baseline'` tells these apart — the admin shows no «Проверил …»
-- for them. Idempotent: a pair that already has a mark keeps it.
INSERT INTO checked_reviews (user_id, quest_id, checked_through, checked_at, checked_by)
SELECT a.user_id, a.quest_id, MAX(f.recorded_at), EXTRACT(EPOCH FROM now())::BIGINT, 'baseline'
FROM facts f
JOIN attempts a ON a.attempt_id = f.attempt_id
WHERE f.data->>'type' = 'quest_rated'
GROUP BY a.user_id, a.quest_id
ON CONFLICT (user_id, quest_id) DO NOTHING;
