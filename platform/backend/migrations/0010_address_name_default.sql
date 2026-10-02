-- Owner's decision (2026-10-02): an empty «Название» in a page's «Адрес и
-- расстояние» block becomes «Локация» in every constructor draft — the same text
-- a new page now starts with (frontend ADDRESS_NAME_DEFAULT). Only the pages that
-- show the block (task_no, task_answer, video, route_video), whether the block is
-- on or off; a name of spaces counts as empty, a written one is kept.
--
-- Not touched: published snapshots (frozen; «Локация» reaches players with the
-- next publish), steps of the pre-block shape without an `address` object (the
-- editor's migrateQuest names them on open) and `updated_at` (not an author's
-- edit). Re-running it changes nothing.
UPDATE constructor_quests AS q
SET body = jsonb_set(q.body, '{steps}', fixed.steps)
FROM (
    SELECT c.quest_id,
           jsonb_agg(
               CASE
                   WHEN s->>'template' IN ('task_no', 'task_answer', 'video', 'route_video')
                    AND jsonb_typeof(s->'address') = 'object'
                    AND btrim(coalesce(s->'address'->>'name', '')) = ''
                   THEN jsonb_set(s, '{address,name}', to_jsonb('Локация'::text))
                   ELSE s
               END
               ORDER BY t.ord) AS steps
    FROM constructor_quests AS c,
         jsonb_array_elements(CASE WHEN jsonb_typeof(c.body->'steps') = 'array'
                                   THEN c.body->'steps' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS t(s, ord)
    GROUP BY c.quest_id
) AS fixed
WHERE q.quest_id = fixed.quest_id
  AND q.body->'steps' IS DISTINCT FROM fixed.steps;
