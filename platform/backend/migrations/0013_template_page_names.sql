-- Owner's decision (2026-10-30): page templates were renamed «Задание без
-- ответа» → «Поиск», «Задание с ответом» → «Задание», «Видео маршрута» →
-- «Видео» (frontend CTOR_TEMPLATES), and the pages already named after the old
-- templates take the new names once. In production that is the Bubble import:
-- «Задание с ответом 3» → «Задание 3», «Задание без ответа 4» → «Поиск 4».
--
-- A name changes only when it IS the old template name or starts with it plus a
-- space (a number, «(копия)»), and only on a page of that very template — a
-- written name is kept. Not touched: published snapshots (frozen; the new names
-- reach the admin funnel with the next publish), `updated_at` (not an author's
-- edit) and the `dash` summary (it is recomputed on the next save). Re-running
-- it changes nothing.
UPDATE constructor_quests AS q
SET body = jsonb_set(q.body, '{steps}', fixed.steps)
FROM (
    SELECT c.quest_id,
           jsonb_agg(
               CASE
                   WHEN r.old IS NOT NULL
                   THEN jsonb_set(s, '{name}', to_jsonb(r.new || substr(s->>'name', char_length(r.old) + 1)))
                   ELSE s
               END
               ORDER BY t.ord) AS steps
    FROM constructor_quests AS c
    CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(c.body->'steps') = 'array'
                  THEN c.body->'steps' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS t(s, ord)
    LEFT JOIN LATERAL (
        SELECT m.old, m.new
        FROM (VALUES ('task_no', 'Задание без ответа', 'Поиск'),
                     ('task_answer', 'Задание с ответом', 'Задание'),
                     ('route_video', 'Видео маршрута', 'Видео')) AS m(template, old, new)
        WHERE s->>'template' = m.template
          AND jsonb_typeof(s->'name') = 'string'
          AND (s->>'name' = m.old OR left(s->>'name', char_length(m.old) + 1) = m.old || ' ')
    ) AS r ON true
    GROUP BY c.quest_id
) AS fixed
WHERE q.quest_id = fixed.quest_id
  AND q.body->'steps' IS DISTINCT FROM fixed.steps;
