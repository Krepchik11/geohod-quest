# Application Overview

## App metadata

| Field | Value |
|-------|-------|
| App ID | `geoquest` |
| Branch | `test` (test/dev) |
| Live URL | `https://geoquest.bubbleapps.io` |
| Test URL | `https://geoquest.bubbleapps.io/version-test` |
| Creation date | 1669452336835 |

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
