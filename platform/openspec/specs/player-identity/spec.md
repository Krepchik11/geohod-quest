# player-identity Specification

## Purpose
TBD - created by archiving change player-identity-live-commerce. Update Purpose after archive.
## Requirements
### Requirement: Anonymous identity is device-bound, client-minted, and requires no network
The client SHALL mint a device UUID v4 exactly once and persist it in `localStorage['geohod-device-id:v1']`; the anonymous player id SHALL be `dev:<uuid>`. Identity SHALL exist before any network call (a fresh device can play an available bundle fully offline). All player-scoped flows (checkout, attempts, bundles, grants visibility, profile) SHALL use the current player id from a single identity module — no hardcoded player literals in app code. The server SHALL treat anonymous player ids as opaque and SHALL NOT require a server round-trip to issue them.

#### Scenario: Fresh device mints one stable id and plays anonymously
- **WHEN** a fresh browser opens the app, buys a quest, and creates an attempt — then reloads and repeats an action
- **THEN** exactly one device UUID is minted and reused across reloads; the grant and attempt are keyed to `dev:<uuid>`; no registration or login was required at any point.

#### Scenario: Identity module is the single source for player id
- **WHEN** any page (commerce, my-quests, quest-detail, player, profile, landing) needs the player id
- **THEN** it obtains it from the identity module (`currentPlayerId()`); no occurrence of a hardcoded demo player id remains in app page/component code.

### Requirement: Email registration attaches credentials to the existing player id with zero data migration
`POST /api/auth/register` SHALL accept `{player_id, email, password, display_name?}` where `player_id` is the caller's current anonymous id, create a players record whose primary key IS that player_id with the email (unique) and an argon2 password hash, create a session, and return `{player_id, email, token}`. Confirmation is soft (v2 §6.3): registration SHALL send a best-effort confirmation email and the account SHALL work immediately; consuming the mailed token sets `email_confirmed_at`, and password recovery is offered only for confirmed emails. Recovery mail SHALL carry two single-use credentials sharing one attempt-capped store row — the reset link token and an email-scoped 6-digit code (v2 §6.2 R1+R2) — and `POST /api/auth/reset` SHALL accept either `{token, password}` or `{email, code, password}`. Emails SHALL be canonicalized (trimmed, lowercased) at every auth boundary so one mailbox maps to one account regardless of caller casing. Registration SHALL NOT change the player_id: all prior grants, attempts, facts, and bonus awards remain keyed and accessible unchanged. Duplicate email or an already-registered player_id SHALL be rejected with 409 and no partial state.

#### Scenario: Registration preserves prior anonymous purchases and progress
- **WHEN** an anonymous player buys a quest, plays facts (earning coins), then registers with email and password
- **THEN** registration succeeds returning a token for the SAME player_id; the existing grant still authorizes attempts; projected balance and completed steps are unchanged; the profile shows the email.

#### Scenario: Duplicate email rejected atomically
- **WHEN** a second (different) player registers with an email already taken
- **THEN** the server responds 409, no players row or session is created for the second caller, and the first account is unaffected.

### Requirement: Email login returns the account identity and a fresh session; the device adopts it
`POST /api/auth/login` SHALL accept `{email, password}`, verify the password against the stored argon2 hash, and on success create and return a fresh session token plus the account's `player_id` and email. The client SHALL store the session (`localStorage['geohod-session:v1']`) and use the account player_id as the current identity from then on; logout SHALL clear the session and revert to the device's anonymous id. Wrong password or unknown email SHALL yield 401 with no session.

#### Scenario: Second device continues the account
- **WHEN** a player registers on device A (with purchases), then logs in with the same email/password on device B
- **THEN** device B receives device A's player_id and a fresh token; listing grants / creating attempts on device B operates on the same account (purchases visible, completion-bonus once-ever still enforced across devices).

#### Scenario: Wrong password yields 401 and no session
- **WHEN** login is attempted with a registered email but a wrong password
- **THEN** the response is 401, no session token is issued, and no session row is created.

### Requirement: Registered identities require a valid session token for player-scoped actions; anonymous identities are device-credentialed
For player-scoped endpoints (checkout, attempt creation, bundle download, `GET /api/players/me`, `GET /api/players/me/stats`) the server SHALL resolve identity as: a valid `Authorization: Bearer <token>` wins and yields the session's player_id; otherwise the claimed player_id is accepted ONLY if it has no registered account — a claimed player_id belonging to a registered account without a valid token SHALL be rejected with 401. Sessions SHALL be opaque random tokens stored server-side, identical behavior on both storage backends. Facts append remains attempt-scoped (the attempt already binds the player) and SHALL NOT require a token.

#### Scenario: Spoofing a registered account without a token is rejected
- **WHEN** player X registers, and afterwards a tokenless request claims X's player_id for checkout or attempt creation
- **THEN** the server responds 401; with X's valid Bearer token the same request succeeds; anonymous (never-registered) player ids continue to work tokenless exactly as before.

#### Scenario: Pre-registration offline attempts still sync after registration
- **WHEN** an attempt was created while anonymous, the player registers, and queued facts for that attempt are later flushed
- **THEN** the facts append succeeds (attempt-scoped, no token demanded) and projections include them exactly once.

