-- Feature-toggle overrides (features spec, src/features.rs). The registry of
-- flags — keys, defaults, what each gates — lives in code; this table holds
-- only the admin-set runtime overrides. No row = the code default applies, so
-- a fresh deployment behaves exactly as compiled. No CHECK on `key`: the
-- registry evolves in code, and rows for retired flags are simply ignored.

CREATE TABLE feature_overrides (
    key        TEXT    PRIMARY KEY,
    enabled    BOOLEAN NOT NULL,
    updated_at TEXT    NOT NULL
);

-- Postgres wire protocol only (see 0001 for the rationale).
ALTER TABLE feature_overrides ENABLE ROW LEVEL SECURITY;
