-- Admin «Города» page (2026-10-10): what the admin edits per city — the picture
-- for the main banner and the slogan. Quests keep naming their city with a
-- plain string (constructor_quests.body -> meta -> city, published_quests.city),
-- so this table links to no quest and needs no seed: the admin list is these
-- rows plus every city the quests already use (backend src/cities.rs).
CREATE TABLE cities (
    name       TEXT PRIMARY KEY,
    image      TEXT,
    slogan     TEXT,
    updated_at TEXT NOT NULL
);

-- Same rule as every table in 0001_init.sql: no Data API access.
ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
