# player-identity

## ADDED Requirements

### Requirement: Telegram sign-in captures and exposes the account's verified @username

When an account is reached via `POST /api/auth/telegram`, the server SHALL persist the
verified Telegram `@username` (the OIDC token's `preferred_username` claim, when present)
onto that Telegram `auth_identities` row, and SHALL keep it current on subsequent
sign-ins (a changed handle overwrites the stored one; an absent claim leaves any prior
value untouched). The stored username SHALL be exposed to server-side identity resolution
so an account's Telegram handle is a queryable contact (used to build a `t.me/<username>`
link). Persisting the username SHALL NOT change the identity subject (the Telegram user
`id` remains the stable key), SHALL NOT create or merge accounts, and SHALL be absent
(NULL) for a Telegram user who has no public username. No other provider gains a username
field (Google/email accounts are contacted by email).

#### Scenario: A Telegram username is stored on sign-in and surfaces for contact

- **WHEN** a user signs in with a Telegram OIDC token whose `preferred_username` is
  `milan_bg`
- **THEN** the account's Telegram identity records `username = "milan_bg"`, and identity
  resolution for that player yields a Telegram contact `t.me/milan_bg`.

#### Scenario: A handleless Telegram account has no username contact

- **WHEN** a user signs in with a Telegram token that carries no `preferred_username`
- **THEN** the Telegram identity's username is NULL, and identity resolution reports the
  account as Telegram with no reachable `@username` (no `t.me` link), never falling back
  to a fabricated handle.

#### Scenario: A later sign-in refreshes a changed username

- **WHEN** a Telegram user whose stored username is `old_handle` signs in again with
  `preferred_username = new_handle`
- **THEN** the stored username becomes `new_handle` for the same identity subject, with no
  new account and no change to the player id.
