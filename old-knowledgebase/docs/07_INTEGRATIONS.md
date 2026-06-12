# Integrations

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
