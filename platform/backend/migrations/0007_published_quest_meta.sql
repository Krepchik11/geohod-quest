-- Carry the real store-card metadata the constructor already collects (city,
-- duration, price) through publish into the marketplace listing. Before this,
-- `published_quests` held only name/comic/template_summary, so every store card
-- fabricated city/duration/price — the project carries NO mock data, so these
-- must be the author's real values.
--
-- All nullable: rows published before this migration simply have no city/
-- duration/price and the UI omits those fields rather than inventing them.
-- price is whole rubles (0 = free quest); BIGINT to never overflow.

ALTER TABLE published_quests ADD COLUMN IF NOT EXISTS city     TEXT;
ALTER TABLE published_quests ADD COLUMN IF NOT EXISTS duration TEXT;
ALTER TABLE published_quests ADD COLUMN IF NOT EXISTS price    BIGINT;
