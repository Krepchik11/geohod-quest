# GeoQuest — Executive Summary

> 🇷🇺 **Русская документация:** [`docs/ru/README.md`](./ru/README.md)

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
| Data types | 47 |
| Pages | 10 |
| Reusable element definitions | 51 |
| Total workflows | 1163 |
| Backend API workflows | 17 |
| Database trigger workflows | 5 |
| Option sets (enums) | 12 |
| Data API accessible types | 7 / 54 |

## Live data volumes (test branch, via API)

| Type | Records |
|------|---------|
| `user` | 929 |
| `page` | 556 |
| `page_constructor` | 556 |
| `quest` | 21 |
| `quest_name_constructor` | 21 |
| `upload_file` | 2 |
| `no_buy` | 0 |

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
