# Tasks

## 1. Data model
- [x] 1.1 Migration `0008_social_auth.sql`: `users.email`/`users.password_hash` → nullable; `auth_identities(provider, subject PK, player_id FK ON DELETE CASCADE, email, created_at)` + player index.
- [x] 1.2 `UserAccount.email: Option<String>`; update `account_from_row`, register/login, `/me`, admin wire, author-name fallback, confirm/recover guards.

## 2. Backend verification (TDD, pure)
- [x] 2.1 `social.rs`: Telegram HMAC verify (sorted data-check-string, SHA256(bot_token) key, constant-time `verify_slice`, auth_date freshness) — 6 unit tests (incl. independent golden vector).
- [x] 2.2 `social.rs`: Google ID-token verify (`GoogleVerifier` + cached JWKS via attohttpc; `aud`/`iss`/`exp`/signature; sub/email/email_verified/name) — 7 unit tests via a locally-signed RS256 token.
- [x] 2.3 `config.rs`: `google_client_id`, `telegram_bot_token`, `telegram_bot_username` from env (fail-closed None).

## 3. Store layer (tri-layer parity)
- [x] 3.1 InMemory + Pg + enum: `find_identity`, `create_identity`, `identities_for_player`, `delete_identity`, `create_social_account`, `attach_email`.
- [x] 3.2 `find_by_email` / row readers tolerate NULL password_hash + NULL email.

## 4. Routes + resolution
- [x] 4.1 `POST /api/auth/google`, `POST /api/auth/telegram`: link-or-create; fail-closed 501; 401 on bad verify.
- [x] 4.2 `GET /api/players/me` lists methods; `POST /api/auth/unlink` (keep ≥1 method); `GET /api/auth/providers`.
- [x] 4.3 Route tests: create-on-anon, login-existing (2nd device), link-with-bearer, last-method-guard, forged/stale reject, providers, 501s.

## 5. Frontend
- [x] 5.1 `lib/api.ts`: `authGoogle`, `authTelegram`, `authUnlink`, `getAuthProviders`; `Session.email` nullable; `me()` methods field.
- [x] 5.2 `app/auth/page.tsx`: Google + Telegram buttons above an "или по почте" divider on the email step; wire session on success.
- [x] 5.3 `SocialAuthButtons` — GIS + Telegram-widget loaders, config-gated, reused for sign-in and profile linking.
- [x] 5.4 `app/profile/page.tsx`: "Способы входа" block — list + link/unlink; social-only account hides the password row.
- [x] 5.5 vitest for the component (config-gate, telegram callback → API → session, divider).

## 6. Verify
- [~] 6.1 `cargo test` — 113 pass; the 2 Postgres suites require a live DB (unavailable in this env: no daemon/rootless runtime/passwordless sudo). `cargo clippy` clean. Pg methods mirror the existing production-proven query patterns; InMemory parity fully covered by the route tests.
- [x] 6.2 `npm run test` (336), `next lint` (0), `next build` (ok with NEXT_PUBLIC_API_URL set).
- [x] 6.3 Manual: drove the full Telegram flow against the running server — anon→account (id preserved, no email), /me methods, 2nd-device login, forged→401, stale→401, unlink-last→409; Google fail-closed 501 verified.
