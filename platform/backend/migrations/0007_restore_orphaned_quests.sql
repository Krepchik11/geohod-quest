-- Orphaned quests: deleting a quest in the constructor used to drop only its
-- constructor row, leaving the published listing behind. The store treats a
-- published quest with NO constructor row as published (the path for quests
-- published straight through the API), so a deleted quest stayed on sale with
-- nothing left in the editor to hide it («444» in production). Deleting now takes
-- the listing too; this one-off brings the existing orphans back to the dashboard
-- as drafts — off the store (it lists `published` only), manageable again, and
-- still playable by anyone who bought them.
--
-- The original author is gone with the deleted row, so the restored draft belongs
-- to the operator; an admin can hand it over from the quest settings. The body is
-- the minimal editor shape `migrateQuest` accepts: the published meta, no pages
-- (a snapshot cannot be turned back into editable pages) and the published
-- version, so the next publish continues the numbering. It is recorded as not
-- live: the restored draft is off the store, and the editor must not call that
-- version «текущая в магазине».
INSERT INTO constructor_quests
    (quest_id, author_id, author_name, name, status, cover, steps_count, body,
     created_at, updated_at)
SELECT
    p.quest_id,
    'ops',
    'Восстановлен',
    p.name,
    'draft',
    p.primary_comic,
    COALESCE(p.pages, 0),
    jsonb_build_object(
        'id', p.quest_id,
        'meta', jsonb_build_object(
            'title', p.name,
            'city', COALESCE(p.city, ''),
            'duration', COALESCE(p.duration, ''),
            'cover', p.primary_comic,
            'coverOrigin', NULL,
            'desc', COALESCE(p.description, ''),
            'price', COALESCE(p.price, 0),
            'playersBonus', p.players_bonus,
            'complexity', 'medium',
            'ageTarget', 'everyone',
            'tags', '[]'::jsonb,
            'universalAnswer', '',
            'startCoords', '',
            'theme', NULL,
            'skipCost', 10
        ),
        'steps', '[]'::jsonb,
        'versions', jsonb_build_array(jsonb_build_object(
            'n', p.snapshot_version,
            'date', '',
            'pages', COALESCE(p.pages, 0),
            'size', '',
            'live', false,
            'attempts', 0
        )),
        'lastSaved', NULL
    ),
    EXTRACT(EPOCH FROM now())::BIGINT,
    EXTRACT(EPOCH FROM now())::BIGINT
FROM published_quests p
WHERE NOT EXISTS (SELECT 1 FROM constructor_quests c WHERE c.quest_id = p.quest_id);
