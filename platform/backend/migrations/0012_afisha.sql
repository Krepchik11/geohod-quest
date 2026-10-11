-- «Афиша» (2026-10-11): announcements of group walks and group quests, read
-- from the public page of the Telegram channel (backend src/afisha.rs). One row
-- per channel post; the announcement itself is the JSON body (status, kind,
-- fields, hand edits — see `AfishaEvent`), so a new template field needs no
-- migration. Clicks on «Записаться» are a counter of their own, never part of
-- the body a re-read rewrites.
CREATE TABLE afisha_events (
    channel    TEXT   NOT NULL,
    post_id    BIGINT NOT NULL,
    body       JSONB  NOT NULL,
    clicks     BIGINT NOT NULL DEFAULT 0,
    updated_at TEXT   NOT NULL,
    PRIMARY KEY (channel, post_id)
);

-- Same rule as every table in 0001_init.sql: no Data API access.
ALTER TABLE afisha_events ENABLE ROW LEVEL SECURITY;
