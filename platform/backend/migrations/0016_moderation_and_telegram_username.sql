-- Moderation overlay (content-moderation capability) + Telegram @username capture.
--
-- The overlay holds the MUTABLE admin decisions that sit beside the immutable,
-- append-only `facts` log. No fact is ever edited or deleted to hide a review or
-- resolve a report; moderation lives entirely in these two tables.

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
-- append-only (count only grows), a newly appended report makes the count exceed
-- the watermark and reopens the group automatically — with no write here and no
-- dependence on clock granularity. Reopen deletes the row.
CREATE TABLE resolved_feedback (
    quest_id      TEXT   NOT NULL,
    snapshot_id   TEXT   NOT NULL,
    step_position INT    NOT NULL,
    acknowledged  BIGINT NOT NULL,
    resolved_by   TEXT   NOT NULL,
    PRIMARY KEY (quest_id, snapshot_id, step_position)
);

-- Postgres wire protocol only (see 0001 for the rationale) — mirror every table.
ALTER TABLE hidden_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolved_feedback ENABLE ROW LEVEL SECURITY;

-- Telegram @username capture (player-identity). The verified handle was read from
-- the OIDC token and discarded; store it so a Telegram account is a reachable
-- t.me/<username> contact for admins. NULL for a Telegram user with no public handle
-- and for every non-Telegram identity (Google/email accounts are reached by email).
ALTER TABLE auth_identities ADD COLUMN username TEXT;

-- The global moderation scans filter facts by kind (quest_rated / feedback_reported);
-- back that with an expression index so they don't sequentially scan the whole log.
CREATE INDEX idx_facts_type ON facts ((data ->> 'type'));
