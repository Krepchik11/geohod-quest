-- Constructor quests: the authoring-side registry — drafts + their editorial
-- lifecycle — distinct from `published_quests` (the immutable marketplace
-- snapshots a publish freezes). This is what makes the constructor dashboard
-- possible: before this table, drafts lived only in each editor's browser
-- localStorage, so author attribution, status, step counts and cross-device
-- editing could not exist. A row holds the full editable CtorQuest `body`
-- (opaque JSONB) plus denormalized list columns so the dashboard renders
-- without loading every body.
--
--  * author_id   — the creating editor's playing id (audit/ownership)
--  * author_name — display label captured at creation (denormalized: no users
--                  join on the hot list path; an author rename is cosmetic)
--  * status      — 'draft' | 'test' | 'published'; the publish flow flips it to
--                  'published' (a CHECK keeps the column honest)
--  * steps_count — page count, kept in sync on every save (truthful list metric)
--  * completions ("прохождения") are NOT stored here — they are derived from the
--    fact log / bonus_awards per quest_id, so the metric stays a pure projection.

CREATE TABLE constructor_quests (
    quest_id    TEXT   PRIMARY KEY,
    author_id   TEXT   NOT NULL,
    author_name TEXT   NOT NULL,
    name        TEXT   NOT NULL,
    status      TEXT   NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'test', 'published')),
    cover       TEXT,
    steps_count INT    NOT NULL DEFAULT 0,
    body        JSONB  NOT NULL,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL
);

-- Dashboard list order is newest-first; author filter scans by author.
CREATE INDEX idx_ctor_quests_created ON constructor_quests (created_at DESC);
CREATE INDEX idx_ctor_quests_author ON constructor_quests (author_id);
