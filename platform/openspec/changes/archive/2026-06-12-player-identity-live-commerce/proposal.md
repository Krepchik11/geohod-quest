# Proposal: player-identity-live-commerce

## Why

Every player-facing flow today is hardcoded to the literal `'demo-player'` identity (commerce, my-quests, player, quest-detail, profile). The product requirements demand: (1) anonymous play with no registration — identity bound to a device id; (2) optional registration by email (no confirmation) that preserves all progress, coins, and purchases; (3) a marketplace where any published quest can be bought with a mocked payment provider behind a real interface; (4) live player statistics on the profile per design. Without a real identity primitive the marketplace, statistics, and multi-device story cannot function, and the MVP is not "fully functional".

This adapts the original P5 plan (Telegram auth) to the owner's updated requirement: **email registration instead of Telegram**, anonymous-first. The locked decision "pre-auth identity = client device UUID in `localStorage['geohod-device-id:v1']`" stands; only the linking target changes (email account, not tg_id).

## What Changes

### New capability: `player-identity`
- **Anonymous identity**: client mints a device UUID v4 once, stores it in `localStorage['geohod-device-id:v1']`; the anonymous player id is `dev:<uuid>`. No server round-trip is required to obtain identity (offline-first invariant: identity exists before any network).
- **Email registration** (`POST /api/auth/register`): attaches `email` + `password` (argon2 hash) to the caller's existing anonymous player id — the player_id NEVER changes on registration, so all grants, attempts, facts, and bonus-award keys survive with zero migration. No email confirmation. Returns a session token.
- **Email login** (`POST /api/auth/login`): verifies credentials, returns the account's player_id + a fresh session token; the logging-in device adopts that player_id. (Local anonymous progress on that device stays local — documented cut, no auto-merge.)
- **Sessions**: opaque random tokens, stored server-side (`sessions` table / in-mem map). `GET /api/players/me` returns the profile.
- **Enforcement model (honest threat model)**: a player_id with a registered account REQUIRES a valid Bearer token for player-scoped actions (checkout, attempt creation, bundle, profile/stats). Anonymous player ids are credentialed by device possession alone (locked decision; mocked payments make this acceptable for MVP). This keeps the existing 14 shared scenarios (anonymous ids) valid.

### New capability: `player-stats`
- `GET /api/players/me/stats`: pure deterministic fold over ALL facts of ALL attempts belonging to the player + grants: signed coin balance (may be negative), personal rating (display floor 0 is client-side), quests completed (distinct quests with an `attempt_completed` fact), completed quest list, attempts/grants counts. Reuses existing projectors; no new fold semantics.
- Profile page goes live from this endpoint (falls back to the local-facts fold when offline/unreachable, labeled).

### Modified capability: `marketplace-grants`
- Checkout routes through a `PaymentProvider` trait with a `MockPaymentProvider` that always approves and returns a `payment_ref` recorded as the grant's `source_ref` (locked decision: "payment provider = stub behind interface"). Behavior of grants is unchanged (idempotent, source-audited).
- Marketplace page (`/commerce`) lists ALL published quests live from `GET /api/quests` with a per-quest buy button (mock payment), owned-state from grants, coupon flow retained.

### Frontend identity wiring
- New `lib/identity.ts` (device id, session storage `geohod-session:v1`, current player id, auth headers) — unit-tested.
- Every `'demo-player'` literal in app code replaced by the identity module: commerce, my-quests, quest-detail, landing checkout, player client.
- `/auth` page rewritten: email+password register/login (privacy-consent checkbox kept per design), logged-in state with logout; explanatory copy that registration is optional.

## Capabilities

### New
- `player-identity`: anonymous device-bound identity, email registration/login, sessions, enforcement for registered accounts.
- `player-stats`: per-player cross-attempt statistics as a pure fold, surfaced on the live profile.

### Modified
- `marketplace-grants`: checkout behind PaymentProvider interface (mock approves all); live multi-quest marketplace UI with buy buttons wired to real identity.

## Impact

- Backend: new `auth.rs` (+ argon2, rand deps), new migration `0002_auth.sql` (players, sessions), new routes, identity resolution in checkout/attempt/bundle handlers, `players`/`sessions` store methods on both backends (in-mem + Postgres), player-stats store gather + pure projector. Existing scenarios untouched (anonymous ids remain valid).
- Frontend: `lib/identity.ts` (new), `lib/api.ts` (auth headers + endpoints), pages: auth, commerce, profile, my-quests, quest-detail, landing, QuestPlayerClient.
- Tests: new backend scenarios (register/login/uniqueness/wrong-password/enforcement/stats) run on BOTH backends; vitest for identity lib; existing 36+56 stay green.
- Not in scope (explicit cuts, recorded): anonymous-progress merge on login, email confirmation, password reset, rate limiting, real payment provider, logout-everywhere, grants-list privacy filtering (admin surface unchanged).
