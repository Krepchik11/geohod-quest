-- Core schema. Invariants live as constraints:
--  * facts UNIQUE(attempt_id, natural_key)  -> idempotent append (device-agnostic key)
--  * bonus_awards PK(player_id, quest_id)   -> completion bonus once per player+quest, ever
--  * snapshots rows are immutable            -> version freeze (enforced in code on publish)

CREATE TABLE attempts (
    attempt_id  TEXT   PRIMARY KEY,
    player_id   TEXT   NOT NULL,
    quest_id    TEXT   NOT NULL,
    snapshot_id TEXT   NOT NULL,
    created_at  BIGINT NOT NULL
);

CREATE INDEX idx_attempts_player_quest ON attempts (player_id, quest_id);
CREATE INDEX idx_attempts_snapshot ON attempts (snapshot_id);

CREATE TABLE facts (
    seq         BIGSERIAL PRIMARY KEY,
    attempt_id  TEXT  NOT NULL REFERENCES attempts (attempt_id),
    -- canonical serialization of the device-agnostic natural key; a single NOT NULL
    -- column because a multi-column UNIQUE over nullable fields would not dedup
    -- (NULLs compare unequal in Postgres)
    natural_key TEXT  NOT NULL,
    data        JSONB NOT NULL,
    UNIQUE (attempt_id, natural_key)
);

CREATE TABLE bonus_awards (
    player_id TEXT NOT NULL,
    quest_id  TEXT NOT NULL,
    PRIMARY KEY (player_id, quest_id)
);

CREATE TABLE access_grants (
    player_id  TEXT NOT NULL,
    quest_id   TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    source     TEXT NOT NULL,
    source_ref TEXT,
    PRIMARY KEY (player_id, quest_id)
);

CREATE TABLE snapshots (
    snapshot_id  TEXT   PRIMARY KEY,
    quest_id     TEXT   NOT NULL,
    version      INT    NOT NULL,
    data         JSONB,
    published_at BIGINT NOT NULL
);

CREATE TABLE published_quests (
    quest_id         TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    primary_comic    TEXT,
    template_summary TEXT NOT NULL,
    snapshot_version INT  NOT NULL,
    snapshot_id      TEXT NOT NULL REFERENCES snapshots (snapshot_id)
);

CREATE TABLE migration_marks (
    key TEXT PRIMARY KEY
);
