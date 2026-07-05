-- v2 §12.9: product-page fields on the published card.
-- description: the constructor's store description (shown on /quest/[id]/about).
-- pages/tasks/paid_hints: content chips derived from the frozen snapshot at
-- publish time (NULL for versions published before this migration — the UI
-- hides chips it cannot honestly claim).
ALTER TABLE published_quests ADD COLUMN description TEXT;
ALTER TABLE published_quests ADD COLUMN pages INT;
ALTER TABLE published_quests ADD COLUMN tasks INT;
ALTER TABLE published_quests ADD COLUMN paid_hints BOOLEAN;
