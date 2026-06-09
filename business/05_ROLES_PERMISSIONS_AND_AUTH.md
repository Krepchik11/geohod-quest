# Roles, Permissions, and Authentication (Business Concept v0.1)

## Locked Decisions from Clarifications

- Only **Administrator** role for content creation and platform management. No "Author" role (internal team only, and no need to distinguish within the team for permissions at this stage).
- Players (end users) have no authoring rights.
- Telegram is **not primary**.
- Authors (now just Admins) do **not** need separate strong auth.
- Magic links and password reset flows are **not required** to support for existing users.
- Clean slate on legacy auth mechanisms where possible.

## Business Roles (Simple)

1. **Administrator** (internal team)
   - Full access to quest constructor (create/edit/publish quests and steps).
   - Access to admin views: purchases, grants, attempts, reviews, coupons, user list (basic), stats.
   - Can create manual grants and coupons.
   - Can manage published quests (unpublish, edit content with awareness of existing players).

2. **Player**
   - Browse catalog.
   - Purchase (or get free/coupon) → receive AccessGrant.
   - Download quests for offline.
   - Play (create attempts, submit answers/tasks, spend coins on hints, reset progress on their own attempts).
   - Write reviews after completion.
   - View their own collection, progress, and past attempts.

No other roles for v1.

## Authentication Approach (Minimal)

Because we are dropping magic links, heavy Telegram dependency for new users, and password reset for existing, we need a clean primary mechanism.

**MVP decision (locked):**
- Email + password only for login (Players and Administrators) for the initial version.
- Other methods (OAuth providers, Telegram, passwordless, etc.) are explicitly post-MVP additions.
- This gives a clean, simple auth surface for the rebuild. Existing users will re-authenticate with email/password (or we create accounts during import if we have emails from the old data).

**Migration note:** Old passwords cannot be imported. Historical grants and attempts can be attached to new or imported user records during data migration.

**Migration for existing ~929 test users:**
- We do not need to preserve old passwords (impossible anyway).
- We do not need to support old magic links.
- Best path: On next interaction, users re-authenticate via the new primary method. If we support Telegram login, users who previously used Telegram WebApp can be auto-linked by Telegram user ID.
- Purchases/grants/attempts can be migrated by matching on old identifiers if we export the data.

## Permissions (High Level, Enforced Server-Side)

- All quest content changes and grant-creating actions require an authenticated Administrator.
- All play actions (create attempt, submit completion, spend coin) require an authenticated Player who holds the relevant AccessGrant (or the quest is free).
- Downloading a playable bundle requires a valid grant.
- Player can only see and mutate their own attempts and grants.
- No "ignore privacy rules" equivalent — row-level ownership is explicit in the model.

## What We Cut

- Leaked UI state on the User record (`closePopup`, `deleteUser`, `current_lat` as persistent field, etc.).
- Multiple overlapping auth methods as first-class (Google connector, old Bubble native, multiple API workflows for login).
- "Role" option set with Admin/Author/Client — now just Admin vs Player (or implicit).

## Open Auth Questions

- What is the **primary** login method for new players? (email+pass, passwordless email code, Telegram as main, phone, anonymous device-bound?)
- Do Administrators use the same identity system as Players, or a completely separate (even simpler) admin login?
- Do we need "invite only" or public registration for players?
- For PWA offline: does the player need to be logged in to play an already-downloaded quest, or can a local attempt be associated later? (Strongly prefer "login at download or first play" to keep ownership clear.)
- Any rate limiting, brute force, or session rules that matter conceptually?

## Self-Critique

Dropping Telegram as primary may lose convenience for the mobile audience that the old system targeted. If most real usage came through Telegram WebApp, forcing email signup could be a conversion killer. We need data or a decision here.

The "only Administrator" simplification is excellent for ACL — one of the few areas where the old system was over-modeled for no gain.
