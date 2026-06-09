# Workflows & Business Logic

> Full workflow dump: `discovery/parsed/workflows_all.json` (1,163 entries)

## Summary

| Event type | Count |
|------------|-------|
| `ButtonClicked` | 839 |
| `ConditionTrue` | 156 |
| `InputChanged` | 110 |
| `CustomEvent` | 20 |
| `APIEvent` | 15 |
| `PageLoaded` | 12 |
| `DatabaseTriggerEvent` | 5 |
| `PopupClosed` | 3 |
| `LoggedOut` | 2 |
| `DoInterval` | 1 |

## Top action types

| Action | Count | Rust/Next.js mapping |
|--------|-------|---------------------|
| `SetCustomState` | 444 | React useState/useReducer |
| `HideElement` | 358 | Conditional render |
| `ShowElement` | 349 | Conditional render |
| `ChangeThing` | 277 | DB UPDATE |
| `ChangePage` | 231 | router.push |
| `DisplayGroupData` | 66 | Service call |
| `AnimateElement` | 56 | Service call |
| `NewThing` | 48 | INSERT |
| `ResetInputs` | 48 | Service call |
| `1653841096163x959466670591574000-AAH` | 41 | Service call |
| `ScrollToElement` | 38 | Service call |
| `1488796042609x768734193128308700-AAg` | 31 | Service call |
| `ResetGroup` | 26 | Service call |
| `ScheduleAPIEvent` | 24 | Job queue |
| `OpenURL` | 24 | Service call |
| `MakeChangeCurrentUser` | 20 | Service call |
| `TriggerCustomEvent` | 20 | Service call |
| `PauseWFClient` | 18 | Service call |
| `DeleteThing` | 16 | Service call |
| `SignUp` | 15 | Service call |

## Workflows by page

| Page | Workflow count |
|------|---------------|
| `site` | 183 |
| `calendar` | 116 |
| `quest` | 82 |
| `index` | 71 |
| `test` | 12 |
| `admin` | 9 |
| `reset_pw` | 3 |
| `login_telegram_webapp` | 2 |

## Business process domains

### Quest gameplay (quest page — 82 workflows)
- Load quest by URL param / data
- Navigate between page_constructor steps
- Handle answers (InputChanged → validate → ChangeThing on Answer_card)
- Show/hide hints, images, gift pages
- Track progress via custom states

### Site browsing (site page — 183 workflows)
- Quest catalog / filtering by city, tags, level
- Event listing
- Language switching (RU/EN/SRB)
- Navigation to quest detail / calendar

### Calendar (calendar page — 116 workflows)
- Event CRUD display
- Work time slot management
- Booking flow
- Triggers backend `Change_event_work_time` database workflows

### Index / landing (index page — 71 workflows)
- Entry point / Geohod branding
- Auth state detection
- Redirect logic

### Payments (backend — yKassa)
- Receives YooKassa webhook POST
- Parses payment.succeeded
- Updates Subscription/Payment records
- Grants quest access

### Authentication (backend + login_telegram_webapp)
- `telegram_auth` / `telegramOath` — validate Telegram WebApp init data
- `createloginlink` — magic link auth
- `SignUp` / `LogIn` / `OAuthLogin` actions in frontend workflows
