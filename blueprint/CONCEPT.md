CONCEPT

3 parts:
- MARKET: discover buy grants
- QUEST: smartphone PWA play
- BUILD: admin ctor only

Quest = linear seq GameStep

GameStep:
- rich content primary (comic per page: task / character / hint / atmosphere)
- completion rule: physical (confirm move+action) | answer (list match)
- support add: gift coins, hint cost, navigator button (shortest route), bonus anim+voice

4 templates primary UI:
- first screen
- task no answer (physical)
- task with answer
- continue

Access = lifetime grant (pay | coupon% | free)

Play = download snapshot, full offline, client validate vs snapshot

Coins = earn tasks (gifts+bonuses from snapshot), spend hints (popup wrong only), accumulate rating

Progress = immutable facts only. Project state. No mutation.

Invariants:
- attempt bind snapshot at start
- client sole judge local
- facts append only
- grant before play/earn
- freeze all at publish
- linear no branch v1

Old bubble = dead. Scattered mutations. No versions. No offline. Cut all.