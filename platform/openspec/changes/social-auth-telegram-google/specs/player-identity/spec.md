# player-identity

## MODIFIED Requirements

### Requirement: Email registration attaches credentials to the existing player id with zero data migration
`POST /api/auth/register` SHALL accept `{player_id, email, password, display_name?}` where `player_id` is the caller's current anonymous id, create a players record whose primary key IS that player_id with the email (unique) and an argon2 password hash, create a session, and return `{player_id, email, token}`. An account row MAY exist with a NULL email and/or NULL password_hash when it was created by a social provider (see the social sign-in requirement); the email UNIQUE constraint SHALL continue to hold for non-NULL emails. Confirmation is soft: registration SHALL send a best-effort confirmation email and the account SHALL work immediately. Emails SHALL be canonicalized (trimmed, lowercased) at every auth boundary. Registration SHALL NOT change the player_id: all prior grants, attempts, facts, and bonus awards remain keyed and accessible unchanged. Duplicate email or an already-registered player_id SHALL be rejected with 409 and no partial state.

#### Scenario: Registration preserves prior anonymous purchases and progress
- **WHEN** an anonymous player buys a quest, plays facts (earning coins), then registers with email and password
- **THEN** registration succeeds returning a token for the SAME player_id; the existing grant still authorizes attempts; projected balance and completed steps are unchanged; the profile shows the email.

#### Scenario: Duplicate email rejected atomically
- **WHEN** a second (different) player registers with an email already taken
- **THEN** the server responds 409, no players row or session is created for the second caller, and the first account is unaffected.

## ADDED Requirements

### Requirement: Social sign-in (Google, Telegram) reaches the same player_id via verified provider identities
The server SHALL support `POST /api/auth/google` (`{credential, player_id}`, `credential` = a Google Identity Services ID token) and `POST /api/auth/telegram` (`{id_token, player_id}`, `id_token` = the OpenID Connect ID token returned by Telegram's `telegram-login.js`). Both providers are OIDC ID tokens verified server-side against the provider's published JWKS before any account effect:

- **Google:** the ID token signature SHALL be verified against Google's JWKS (keys cached and refreshed per the response `Cache-Control`); `aud` SHALL equal the configured client id; `iss` SHALL be `accounts.google.com` or `https://accounts.google.com`; `exp` SHALL NOT have passed. The stable identity subject is the token `sub`.
- **Telegram:** the ID token signature SHALL be verified against Telegram's JWKS (`https://oauth.telegram.org/.well-known/jwks.json`), selecting the key by the token's `kid` and verifying with that key's algorithm (Telegram advertises RS256/ES256/EdDSA/ES256K); `aud` SHALL equal the configured bot client id; `iss` SHALL be `https://oauth.telegram.org`; `exp` SHALL NOT have passed. The stable identity subject is the `id` claim (the Telegram user id — the same value the legacy widget keyed on, so existing identities survive the switch). Telegram provides no email.

Each provider SHALL be fail-closed: when its client id is unconfigured (`GOOGLE_CLIENT_ID` / `TELEGRAM_CLIENT_ID` unset) the endpoint SHALL respond 501 and perform no account effect.

Resolution SHALL be link-or-create, and SHALL preserve the anonymous player_id (zero data migration) whenever it creates:
1. If the verified `(provider, subject)` already maps to an account, return a fresh session for THAT account (login from any device).
2. Else, if the caller presents a valid Bearer session, link the new identity to that account.
3. Else, for Google only, if the token's email is verified and matches an existing account's email, link to that account.
4. Else, attach the identity to the caller's claimed anonymous `player_id`, creating an account row for it when none exists (NULL password_hash; email set only from a verified Google email that is not already taken; a Telegram account has no email); prior grants/attempts/facts/coins on that player_id remain keyed and accessible unchanged.

Every successful call SHALL return an `AuthResponse` (`player_id`, `email` nullable, `display_name`, `role`, `token`).

#### Scenario: Telegram sign-in on a fresh anonymous device creates an account keyed to the device id
- **WHEN** an anonymous device (with coins from play) posts a valid Telegram OIDC `id_token` to `/api/auth/telegram` with its `dev:<uuid>` player_id
- **THEN** an account is created with that same player_id, no email, a display name from the Telegram profile, and a linked `telegram` identity; a session is returned; the device's coins and grants remain intact.

#### Scenario: Google sign-in from a second device returns the existing account
- **WHEN** a user signed in with Google on device A, then signs in with the same Google account on device B (a different anonymous id)
- **THEN** device B receives device A's player_id and a fresh session (the identity already mapped), not a new account.

#### Scenario: Forged or stale provider payloads are rejected with no account effect
- **WHEN** `/api/auth/telegram` or `/api/auth/google` receives an ID token failing signature/`aud`/`iss`/`exp` verification
- **THEN** the server responds 401 and creates no account, identity, or session.

#### Scenario: Provider disabled when unconfigured
- **WHEN** `GOOGLE_CLIENT_ID` (or `TELEGRAM_CLIENT_ID`) is unset and the corresponding endpoint is called
- **THEN** the server responds 501 and performs no account effect.

### Requirement: An account exposes its linked sign-in methods and can link/unlink providers
`GET /api/players/me` SHALL include the account's linked identities so the client can show which sign-in methods are active (`email` when the account has an email/password, plus each linked `google`/`telegram`). A logged-in account SHALL be able to link an additional provider (the link-or-create step 2 above) and to unlink one via `POST /api/auth/unlink` (`{provider}`), provided at least one sign-in method remains afterward (the server SHALL reject removing the last method with 409). Unlinking SHALL remove only the `auth_identities` row (or clear email/password for the `email` method), never the account or its play data.

#### Scenario: Profile lists methods and blocks removing the last one
- **WHEN** a Telegram-only account (its sole method is `telegram`) requests to unlink `telegram`
- **THEN** the server responds 409 and the identity remains, so the account never becomes unreachable.

#### Scenario: Linking a second provider keeps one account
- **WHEN** a logged-in email account signs in with Google (Bearer present)
- **THEN** the Google identity links to that account; afterwards either method logs into the same player_id, and the profile lists both.
