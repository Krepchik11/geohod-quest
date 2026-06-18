-- Purge the mock/seed data that the now-deleted startup seeders
-- (seed_demo_quests, seed_demo_constructor_quests, seed_completion) injected into
-- durable databases. The project carries NO mock data: the store must show only
-- quests genuinely published from the constructor, and completion counts must be
-- real play, not fabricated rows.
--
-- Safe + idempotent: a no-op on any database that never ran the seeders, and it
-- targets ONLY the known seed identifiers and the synthetic `seed-finisher:%`
-- players — never a quest an operator actually created or published.

-- Fabricated completion bonuses (synthetic finishers that inflated "прохождения").
DELETE FROM bonus_awards WHERE player_id LIKE 'seed-finisher:%';

-- Mock constructor drafts that populated the dashboard.
DELETE FROM constructor_quests
 WHERE quest_id IN ('q-ironia', 'q-podzem', 'q-stambul', 'q-krepost', 'q-baron', 'q-legend');

-- Mock published demo quests that polluted the store. published_quests.snapshot_id
-- references snapshots, so drop the published rows first, then their frozen snapshots.
DELETE FROM published_quests WHERE quest_id IN ('mystery-fortress-v1', 'ironia-sudby');
DELETE FROM snapshots WHERE quest_id IN ('mystery-fortress-v1', 'ironia-sudby');
