-- Store-card quest facts as numbers: the walk's duration in minutes and the route
-- length in kilometres (shop card, product page, hero). Owner's decision
-- (2026-10-01): every quest is 60 minutes and 5 km; these are also the defaults a
-- new quest starts from, and its author may change them in the constructor.
--
-- The free-text `duration` label stays for the cached PWA clients that still read
-- it (the API must keep serving the previous frontend), and is brought to the same
-- 60 minutes so an old and a new client show one figure.
ALTER TABLE published_quests
    ADD COLUMN duration_min INT  NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 1 AND 1440),
    ADD COLUMN distance_km  REAL NOT NULL DEFAULT 5  CHECK (distance_km > 0 AND distance_km <= 100);

UPDATE published_quests SET duration = '≈ 60 мин';
