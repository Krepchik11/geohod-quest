-- GeoQuest schema — the whole database, in one file.
--
-- The deployment starts from an empty database, so there is no migration
-- history to replay: this file IS the schema. Invariants live as constraints
-- wherever the database can hold them:
--   * facts UNIQUE(attempt_id, natural_key) -> idempotent, device-agnostic append
--   * bonus_awards PK(player_id, quest_id)  -> completion bonus once per player+quest
--   * coupon_redemptions PK(coupon, player, quest) -> checkout retry is idempotent
--   * snapshots rows are immutable          -> version freeze (enforced in code)
--
-- Row-Level Security is enabled on every table, with no policies (see the block
-- at the end for why).

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
CREATE INDEX idx_attempts_created_at ON attempts (created_at);

-- The append-only event log. `recorded_at` is storage-level metadata (the server
-- receive instant, Unix seconds UTC) — facts carry no clock in their wire shape,
-- because dedup is by natural key and projections must be order/time independent.
CREATE TABLE facts (
    seq         BIGSERIAL PRIMARY KEY,
    attempt_id  TEXT   NOT NULL REFERENCES attempts (attempt_id),
    -- canonical serialization of the device-agnostic natural key; a single NOT NULL
    -- column because a multi-column UNIQUE over nullable fields would not dedup
    -- (NULLs compare unequal in Postgres)
    natural_key TEXT   NOT NULL,
    data        JSONB  NOT NULL,
    recorded_at BIGINT NOT NULL,
    UNIQUE (attempt_id, natural_key)
);
-- The range scans behind /api/admin/stats filter completions by recorded_at, so
-- the index is partial on that fact kind — a plain recorded_at index would be
-- dead weight for the dominant fact kinds.
CREATE INDEX idx_facts_completed_recorded_at ON facts (recorded_at)
    WHERE data->>'type' = 'attempt_completed';
-- The moderation scans filter by fact kind (quest_rated / feedback_reported).
CREATE INDEX idx_facts_type ON facts ((data ->> 'type'));

CREATE TABLE bonus_awards (
    player_id TEXT NOT NULL,
    quest_id  TEXT NOT NULL,
    PRIMARY KEY (player_id, quest_id)
);
-- quest_id is not the leading PK column, so a per-quest count would seq-scan.
CREATE INDEX idx_bonus_awards_quest ON bonus_awards (quest_id);

CREATE TABLE access_grants (
    player_id  TEXT NOT NULL,
    quest_id   TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    source     TEXT NOT NULL,
    source_ref TEXT,
    PRIMARY KEY (player_id, quest_id)
);
CREATE INDEX idx_access_grants_quest ON access_grants (quest_id);
CREATE INDEX idx_access_grants_granted_at ON access_grants (granted_at);

CREATE TABLE snapshots (
    snapshot_id  TEXT   PRIMARY KEY,
    quest_id     TEXT   NOT NULL,
    version      INT    NOT NULL,
    data         JSONB,
    published_at BIGINT NOT NULL
);

