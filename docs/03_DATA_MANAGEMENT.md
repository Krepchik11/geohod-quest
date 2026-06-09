# Data Management

## API-accessible types (test branch)

Only these types are enabled in Bubble Data API settings:

| Type | Records | Notes |
|------|---------|-------|
| `no_buy` | 0 | Fields:  |
| `page` | 556 | Fields: Modified Date, Created Date, Created By, Image_link, Page_type, Main_text_RU, Page_name_RU, Button_text_RU |
| `page_constructor` | 556 | Fields: Modified Date, Created Date, Created By, Image_link, Page_type, Main_text_RU, Page_name_RU, Button_text_RU |
| `quest` | 21 | Fields: Modified Date, Created Date, Created By, Page, Quest_setting, Quest_name_ru, Users, Preview_image |
| `quest_name_constructor` | 21 | Fields: Modified Date, Created Date, Created By, Page, Quest_setting, Quest_name_ru, Users, Preview_image |
| `upload_file` | 2 | Fields: Modified Date, Created Date, Created By, Url, _id |
| `user` | 929 | Fields: Modified Date, Created Date, user_signed_up, username, authentication, Edit_language, Previe_language, Role |

## Types NOT in Data API (47 types)

These exist in the app schema (`.bubble` file) but return `404 Type not found` via API:

`advantage`, `answer_card`, `basket_buy`, `bug_report`, `buy_a_qest`, `city`, `country`, `coupon`, `deleteid`, `event`, `event_city`, `event_country`, `event_faq_item`, `event_included_in_cost`, `event_meeting_point`, `event_parameter`, `event_price`, `event_program_item`, `event_programm`, `event_question_and_answer`, `event_type`, `event_work_time`, `event_worktime_item`, `faq_item`, `fourquestion`, `leafy_map`, `no_buy_a_quest`, `numberofusers`, `payment`, `questcity`...

**Action required for full data migration:** In Bubble editor → Settings → API → enable each type, OR export via Data → App data → CSV/JSON/NDJSON per type.

## Data export strategy

### Via API (current)
```bash
GET https://geoquest.bubbleapps.io/version-test/api/1.1/obj/{typename}?cursor=0&limit=100
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
