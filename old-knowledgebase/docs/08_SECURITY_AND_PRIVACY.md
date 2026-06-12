# Security & Privacy

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
