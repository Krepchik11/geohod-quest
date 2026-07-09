## Why

Today the only way to become a registered account is email + password
(`player-identity` spec). For the target audience (Russian-speaking, mobile,
Telegram-native) that is friction: a password to invent and a mailbox to open on
a phone. Two one-tap options — **Sign in with Google** and **Telegram Login** —
remove that friction and are the modern default for consumer apps.

The anonymous-first invariant must survive: signing in with a provider from a
device that already earned coins / bought quests MUST keep them (same `player_id`,
zero data migration — exactly like email registration does today).

## Research (best practices, verified against primary sources)

**Google — "Sign in with Google" (Google Identity Services).**
- The button yields an **ID token (JWT)**; the backend MUST verify it and never
  trust the client. (developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- Verify: signature via Google's rotating public keys (JWKS at
  `https://www.googleapis.com/oauth2/v3/certs`, honor `Cache-Control`), `aud` ==
  our OAuth client id, `iss` ∈ {`accounts.google.com`,`https://accounts.google.com`},
  `exp` not passed.
- **`sub`** is the stable, never-reused user id — key the identity on `sub`, not
  email (email can change). `email` + `email_verified` tell us when Google is
  authoritative for the address.

**Telegram — OpenID Connect (`telegram-login.js`).**
- The frontend loads `oauth.telegram.org/js/telegram-login.js` and calls
  `Telegram.Login.auth({client_id, scope:['profile']}, cb)`; the popup returns an
  **ID token (JWT)**. (core.telegram.org/bots/telegram-login — the OIDC login that
  replaces the legacy HMAC Login Widget.)
- The token yields an **ID token (JWT)**; the backend MUST verify it against
  Telegram's JWKS (`oauth.telegram.org/.well-known/jwks.json`, key chosen by `kid`,
  algorithm from that key — RS256/ES256/EdDSA), require `aud == bot client id`,
  `iss == https://oauth.telegram.org`, unexpired `exp`. The stable subject is the
  `id` claim (Telegram user id). Telegram provides **no email**. No bot token or
  secret is needed — verification is against the public JWKS.

**Account linking (Auth0 / Firebase / Cognito guidance).**
- Model identities separately from the account; one account, many linked
  identities. Never silently merge on a bare email; only auto-link when the
  provider is **authoritative** for a *verified* email. Telegram never collides
  (no email), so it links purely by Telegram id.

## What Changes

- **Data model (root cause):** `users.email` and `users.password_hash` become
  **nullable** — a Telegram account has no email and no password; a Google
  account has an email but no password. A new **`auth_identities(provider,
  subject) → player_id`** table stores linked Google/Telegram identities
  (email/password stays represented by the existing `users` columns). One account
  can hold email + Google + Telegram at once.
- **Backend:** a pure `social` module (one generic `OidcVerifier` with a cached
  JWKS provider, instantiated for Google and Telegram), tri-layer store methods
  (`find_identity`/`create_identity`/`identities_for_player`/`delete_identity`/
  `create_social_account`), migration `0008`, and two routes
  `POST /api/auth/google` and `POST /api/auth/telegram`. Both **link-or-create**:
  existing identity → login to its account; else logged-in caller → link; else
  Google-verified-email match → link to that email account; else attach to the
  caller's anonymous `player_id` (coins/grants preserved). Fail closed when the
  provider is unconfigured (no `GOOGLE_CLIENT_ID` / `TELEGRAM_CLIENT_ID`).
- **Frontend:** Google + Telegram buttons on the email-first auth page (email
  stays primary; social sits above a divider as the fast path), a `/api/players/me`
  that lists linked methods, and a Profile "Способы входа" block to link/unlink.
  `Session.email` becomes `string | null` (social-only accounts show their name).

**BREAKING:** `UserAccount.email` / `AuthResponse.email` / `AdminUserWire.email`
and the frontend `Session.email` change from a required string to nullable. All
in-repo call sites are updated in this change.

## Capabilities

### Modified Capabilities

- `player-identity`: add social sign-in (Google, Telegram) as additional ways to
  reach the same `player_id`; make email optional on an account; define the
  link-or-create resolution and the linked-identities surface.

## Impact

- **Backend:** `Cargo.toml` (+`jsonwebtoken`, +`attohttpc` — ring-based, no new
  heavy deps), `src/social.rs` (new), `src/store.rs`, `src/pg_store.rs`,
  `src/config.rs`, `src/main.rs`, `migrations/0008_social_auth.sql`.
- **Frontend:** `lib/api.ts`, `lib/identity.ts`, `app/auth/page.tsx`,
  `app/profile/page.tsx`, styles, plus a small Telegram OIDC (`telegram-login.js`) loader.
- **Tests:** unit tests for both verifiers (TDD), store parity (InMemory + Pg),
  route tests for link/create/collision, frontend vitest for the new client
  calls; `cargo test`, `npm run test|lint|build`.
