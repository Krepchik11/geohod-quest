TECH

Snapshots:
- explicit publish = immutable version
- bind attempt to version
- historical retain for in-progress re-dl

Events:
- all progress/coins = append only facts
- AttemptFact + CoinFact
- client local log + project offline
- sync = append pending + pull + re-project + corrections

PWA offline:
- self contained bundle ~5mb
- full play (steps, hints popup, nav, coins, gifts)
- local validate + project

Client vs server:
- client authoritative for its snapshot
- server records facts only. No re-val correctness

Multi device:
- facts union by key
- deterministic project

Commerce:
- lifetime grant idempotent
- single quest v1
- events for grants

Constructor:
- lean form+list
- immediate structured: AnswerListEditor + live match test (exact client fn)
- 4 template picker
- per role comic zones
- nav config
- anim/voice flags
- popup hint wiring
- visual gates + pre publish checklist
- publish = exact bundle shape
- test in real player ok

Migration:
- synthetic legacy snapshots
- facts from old data
- one time idempotent job