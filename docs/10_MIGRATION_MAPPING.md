# Migration Mapping — Bubble → Rust + Next.js

## Architecture target

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────┐
│   Next.js App   │────▶│  Rust API (Axum) │────▶│ PostgreSQL │
│   (App Router)  │     │  + job workers   │     │            │
└─────────────────┘     └──────────────────┘     └────────────┘
         │                        │
         │                        ├── YooKassa webhooks
         │                        ├── Telegram auth
         │                        └── SendGrid email
```

## Data type mapping

| Bubble type | PostgreSQL table | Priority |
|-------------|-----------------|----------|
| user | users | P0 |
| quest_name_constructor | quests | P0 |
| page_constructor | quest_pages | P0 |
| answer_card | answer_cards | P0 |
| buy_a_qest | subscriptions | P0 |
| payment | payments | P0 |
| review_quest | quest_reviews | P1 |
| questCity / questCountry | cities, countries | P1 |
| event + related types | events, event_* | P2 |
| settings | app_settings | P1 |

## Page mapping

| Bubble page | Next.js route | Complexity |
|-------------|--------------|------------|
| index | `/` | Medium |
| site | `/site` or `/catalog` | High (183 WFs) |
| quest | `/quest/[id]` | Very High (82 WFs) |
| calendar | `/calendar` | High |
| admin | `/admin` | High |
| login_telegram_webapp | `/auth/telegram` | Medium |
| reset_pw | `/auth/reset` | Low |

## Workflow → service mapping

| Bubble pattern | Rust implementation |
|----------------|-------------------|
| APIEvent `yKassa` | `POST /webhooks/yookassa` handler |
| APIEvent `telegram_auth` | `POST /auth/telegram` |
| APIEvent `addAnswerCard` | `POST /quests/:id/answers` |
| ScheduleAPIEvent | Background job (Redis queue) |
| DatabaseTriggerEvent | DB trigger or event handler |
| ChangeThing | SQL UPDATE via repository |
| NewThing | SQL INSERT |
| Do a search for | SQL SELECT with filters |

## State management mapping

444 `SetCustomState` actions → React component state:
- `closeImage`, `closeHintImage`, `prevPage` → `useQuestPlayer()` hook
- Show/Hide element → conditional rendering from state machine
- Page type transitions → quest player state machine enum

## What is already captured

| Artifact | Location |
|----------|----------|
| Full app structure | `geoquest.bubble` |
| Parsed indexes | `discovery/parsed/*.json` |
| All 1,163 workflows | `discovery/parsed/workflows_all.json` |
| API probe results | `discovery/raw/data-api/probe_results.json` |
| Record counts | `discovery/raw/data-api/record_counts.json` |
| Workflow API probes | `discovery/raw/workflow-api/probe_results.json` |

## What still needs manual export

- [ ] CSV/NDJSON export for 40 data types not in Data API
- [ ] Live branch data (current discovery used test branch)
- [ ] Privacy rules deep parse
- [ ] Plugin action detail (41x plugin `1653841096163x...` actions)
- [ ] File/image assets download from Bubble CDN URLs
