#!/usr/bin/env python3
"""Generate migration documentation from parsed discovery data."""
import json
from pathlib import Path
from collections import Counter, defaultdict

ROOT = Path(__file__).resolve().parents[2]
PARSED = ROOT / "discovery" / "parsed"
RAW = ROOT / "discovery" / "raw"
DOCS = ROOT / "docs"


def load(name):
    with open(PARSED / name) as f:
        return json.load(f)


def write_doc(name, content):
    path = DOCS / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print(f"Wrote {path}")


def main():
    app = load("app.json")
    data_types = load("data_types.json")
    pages = load("pages.json")
    api_events = load("api_events.json")
    option_sets = load("option_sets.json")
    elem_defs = load("element_definitions.json")

    with open(PARSED / "workflows_all.json") as f:
        workflows = json.load(f)

    probe = []
    probe_path = RAW / "data-api" / "probe_results.json"
    if probe_path.exists():
        with open(probe_path) as f:
            probe = json.load(f)

    counts = {}
    counts_path = RAW / "data-api" / "record_counts.json"
    if counts_path.exists():
        with open(counts_path) as f:
            counts = json.load(f)

    accessible = [p for p in probe if p.get("accessible")]
    inaccessible = [p for p in probe if not p.get("accessible")]

    wf_by_type = Counter(w["type"] for w in workflows)
    actions = Counter()
    for w in workflows:
        for a in w.get("actions", []):
            actions[a["type"]] += 1

    api_wf = [e for e in api_events if e.get("type") == "APIEvent"]
    db_triggers = [e for e in api_events if e.get("type") == "DatabaseTriggerEvent"]

    # --- Executive Summary ---
    write_doc("00_EXECUTIVE_SUMMARY.md", f"""# GeoQuest — Executive Summary

> **Source:** `geoquest.bubble` (test branch) + Bubble Data API (read-only)  
> **Date:** 2026-06-08  
> **Environment probed:** `https://geoquest.bubbleapps.io/version-test`

## What is GeoQuest?

**GeoQuest** (also branded **Geohod** / **Geoquest**) is a location-based **quest adventure platform** with:

- Interactive quest pages (questions, hints, maps, video, gifts)
- Multi-language support (RU, EN, SRB)
- User roles: Admin, Author, Client
- Event/calendar booking system (separate from core quests)
- **Telegram** login / WebApp integration
- **YooKassa** (ЮKassa) payment processing for quest purchases
- Admin panel for content management

## Scale

| Metric | Count |
|--------|-------|
| Data types | {len(data_types)} |
| Pages | {len(pages)} |
| Reusable element definitions | {len(elem_defs)} |
| Total workflows | {len(workflows)} |
| Backend API workflows | {len(api_wf)} |
| Database trigger workflows | {len(db_triggers)} |
| Option sets (enums) | {len(option_sets)} |
| Data API accessible types | {len(accessible)} / {len(probe)} |

## Live data volumes (test branch, via API)

| Type | Records |
|------|---------|
{chr(10).join(f'| `{k}` | {v} |' for k, v in sorted(counts.items(), key=lambda x: -x[1]))}

## Migration complexity: **Very High**

- 1,163 workflows — mostly UI state machine logic (SetCustomState, Show/Hide)
- Dual product surface: **Quest engine** + **Event calendar**
- 6 external API connectors (payments, Telegram, Google)
- Only 7 of 47 data types exposed via Data API — schema comes primarily from `.bubble` file
- Password/auth migration requires reset flow

## Critical paths (P0)

1. Telegram OAuth login (`telegram_auth`, `telegramOath`, `login_telegram_webapp` page)
2. Quest gameplay flow (`quest` page → `page_constructor` data → answer cards)
3. YooKassa payment webhook (`yKassa` API workflow)
4. User management & roles
5. Multi-language content (RU/EN/SRB fields throughout)

## Top risks

1. **40 data types not in Data API** — need CSV export from Bubble editor or enable types in API settings
2. **Workflow logic is UI-coupled** — 444 `SetCustomState` actions must become React state
3. **Payment webhook** — must replicate `yKassa` exactly before cutover
4. **No password export** — users must re-auth via Telegram or reset password
5. **API token exposed in chat** — rotate immediately after discovery

## Recommended migration phases

1. **Phase 1:** Data model + PostgreSQL + auth (Telegram)
2. **Phase 2:** Quest player (index → quest → page flow)
3. **Phase 3:** Payments (YooKassa) + subscriptions
4. **Phase 4:** Admin panel + content CMS
5. **Phase 5:** Event calendar module
""")

    # --- Application Overview ---
    write_doc("01_APPLICATION_OVERVIEW.md", f"""# Application Overview

## App metadata

| Field | Value |
|-------|-------|
| App ID | `{app['id']}` |
| Branch | `{app['version']}` (test/dev) |
| Live URL | `https://geoquest.bubbleapps.io` |
| Test URL | `https://geoquest.bubbleapps.io/version-test` |
| Creation date | {app.get('creation_date', 'N/A')} |

## Product domains

### 1. Quest system (core)

Users complete geographic quests composed of **pages** (`page_constructor` / `page` data types) linked to a **Quest** (`quest_name_constructor`).

Page types (option set `Page_type`): Style, Hint, Continue, Gift, Error, Start, Video, Question.

Quest levels: Низкая / Средняя / Высокая.  
Quest status: Published / Test / Project.

### 2. Event calendar

Separate data model: `Event`, `Event_city`, `Event_price`, `Event_work_time`, etc.  
Managed primarily on `calendar` and `site` pages (299 combined workflows).

### 3. Commerce

- Quest purchases via YooKassa (`yKassa` webhook)
- Subscriptions (`buy_a_qest` / Subscription type)
- Coupons, basket, payment records

### 4. Identity & access

- Standard Bubble User type with `Role` option set (Admin, Author, Client)
- Telegram OAuth (`telegram_oath` connector, `telegram_auth` / `telegramOath` API workflows)
- Google auth connector
- Login link generation (`createloginlink`, `loginid`)

### 5. Admin

`admin` page — 9 workflows, 20 elements. Content authoring for quests and events.

## User roles

| Role | Purpose |
|------|---------|
| Admin | Full platform management |
| Author | Quest/event content creation |
| Client | End user playing quests / booking events |

## Languages

Option set `Language`: `ru_ru`, `en_us`, `sr_sp`  
Content fields follow pattern: `*_RU`, `*_ENG`, `*_SRB` on pages and quests.
""")

    # --- Data Model ---
    dt_rows = []
    for dt in data_types:
        fields = ", ".join(f["name"] for f in dt["fields"][:6])
        if len(dt["fields"]) > 6:
            fields += f" (+{len(dt['fields'])-6} more)"
        api_status = "✅ API" if any(p.get("typename") in (dt["id"], dt["api_typename_guess"]) and p.get("accessible") for p in probe) else "❌ schema only"
        count = counts.get(dt["id"], counts.get(dt["api_typename_guess"], "—"))
        dt_rows.append(f"| `{dt['id']}` | {dt['display']} | {len(dt['fields'])} | {api_status} | {count} |")

    write_doc("02_DATA_MODEL.md", f"""# Data Model

> Full field definitions: `discovery/parsed/data_types.json`

## Entity relationship (core quest domain)

```mermaid
erDiagram
    User ||--o{{ Quest : plays
    Quest ||--|{{ Page : contains
    Quest }}o--|| QuestSettings : configured_by
    Quest }}o--o{{ Tags : tagged
    Quest }}o--|| questCity : located_in
    Quest }}o--|| questCountry : located_in
    Quest ||--o{{ Review_quest : has
    User ||--o{{ Answer_card : submits
    Page ||--o{{ Answer_card : collects
```

## All data types ({len(data_types)})

| ID | Display name | Fields | API access | Record count |
|----|-------------|--------|------------|--------------|
{chr(10).join(dt_rows)}

## Key type details

### Quest (`quest_name_constructor` / API: `quest`)

Core product entity. Fields include: Page list, Quest_setting, Price, Preview_image, Users, Reviews, Tags, geo coordinates (placeStartLatitude/Longitude), statusQuest, reviewGrade, questCity, questCountry.

**API records (test):** {counts.get('quest', 'N/A')}

### Page / Page constructor (`page` / `page_constructor`)

Quest step content. Fields: Image, Text, Answers, Page_type, multilingual text fields (Main_text_RU/ENG/SRB, Button_text_*, Page_name_RU), Quest_name reference.

**API records (test):** {counts.get('page', 'N/A')} (page and page_constructor return same dataset)

### User (`user`)

Fields: username, Role, Edit_language, Previe_language, authentication object, user_signed_up.

**API records (test):** {counts.get('user', 'N/A')}

### Event (`event`)

Tour/calendar events with: Name, Duration, Description, seats, Workday, photos, city/country/type, pricing, program, work times, meeting point, FAQ, Q&A.

**API:** Not enabled — schema from `.bubble` file only.

### Subscription (`buy_a_qest`)

Quest purchase/subscription records.

### Payment (`payment`)

Payment transaction log (linked to YooKassa flow).

## Option sets (enums)

{chr(10).join(f'### {o["display"]} (`{o["id"]}`)' + chr(10) + chr(10).join(f'- `{v.get("db_value", v["display"])}` — {v["display"]}' for v in o["values"]) + chr(10) for o in option_sets)}
""")

    write_doc("03_DATA_MANAGEMENT.md", f"""# Data Management

## API-accessible types (test branch)

Only these types are enabled in Bubble Data API settings:

| Type | Records | Notes |
|------|---------|-------|
{chr(10).join(f"| `{a['typename']}` | {counts.get(a['typename'], a.get('remaining', 0) + a.get('count', 0))} | Fields: {', '.join(list(a.get('fields', {}).keys())[:8])} |" for a in accessible)}

## Types NOT in Data API ({len(inaccessible)} types)

These exist in the app schema (`.bubble` file) but return `404 Type not found` via API:

{', '.join(f'`{p["typename"]}`' for p in inaccessible[:30])}{'...' if len(inaccessible) > 30 else ''}

**Action required for full data migration:** In Bubble editor → Settings → API → enable each type, OR export via Data → App data → CSV/JSON/NDJSON per type.

## Data export strategy

### Via API (current)
```bash
GET https://geoquest.bubbleapps.io/version-test/api/1.1/obj/{{typename}}?cursor=0&limit=100
Authorization: Bearer <ADMIN_TOKEN>
```

Paginate until `remaining == 0`. Max 100 records/request, 50k cap per type.

### Via Bubble editor (recommended for disabled types)
1. Data → App data
2. Select type → Export → NDJSON
3. Store in `discovery/raw/exports/`

## Referential integrity notes

- Bubble stores relations as unique IDs (`1234567890x123456789012345678`)
- Lists are arrays of IDs or embedded objects
- `page` and `page_constructor` appear to mirror the same 556 records via API
- `quest` and `quest_name_constructor` mirror 21 records

## PII fields

- `user`: username, authentication (email)
- Payment/webhook data in `yKassa` workflow samples
- Redact before committing raw exports to git
""")

    write_doc("04_API_SURFACE.md", f"""# API Surface

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
{chr(10).join(f"| `{e.get('wf_name', '?')}` | {e['type']} | {e.get('action_count', 0)} | See parsed/api_events.json |" for e in api_events)}

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
""")

    # Group workflows by page
    page_wf = defaultdict(int)
    for w in workflows:
        path = w.get("source_path", "")
        if path.startswith("pages/"):
            parts = path.split("/")
            if len(parts) > 1:
                page_wf[parts[1]] += 1

    page_map = {p["id"]: p["name"] for p in pages}
    wf_page_lines = []
    for pid, cnt in sorted(page_wf.items(), key=lambda x: -x[1]):
        wf_page_lines.append(f"| `{page_map.get(pid, pid)}` | {cnt} |")

    write_doc("05_WORKFLOWS_AND_BUSINESS_LOGIC.md", f"""# Workflows & Business Logic

> Full workflow dump: `discovery/parsed/workflows_all.json` (1,163 entries)

## Summary

| Event type | Count |
|------------|-------|
{chr(10).join(f'| `{t}` | {c} |' for t, c in wf_by_type.most_common())}

## Top action types

| Action | Count | Rust/Next.js mapping |
|--------|-------|---------------------|
{chr(10).join(f'| `{t}` | {c} | {"React useState/useReducer" if t == "SetCustomState" else "Conditional render" if t in ("ShowElement", "HideElement") else "DB UPDATE" if t == "ChangeThing" else "router.push" if t == "ChangePage" else "INSERT" if t == "NewThing" else "Job queue" if t == "ScheduleAPIEvent" else "Service call"} |' for t, c in actions.most_common(20))}

## Workflows by page

| Page | Workflow count |
|------|---------------|
{chr(10).join(wf_page_lines)}

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
""")

    write_doc("06_PAGES_AND_USER_JOURNEYS.md", f"""# Pages & User Journeys

## Pages

| Page | ID | Workflows | Elements | Next.js route (proposed) |
|------|----|-----------|----------|-------------------------|
{chr(10).join(f"| `{p['name']}` | `{p['id']}` | {p['workflow_count']} | {p['element_count']} | {('/' + p['name']) if p['name'] not in ('index',) else '/'} |" for p in pages)}

## Reusable components (element definitions)

| Name | Type | Group type | Workflows |
|------|------|------------|-----------|
{chr(10).join(f"| {e.get('name', '?')} | {e.get('type', '?')} | `{e.get('group_type', '')}` | {e['workflow_count']} |" for e in elem_defs[:30])}
{'| ... | | | |' if len(elem_defs) > 30 else ''}

## Critical user journey: Play a quest

```mermaid
flowchart TD
    A[index / site] --> B{{Logged in?}}
    B -->|No| C[login_telegram_webapp]
    C --> D[telegram_auth API]
    B -->|Yes| E[Select quest on site]
    E --> F[quest page]
    F --> G[Load page_constructor steps]
    G --> H{{Page type?}}
    H -->|Question| I[Submit answer]
    H -->|Hint| J[Show hint image]
    H -->|Gift| K[Gift reveal]
    I --> L[addAnswerCard API]
    L --> G
    G -->|Complete| M[Review / completion]
```

## Critical user journey: Buy a quest

```mermaid
flowchart TD
    A[site - quest detail] --> B[Initiate payment]
    B --> C[YooKassa checkout]
    C --> D[yKassa webhook]
    D --> E[Create/update Subscription]
    E --> F[Unlock quest for User]
```
""")

    write_doc("07_INTEGRATIONS.md", """# Integrations

## Payment providers

| Service | Connector | Workflow | Notes |
|---------|-----------|----------|-------|
| YooKassa (ЮKassa) | `Юкасса` | `yKassa` | Primary — webhook handles `payment.succeeded` |
| YooMoney | `Yoomoney` | — | Secondary payment option |
| Crypto Cloud | `Crypto_Cloud` | — | Crypto payments |

## Authentication

| Service | Connector | Workflows | Pages |
|---------|-----------|-----------|-------|
| Telegram | `telegram_oath` | `telegram_auth`, `telegramOath` | `login_telegram_webapp` |
| Google | `Google_auth` | OAuthLogin actions | — |

## Automation

| Service | Connector | Purpose |
|---------|-----------|---------|
| Make (Integromat) | `Integromat Sheet Google` | Google Sheets sync |

## Email

Bubble SendGrid integration enabled (`use_sendgrid` in app settings).

## Maps

`Leafy_map` data type + geo fields on Quest (placeStartLatitude/Longitude) — likely Leaflet/map plugin.

## Rust migration: suggested crates

| Integration | Crate |
|-------------|-------|
| YooKassa | Custom REST client or `yookassa` community crate |
| Telegram WebApp auth | HMAC-SHA256 validation of initData |
| Google OAuth | `oauth2` |
| SendGrid | `sendgrid` |
| PostgreSQL | `sqlx` |
| Job queue | `apalis` + Redis |
""")

    write_doc("08_SECURITY_AND_PRIVACY.md", """# Security & Privacy

## Authentication methods

1. **Bubble native** — email/password SignUp/LogIn
2. **Telegram WebApp** — primary for mobile users
3. **Google OAuth** — via API Connector
4. **Magic login links** — `createloginlink` workflow

## Role-based access

Option set `Role`: Admin, Author, Client

Workflows use role checks via `Current User's Role` conditions (see ConditionTrue workflows — 156 total).

## API security

- Admin bearer token required for Data API on test branch
- Live branch returned 401 — separate API permissions per branch
- API workflows have individual auth settings (none / user / admin)
- `yKassa` webhook: parameter_def auto-detected from YooKassa payload

## Privacy rules

Stored in `.bubble` per data type (`privacy_role` in parsed data). **Not fully extracted** — requires deeper `.bubble` parse of each type's privacy_role conditions.

**Migration action:** Reimplement row-level security in Rust middleware:
- Users see only their own subscriptions, answer cards, progress
- Authors see their quests
- Admins see all

## Sensitive data

- User `authentication` object (email) — never log
- Payment card metadata in YooKassa webhook samples
- Telegram user IDs in OAuth flows

## Immediate security action

**Rotate the admin API token** — it was shared in chat during discovery.
""")

    write_doc("10_MIGRATION_MAPPING.md", f"""# Migration Mapping — Bubble → Rust + Next.js

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
""")

    write_doc("APPENDIX/OPEN_QUESTIONS.md", """# Open Questions

1. **Which branch is production?** Discovery used `version-test`. Confirm live data export plan.
2. **Why do `page` and `page_constructor` return identical API data?** Clarify canonical type for migration.
3. **Same for `quest` vs `quest_name_constructor`** — use one table?
4. **40 data types disabled in Data API** — can you enable them in Settings → API for full export?
5. **Plugin `1653841096163x959466670591574000-AAH`** — identify which plugin (41 workflow actions).
6. **Plugin `1488796042609x768734193128308700-AAg`** — identify (31 actions).
7. **Custom domain?** `app_topdomain` in settings — is there a production domain beyond bubbleapps.io?
8. **Crypto Cloud / YooMoney** — still active or deprecated in favor of YooKassa only?
9. **chatbot workflow** — what external service does it connect to?
10. **Rotate API token** — was exposed during discovery session.
""")

    write_doc("APPENDIX/RAW_INDEX.md", """# Raw Data Index

| Claim | Source file |
|-------|-------------|
| App metadata | `discovery/parsed/app.json` |
| 47 data type schemas | `discovery/parsed/data_types.json` |
| 12 option sets | `discovery/parsed/option_sets.json` |
| 10 pages | `discovery/parsed/pages.json` |
| 22 backend API events | `discovery/parsed/api_events.json` |
| 52 reusable elements | `discovery/parsed/element_definitions.json` |
| 1,163 workflows | `discovery/parsed/workflows_all.json` |
| Data API probe | `discovery/raw/data-api/probe_results.json` |
| Record counts | `discovery/raw/data-api/record_counts.json` |
| Workflow API probe | `discovery/raw/workflow-api/probe_results.json` |
| Original export | `geoquest.bubble` (5.5 MB) |
""")

    print("All docs generated.")


if __name__ == "__main__":
    main()