-- Marketplace listing. city/duration/price are the author's real store-card values
-- (nullable: a blank field stays absent rather than being fabricated); price is
-- whole rubles (0 = free), BIGINT to never overflow. pages/tasks/paid_hints are
-- content chips derived from the frozen snapshot at publish time. players_bonus is
-- the author-set marketing padding added to the real distinct-completion count.
CREATE TABLE published_quests (
    quest_id         TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    primary_comic    TEXT,
    template_summary TEXT NOT NULL,
    snapshot_version INT  NOT NULL,
    snapshot_id      TEXT NOT NULL REFERENCES snapshots (snapshot_id),
    city             TEXT,
    duration         TEXT,
    price            BIGINT,
    description      TEXT,
    pages            INT,
    tasks            INT,
    paid_hints       BOOLEAN,
    players_bonus    BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE migration_marks (
    key TEXT PRIMARY KEY
);

-- ---- Accounts: users, sessions, auth tokens, provider identities ----------
--
-- A row exists ONLY once a device registers — anonymous players have no row by
-- design, so registration is metadata, never a data migration. `player_id` is the
-- *playing identity* (`dev:<uuid>`), kept as the partition key across
-- attempts/facts/grants/bonus_awards/sessions; `users.player_id` reads as "the
-- player identity this account is attached to". `role` is enforced at the DB too
-- (mirrors auth::validate_role).
--
-- email and password_hash are NULLABLE because an account may be reached by a
-- provider identity instead: a Telegram account has neither, a Google account has
-- an email from the verified token but no password. The email UNIQUE constraint
-- still holds for non-NULL values (Postgres treats NULLs as distinct), so many
-- social-only accounts coexist. Emails are canonical (trimmed + lowercased) at
-- every auth API boundary; the CHECK stops any future code path from
-- reintroducing case-variant duplicate accounts.

CREATE TABLE users (
    player_id          TEXT   PRIMARY KEY,
    email              TEXT   UNIQUE,
    password_hash      TEXT,
    display_name       TEXT,
    created_at         BIGINT NOT NULL,
    role               TEXT   NOT NULL DEFAULT 'player'
                        CHECK (role IN ('admin', 'editor', 'player')),
    email_confirmed_at BIGINT,
    CONSTRAINT users_email_canonical CHECK (email = lower(btrim(email)))
);
-- The admin user list orders accounts newest-first.
CREATE INDEX idx_users_created_at ON users (created_at DESC);

-- Opaque server-side session tokens (revocation = DELETE; no expiry in MVP).
CREATE TABLE sessions (
    token      TEXT   PRIMARY KEY,
    player_id  TEXT   NOT NULL REFERENCES users (player_id),
    created_at BIGINT NOT NULL
);
CREATE INDEX idx_sessions_player ON sessions (player_id);

-- Single-use auth tokens: password reset (both the link and the 6-digit code) and
-- email confirmation. The link token and the code are both stored HASHED — a
-- database leak must not yield working reset links or codes. The code is
-- low-entropy and online-guessable by design, so the row carries its own guard: a
-- per-token attempt counter, on top of the single-use semantics it shares with
-- the link.
CREATE TABLE auth_tokens (
    token_hash TEXT   PRIMARY KEY,
    player_id  TEXT   NOT NULL,
    kind       TEXT   NOT NULL CHECK (kind IN ('reset', 'confirm')),
    expires_at BIGINT NOT NULL,
    used_at    BIGINT,
    code_hash  TEXT   NOT NULL DEFAULT '',
    attempts   BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX idx_auth_tokens_player ON auth_tokens (player_id);

-- Linked provider identities. One account (player_id) may hold several rows
-- (e.g. google + telegram); one provider identity maps to exactly one account
-- (PK). `subject` is the provider's stable id: the Google `sub`, the Telegram
-- user id. `email` is the provider-supplied address (Google), kept for
-- reference/display; it is NOT the account's login email. `username` is the
-- verified Telegram @handle, so a Telegram account is a reachable
-- t.me/<username> contact — NULL for a Telegram user with no public handle and
-- for every Google identity. ON DELETE CASCADE drops identities with the account.
CREATE TABLE auth_identities (
    provider   TEXT   NOT NULL CHECK (provider IN ('google', 'telegram')),
    subject    TEXT   NOT NULL,
    player_id  TEXT   NOT NULL REFERENCES users (player_id) ON DELETE CASCADE,
    email      TEXT,
    created_at BIGINT NOT NULL,
    username   TEXT,
    PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_auth_identities_player ON auth_identities (player_id);

-- ---- Constructor: authoring-side registry ---------------------------------
--
-- Drafts + their editorial lifecycle, distinct from published_quests (the frozen
-- marketplace snapshots). Holds the full editable `body` (opaque JSONB) plus
-- denormalized list columns so the dashboard renders without loading every body.
-- Completions ("прохождения") are NOT stored here — derived from the fact log.
-- complexity/age_target/tags are denormalized like name/steps_count because the
-- dashboard list filters on them; the same values also live inside body.meta.

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
    updated_at  BIGINT NOT NULL,
    complexity  TEXT   NOT NULL DEFAULT 'medium'
                 CHECK (complexity IN ('low', 'medium', 'high')),
    age_target  TEXT   NOT NULL DEFAULT 'everyone'
                 CHECK (age_target IN ('kids', 'everyone', '18plus')),
    tags        TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_ctor_quests_created ON constructor_quests (created_at DESC);
CREATE INDEX idx_ctor_quests_author ON constructor_quests (author_id);

-- ---- Commerce: coupons and redirect payments ------------------------------
--
-- `coupon_id` is the immutable identity; `code` is the human-facing handle,
-- unique but editable, stored uppercased for case-insensitive matching (the only
-- format rule is non-empty, mirroring coupons::normalize_code). Statuses
-- (active/paused/expired/exhausted) are DERIVED in code from `paused` /
-- `valid_until` / the redemption count — only `paused` is stored. `quest_ids`
-- NULL means "all paid quests"; a JSONB array restricts applicability.
-- Redemptions are unique per (coupon, player, quest) — the same granularity as
-- access_grants — which makes a checkout retry idempotent and closes the
-- double-consume race (see src/coupons.rs).

CREATE TABLE coupons (
    coupon_id       TEXT   PRIMARY KEY,
    code            TEXT   NOT NULL UNIQUE
                     CHECK (btrim(code) <> ''),
    discount_type   TEXT   NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
    discount_value  BIGINT NOT NULL CHECK (discount_value > 0),
    -- Inclusive last valid UTC date, 'YYYY-MM-DD'; NULL = no expiry.
    valid_until     TEXT,
    -- Total / per-player redemption caps; NULL = unlimited.
    max_redemptions BIGINT CHECK (max_redemptions > 0),
    per_user_limit  BIGINT CHECK (per_user_limit > 0),
    -- NULL = all paid quests; a JSONB array of quest ids otherwise.
    quest_ids       JSONB,
    paused          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TEXT   NOT NULL
);
-- The admin list orders newest-first.
CREATE INDEX idx_coupons_created_at ON coupons (created_at DESC);

CREATE TABLE coupon_redemptions (
    coupon_id         TEXT   NOT NULL REFERENCES coupons (coupon_id) ON DELETE CASCADE,
    player_id         TEXT   NOT NULL,
    quest_id          TEXT   NOT NULL,
    amount_discounted BIGINT NOT NULL,
    redeemed_at       TEXT   NOT NULL,
    PRIMARY KEY (coupon_id, player_id, quest_id)
);

-- Pending redirect payments (YooKassa): the in-flight state between checkout
-- and settlement. The grant itself stays in access_grants (created only on a
-- verified `succeeded`); this table exists because a redirect provider is
-- asynchronous — the payer leaves for the gateway and the outcome arrives via
-- webhook or an owner poll, either of which must find the order again.
--
-- `id` is our identifier (also the YooKassa Idempotence-Key and the return_url
-- token); `provider_payment_id` is YooKassa's. `coupon_code` is held for
-- settlement — redeemed only on success, so a canceled payment never burns the
-- code. Status is one-way pending -> succeeded|canceled; the succeeded flip is
-- a compare-and-set (WHERE status = 'pending') electing a single settle winner.

CREATE TABLE pending_payments (
    id                  TEXT   PRIMARY KEY,
    provider_payment_id TEXT   NOT NULL,
    player_id           TEXT   NOT NULL,
    quest_id            TEXT   NOT NULL,
    coupon_code         TEXT,
    -- Whole rubles actually charged (price minus any partial discount).
    amount              BIGINT NOT NULL CHECK (amount > 0),
    -- The full quest price at checkout time: the discount base settlement passes
    -- to the coupon redemption (no re-fetch, immune to mid-flight repricing).
    price               BIGINT NOT NULL CHECK (price >= amount),
    confirmation_url    TEXT   NOT NULL,
    status              TEXT   NOT NULL CHECK (status IN ('pending', 'succeeded', 'canceled')),
    created_at          TEXT   NOT NULL
);
-- Webhook lookup: the notification carries only the provider's payment id.
CREATE INDEX idx_pending_payments_provider_id ON pending_payments (provider_payment_id);
-- Checkout reuse: an open payment for (player, quest) is returned instead of
-- creating a duplicate at the gateway.
CREATE INDEX idx_pending_payments_player_quest ON pending_payments (player_id, quest_id);

-- ---- Runtime configuration: feature toggles and settings ------------------
--
-- Both registries — which flags/settings exist and what each does — live in code
-- (src/features.rs, src/settings.rs). These tables hold only the admin-set
-- runtime values. No row means the code default applies, so a fresh deployment
-- behaves exactly as compiled: every feature flag ships OFF, and enabling one is
-- always an explicit admin decision. No CHECK on `key` in either table: the
-- registries evolve in code, and rows for retired keys are simply ignored.

CREATE TABLE feature_overrides (
    key        TEXT    PRIMARY KEY,
    enabled    BOOLEAN NOT NULL,
    updated_at TEXT    NOT NULL
);

CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- ---- Moderation overlay ---------------------------------------------------
--
-- The MUTABLE admin decisions that sit beside the immutable, append-only `facts`
-- log. No fact is ever edited or deleted to hide a review or resolve a report;
-- moderation lives entirely in these two tables.

-- A review hide, keyed to (player, quest) — it spans every version of the quest.
-- Row present = that player's rating for that quest is hidden from the public page
-- and dropped from the average. Unhide deletes the row.
CREATE TABLE hidden_reviews (
    player_id  TEXT   NOT NULL,
    quest_id   TEXT   NOT NULL,
    hidden_at  BIGINT NOT NULL,
    hidden_by  TEXT   NOT NULL,
    PRIMARY KEY (player_id, quest_id)
);

-- A feedback resolution watermark, keyed to (quest, snapshot, step). `acknowledged`
-- is the number of reports in the group the admin marked resolved. A group reads
-- resolved iff its CURRENT report count is <= `acknowledged`; because reports are
-- append-only (the count only grows), a newly appended report makes the count
-- exceed the watermark and reopens the group automatically — with no write here
-- and no dependence on clock granularity. Reopen deletes the row.
CREATE TABLE resolved_feedback (
    quest_id      TEXT   NOT NULL,
    snapshot_id   TEXT   NOT NULL,
    step_position INT    NOT NULL,
    acknowledged  BIGINT NOT NULL,
    resolved_by   TEXT   NOT NULL,
    PRIMARY KEY (quest_id, snapshot_id, step_position)
);

-- ---- Row-Level Security (defense in depth on managed Postgres) -------------
--
-- Lock every table to the Postgres wire protocol only, so Supabase's auto Data
-- API (PostgREST, reachable with the PUBLIC anon key over `public`) can never
-- read or write these tables — they hold password hashes, session tokens, reset
-- token/code hashes, provider identities, grants and payment refs. RLS with NO
-- policies denies the API roles (anon/authenticated) entirely; the app is
-- unaffected because it connects as the table-OWNER role (`postgres` on Supabase,
-- `geohod` locally), which BYPASSES RLS. Safe on both, and it complements (does
-- not replace) disabling the Data API in the dashboard.
--
-- EVERY table is listed. The old incremental chain enabled RLS per migration and
-- missed auth_tokens and auth_identities; one list in one file is why that class
-- of gap cannot recur.

ALTER TABLE attempts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE bonus_awards       ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_grants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_quests   ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_marks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_identities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE constructor_quests ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons            ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_payments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_overrides  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hidden_reviews     ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolved_feedback  ENABLE ROW LEVEL SECURITY;

-- sqlx's own migration bookkeeping. No secrets, but no reason to expose it either.
ALTER TABLE _sqlx_migrations   ENABLE ROW LEVEL SECURITY;
