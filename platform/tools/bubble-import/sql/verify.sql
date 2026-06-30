-- Read-only post-load verification + the final-result listing. Pipe into prod psql.
\echo == counts (expect editors=5, drafts=19, non_draft=0, steps_ok=19) ==
SELECT
  (SELECT count(*) FROM users WHERE player_id LIKE 'bubble-user-%' AND role='editor')           AS editors,
  (SELECT count(*) FROM constructor_quests WHERE quest_id LIKE 'bubble-%' AND status='draft')   AS drafts,
  (SELECT count(*) FROM constructor_quests WHERE quest_id LIKE 'bubble-%' AND status<>'draft')  AS non_draft,
  (SELECT count(*) FROM constructor_quests
     WHERE quest_id LIKE 'bubble-%' AND steps_count = jsonb_array_length(body->'steps'))        AS steps_ok;
\echo == imported editor accounts (every email must end @imported.geohod.invalid) ==
SELECT player_id, email, display_name, role
FROM users WHERE player_id LIKE 'bubble-user-%' ORDER BY display_name;
\echo == the 19 imported draft quests (the final result) ==
SELECT name, steps_count AS steps, status,
       body->'meta'->>'city' AS city, body->'_import'->>'statusQuest' AS was_in_bubble
FROM constructor_quests WHERE quest_id LIKE 'bubble-%' ORDER BY name;
