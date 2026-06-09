# API Surface

## Base URLs

| Environment | URL |
|-------------|-----|
| Live | `https://geoquest.bubbleapps.io` |
| Test/Dev | `https://geoquest.bubbleapps.io/version-test` |

Token works on **test** branch (live returns 401 for data API).

## Data API endpoints (enabled types)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/1.1/obj/user` | List users |
| GET | `/api/1.1/obj/page` | List quest pages |
| GET | `/api/1.1/obj/page_constructor` | List page constructors |
| GET | `/api/1.1/obj/quest` | List quests |
| GET | `/api/1.1/obj/quest_name_constructor` | List quests (alias) |
| GET | `/api/1.1/obj/upload_file` | List uploaded files |
| GET | `/api/1.1/obj/no_buy` | List no-buy records (empty) |

## Backend API workflows

| Workflow name | Type | Actions | Purpose (inferred) |
|---------------|------|---------|-------------------|
| `Change_event_work_time (Middle)` | DatabaseTriggerEvent | 1 | See parsed/api_events.json |
| `Change_event_work_time (empty)` | DatabaseTriggerEvent | 1 | See parsed/api_events.json |
| `Change_event_work_time (Full)` | DatabaseTriggerEvent | 1 | See parsed/api_events.json |
| `Change_event_work_time (Empty)` | DatabaseTriggerEvent | 1 | See parsed/api_events.json |
| `Change_event_work_time (Middle)` | DatabaseTriggerEvent | 1 | See parsed/api_events.json |
| `yKassa` | APIEvent | 2 | See parsed/api_events.json |
| `create_answer_card_list` | APIEvent | 9 | See parsed/api_events.json |
| `addAnswerCard` | APIEvent | 2 | See parsed/api_events.json |
| `updateOldUser` | APIEvent | 8 | See parsed/api_events.json |
| `666` | APIEvent | 4 | See parsed/api_events.json |
| `666_copy` | APIEvent | 4 | See parsed/api_events.json |
| `deleteAnswerCard` | APIEvent | 1 | See parsed/api_events.json |
| `telegramOath` | APIEvent | 0 | See parsed/api_events.json |
| `loginid` | APIEvent | 8 | See parsed/api_events.json |
| `createloginlink` | APIEvent | 2 | See parsed/api_events.json |
| `telegram_auth` | APIEvent | 2 | See parsed/api_events.json |
| `Update_Old_User` | APIEvent | 2 | See parsed/api_events.json |
| `edit number` | APIEvent | 1 | See parsed/api_events.json |
| `reviewGrade` | APIEvent | 1 | See parsed/api_events.json |
| `chatbot` | APIEvent | 4 | See parsed/api_events.json |
| `None` | APIEvent | 0 | See parsed/api_events.json |
| `testeg` | APIEvent | 1 | See parsed/api_events.json |

### Key API workflows

| Name | Business function |
|------|-------------------|
| `yKassa` | YooKassa payment webhook — processes `payment.succeeded` events |
| `telegram_auth` | Telegram authentication handler |
| `telegramOath` | Telegram OAuth flow |
| `createloginlink` | Generate magic login links |
| `loginid` | Login by ID |
| `addAnswerCard` / `deleteAnswerCard` / `create_answer_card_list` | Quest answer tracking |
| `updateOldUser` / `Update_Old_User` | User migration/update |
| `reviewGrade` | Quest review rating |
| `chatbot` | Chatbot integration endpoint |

### Database triggers

5x `Change_event_work_time (*)` — auto-update event work time status (Full/Empty/Middle) when `event_work_time` records change.

## External API connectors (from .bubble)

| Connector | Purpose |
|-----------|---------|
| Google_auth | Google OAuth |
| Crypto_Cloud | Crypto Cloud payments |
| Yoomoney | YooMoney payments |
| Юкасса | YooKassa payments |
| telegram_oath | Telegram OAuth |
| Integromat Sheet Google | Google Sheets via Make/Integromat |
