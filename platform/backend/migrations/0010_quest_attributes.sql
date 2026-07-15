-- 0010: author-facing quest attributes (complexity / age target / free-form tags).
-- Denormalized onto the constructor row like name/steps_count because the
-- dashboard list filters on them; the same values also live inside the opaque
-- body.meta for the builder. Closed sets get the usual TEXT + CHECK treatment
-- (mirrored by store::QuestAttributes::from_wire in code); tags are a plain
-- TEXT[]. Neutral defaults keep existing rows valid without fabricating data.
ALTER TABLE constructor_quests
    ADD COLUMN complexity TEXT NOT NULL DEFAULT 'medium'
        CHECK (complexity IN ('low', 'medium', 'high')),
    ADD COLUMN age_target TEXT NOT NULL DEFAULT 'everyone'
        CHECK (age_target IN ('kids', 'everyone', '18plus')),
    ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';
