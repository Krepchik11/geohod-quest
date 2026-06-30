-- GeoQuest schema (consolidated initial migration).
--
-- Event-sourced facts over immutable published snapshots; the chain is
-- grant -> attempt -> facts. The project deploys onto a FRESH database, so the
-- earlier incremental history (the players->users rename, additive ALTERs, the
-- one-off seed purge) is folded into the current truth here — git history keeps
-- the step-by-step record. Invariants live as constraints where possible:
--   * facts UNIQUE(attempt_id, natural_key) -> idempotent, device-agnostic append
--   * bonus_awards PK(player_id, quest_id)  -> completion bonus once per player+quest
--   * snapshots rows are immutable           -> version freeze (enforced in code)

-- ---- Play: attempts, facts, bonuses, grants, snapshots, catalog -----------

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

-- Marketplace listing. city/duration/price are the author's real store-card values
-- (nullable: a blank field stays absent rather than being fabricated); price is
-- whole rubles (0 = free), BIGINT to never overflow.
CREATE TABLE published_quests (
    quest_id         TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    primary_comic    TEXT,
    template_summary TEXT NOT NULL,
    snapshot_version INT  NOT NULL,
    snapshot_id      TEXT NOT NULL REFERENCES snapshots (snapshot_id),
    city             TEXT,
    duration         TEXT,
    price            BIGINT
);

CREATE TABLE migration_marks (
    key TEXT PRIMARY KEY
);

-- ---- Accounts: users + sessions -------------------------------------------
--
-- A row exists ONLY once a device registers — anonymous players have no row by
-- design, so registration is metadata, never a data migration. `player_id` is the
-- *playing identity* (`dev:<uuid>`), kept as the partition key across
-- attempts/facts/grants/bonus_awards/sessions; `users.player_id` reads as "the
-- player identity this account is attached to". `role` is enforced at the DB too
-- (mirrors auth::validate_role).

CREATE TABLE users (
    player_id     TEXT   PRIMARY KEY,
    email         TEXT   NOT NULL UNIQUE,
    password_hash TEXT   NOT NULL,
    display_name  TEXT,
    created_at    BIGINT NOT NULL,
    role          TEXT   NOT NULL DEFAULT 'player'
                   CHECK (role IN ('admin', 'editor', 'player'))
);
-- Admin user list orders accounts newest-first.
CREATE INDEX idx_users_created_at ON users (created_at DESC);

-- Opaque server-side session tokens (revocation = DELETE; no expiry in MVP).
CREATE TABLE sessions (
    token      TEXT   PRIMARY KEY,
    player_id  TEXT   NOT NULL REFERENCES users (player_id),
    created_at BIGINT NOT NULL
);
CREATE INDEX idx_sessions_player ON sessions (player_id);

-- ---- Constructor: authoring-side registry ---------------------------------
--
-- Drafts + their editorial lifecycle, distinct from published_quests (the frozen
-- marketplace snapshots). Holds the full editable `body` (opaque JSONB) plus
-- denormalized list columns so the dashboard renders without loading every body.
-- Completions ("прохождения") are NOT stored here — derived from the fact log.

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
CREATE INDEX idx_ctor_quests_created ON constructor_quests (created_at DESC);
CREATE INDEX idx_ctor_quests_author ON constructor_quests (author_id);

-- ---- Row-Level Security (defense in depth on managed Postgres) -------------
--
-- Lock every table to the Postgres wire protocol only, so Supabase's auto Data
-- API (PostgREST, reachable with the PUBLIC anon key over `public`) can never
-- read or write these tables — they hold password hashes, session tokens, grants
-- and payment refs. RLS with NO policies denies the API roles (anon/authenticated)
-- entirely; the app is unaffected because it connects as the table-OWNER role
-- (`postgres` on Supabase, `geohod` locally), which BYPASSES RLS. Safe on both,
-- and it complements (does not replace) disabling the Data API in the dashboard.

ALTER TABLE attempts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE bonus_awards       ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_grants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_quests   ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_marks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE constructor_quests ENABLE ROW LEVEL SECURITY;

-- sqlx's own migration bookkeeping. No secrets, but no reason to expose it either.
ALTER TABLE _sqlx_migrations   ENABLE ROW LEVEL SECURITY;
