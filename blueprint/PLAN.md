PLAN

Phase 1 - Core Model Lock
- propagate latest to 01 03 04 00 06 07 (GameStep shape, facts, client visuals, FeedbackReport, bundle spec)
- re-est 5mb with real comics/nav/audio
- export real quests (556 steps + 2-3 full) for goldens + validation

Phase 2 - Types + Goldens
- shared types (GameStep expanded, AttemptFact, CoinFact, FeedbackReport)
- pure fns: isAnswerCorrect, validateForPublish, projectState, serializeSnapshot
- goldens from real quests (playthroughs, races, client flows)

Phase 3 - Impl Slices
- build: ctor (4 picker, role zones, gates, test player)
- play: PWA offline (bundle cache, local log+project, 4 templates render, popup, nav button)
- sync: facts append, projectors, corrections
- commerce: grants + market peer

Phase 4 - Polish
- ctor import YAML power
- per version analytics
- admin stats (grants, attempts, reports per step)
- migration job (synthetic legacy + facts)

Cuts:
- no real$ coins v1
- no external authors
- no magic auth legacy
- no branching
- no data retention GDPR

Risks to beat:
- bundle size
- ctor velocity with new fields
- frozen bad visuals (gates + analytics)
- sync races new flows (facts mandatory)
- rating abuse

Next immediate:
- update primary business docs from this blueprint
- real data walk
- shared types start

All old business/analysis/docs = historical only. This = current truth.