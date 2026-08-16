-- §11 rating rewards: the once-ever-per-(player, quest) guarantee now covers
-- three bonus kinds (completion, rating, comment), so the award marker keys on
-- the kind too. Existing rows are completion bonuses.
ALTER TABLE bonus_awards ADD COLUMN kind TEXT NOT NULL DEFAULT 'completion_bonus';
ALTER TABLE bonus_awards DROP CONSTRAINT bonus_awards_pkey;
ALTER TABLE bonus_awards ADD PRIMARY KEY (user_id, quest_id, kind);
