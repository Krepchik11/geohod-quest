# Tasks: player-identity-live-commerce

## 1. Backend auth primitive (TDD)

- [x] 1.1 Add deps (`argon2`, `rand`); migration `0002_auth.sql` (players: player_id PK, email UNIQUE NOT NULL, password_hash NOT NULL, display_name, created_at; sessions: token PK, player_id NOT NULL, created_at)
- [x] 1.2 RED: shared scenarios (in-mem) — register attaches to existing player_id (grants/facts survive), duplicate email 409, already-registered player 409, login ok → fresh token + same player_id, wrong password/unknown email 401, /players/me with token vs anonymous header
- [x] 1.3 `auth.rs`: password hash/verify (argon2id), token gen (OsRng 32B hex), request/response types; store methods (in-mem + Postgres): register_player, find_player_by_email, get_player, create_session, get_session
- [x] 1.4 Handlers + routes: POST /api/auth/register, POST /api/auth/login, GET /api/players/me; identity resolution helper (Bearer wins; claimed id of a registered player without token → 401; anonymous accepted)
- [x] 1.5 Enforcement wired into checkout, attempt creation, bundle download; RED scenario: tokenless spoof of registered id → 401, with token → ok, anonymous unchanged; all 14 existing scenarios untouched and green

## 2. Player stats (TDD)

- [x] 2.1 RED: cross-attempt fold scenario (completed quest A with bonus, in-progress B with hint overdraft → negative balance, completed list [A], counts); idempotent re-append changes nothing; enforcement on /me/stats
- [x] 2.2 Pure `project_player_stats` in facts.rs + store gather `attempt_logs_for_player` (in-mem + Postgres); GET /api/players/me/stats handler

## 3. Mock payment provider (TDD)

- [x] 3.1 RED: Payment-path grant carries mock payment_ref as source_ref; coupon-100 bypasses provider (source_ref null); idempotent repeat preserves original
- [x] 3.2 `payments.rs`: PaymentProvider trait + MockPaymentProvider (always approves, deterministic ref); checkout handler routes Payment path through provider

## 4. Postgres parity

- [x] 4.1 Extend `pg_full_suite` with the new scenarios (auth register/login/enforcement, stats fold, payment_ref audit) + restart survival of players/sessions; run live against Postgres

## 5. Frontend identity module (TDD)

- [x] 5.1 RED vitest `lib/__tests__/identity.test.ts`: mint-once device id (versioned key), currentPlayerId anonymous vs session, set/clear session roundtrip, authHeaders (Bearer vs X-Player-Id), SSR-safe fallbacks
- [x] 5.2 Implement `lib/identity.ts`; `api.ts` injects authHeaders into every call + new endpoints (authRegister, authLogin, me, myStats); api call sites take player id from identity

## 6. Frontend wiring (replace every 'demo-player')

- [x] 6.1 commerce: live multi-quest list from listQuests() with per-quest buy (mock payment), owned state from grants for current identity, coupon flow retained, design classes kept
- [x] 6.2 my-quests, quest-detail, landing checkout, QuestPlayerClient: current identity everywhere (golden dev fallback grant included)
- [x] 6.3 auth page: register/login tabs (email+password, consent checkbox on register per design), logged-in state with email + Выйти, copy that registration is optional; uses api + identity modules
- [x] 6.4 profile: live /me + /me/stats (email when registered, anonymous label otherwise; rating floor client-side), labeled local-fold fallback when unreachable

## 7. Gates + verification

- [x] 7.1 cargo fmt --check, clippy --all-targets -D warnings, cargo test; DATABASE_URL pg_full_suite; vitest; next lint (0 errors); next build
- [x] 7.2 E2E (playwright, headless chromium): anonymous fresh profile → marketplace buy → play steps → register → profile shows email + stats; second-context login sees same account; tokenless spoof of registered id fails
- [x] 7.3 Update platform/README.md (auth endpoints, identity model, mock payment); record cuts/debt in proposal Impact if anything shifted
