-- Runtime string settings (src/settings.rs). The registry of settings — keys
-- and what each means — lives in code; this table holds only the admin-set
-- runtime values. No row = the setting is unset (settings have no compiled-in
-- default values). No CHECK on `key`: the registry evolves in code, and rows
-- for retired settings are simply ignored.

CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Postgres wire protocol only (see 0001 for the rationale).
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
