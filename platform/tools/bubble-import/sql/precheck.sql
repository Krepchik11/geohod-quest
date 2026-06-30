-- Read-only pre-flight for the bubble import. Confirms the schema is migrated and
-- shows current state BEFORE loading. Pipe into prod psql; nothing here mutates.
\echo == tables (must include: users, constructor_quests) ==
\dt
\echo == current state (bubble_*_existing should be 0 on a first load; >0 = re-run/upsert) ==
SELECT
  (SELECT count(*) FROM users)                                             AS users_total,
  (SELECT count(*) FROM users WHERE player_id LIKE 'bubble-user-%')        AS bubble_users_existing,
  (SELECT count(*) FROM constructor_quests)                                AS cq_total,
  (SELECT count(*) FROM constructor_quests WHERE quest_id LIKE 'bubble-%') AS bubble_quests_existing;
