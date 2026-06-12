# Design: player-identity-live-commerce

## Context

P1–P4 delivered the full grant → attempt → facts chain, offline PWA player, constructor, marketplace surface, admin stats — all keyed to the literal `'demo-player'`. The owner's updated requirement replaces the planned Telegram auth with: anonymous-first identity bound to a device id, optional email registration (no confirmation), mocked payment behind an interface, and live player statistics. The locked decision stands: pre-auth identity = client device UUID in `localStorage['geohod-device-id:v1']`.

## Goals / Non-Goals

**Goals:**
- Identity that exists **before any network** (offline-first: a fresh device can play a downloaded bundle with zero server round-trips).
- Registration that preserves every grant/attempt/fact/bonus key with **zero data migration**.
- Login from another device adopts the account identity (multi-device continuation).
- Mock payment behind a `PaymentProvider` trait (locked decision) with audit trail (`source_ref`).
- Live multi-quest marketplace + live profile statistics, design-faithful.
- Both storage backends (in-mem + Postgres) behave identically; all gates stay green.

**Non-Goals:**
- Email confirmation, password reset, rate limiting, logout-everywhere, token expiry/rotation (MVP cuts, recorded).
- Merging a device's anonymous progress into an account at login (explicit cut; the dominant flow is register-on-the-device-you-played-on, which loses nothing).
- Real payment provider, real money (P-next; trait boundary is the seam).
- Grants-list privacy hardening on the admin surface (unchanged this change).

## Decisions (each survived an adversarial pass)

1. **player_id is permanent; registration decorates it.** Anonymous id = `dev:<uuid4>`. `POST /api/auth/register` creates a `players` row whose PK **is** the caller's existing anonymous player_id, attaching email + argon2 hash. Grants (`PK(player_id, quest_id)`), attempts, facts, and `bonus_awards` never change keys — registration is metadata, not migration.
   - *Rejected alternative:* mint a new account id and migrate rows. Every migration is a race window (concurrent fact append during migration) and adds a transactional dance across two stores for zero user-visible benefit.
   - *Faced consequence:* the player_id leaks the first device's UUID. Acceptable: it is opaque, unguessable (UUIDv4), and never displayed.

2. **Email+password, not email-only.** "Register simply by email, no confirmation" cannot mean passwordless: login-by-bare-email would let anyone claim any account. Password (argon2id, default params) is the minimal credential that makes login meaningful. No email verification round-trip (per requirement).

3. **Honest two-tier enforcement.** A registered player_id REQUIRES `Authorization: Bearer <token>` for player-scoped endpoints (checkout, attempt create, bundle, /players/me, /players/me/stats). An anonymous player_id is credentialed by device possession alone — that IS the anonymous model; a token cannot exist before registration.
   - Resolution order: valid Bearer token → token's player. Else the request's claimed player_id (body/query/header): if that player is registered → 401 (`registered account requires login`); else accepted as anonymous.
   - *Why not enforce tokens everywhere:* offline-first kills it (facts append must work for attempts created before registration), and it would invalidate all 14 shared scenarios for no threat-model gain while payments are mocked. The branch is small, tested, and documents the real trust boundary.
   - *Faced consequence:* anonymous accounts are spoofable by anyone who learns the UUID. Recorded; unguessable ids + no real money make this an accepted MVP risk.

4. **Sessions are opaque server-side tokens, not JWTs.** 32 random bytes hex (via `rand::rngs::OsRng`), stored in `sessions(token PK, player_id, created_at)` / in-mem map. Lookup is one indexed read; revocation is `DELETE`. JWTs would add key management and unrevocable tokens to dodge one table — wrong trade at this scale. No expiry in MVP (cut, recorded).

5. **Facts append stays attempt-scoped, untouched.** Attempt ids are unguessable capability keys created via grant-gated POST; re-checking player identity per fact batch adds nothing (the attempt already binds the player) and would break offline replay of pre-registration attempts.

6. **Player stats = pure projector over gathered logs.** Store gains one gather: `attempt_logs_for_player(player_id) -> Vec<(quest_id, Vec<Fact>)>`; `facts.rs` gains pure `project_player_stats(logs, grants_count)` → `{balance, quests_completed, completed_quest_ids, attempts_count, grants_count}`. Balance = the same signed fold (may be negative); a quest counts completed when ANY of its attempts holds an `attempt_completed` fact. No SQL re-implementation of folds (persistence spec invariant); Postgres gathers rows, Rust folds.
   - *Faced consequence:* O(all player facts) per stats call. Fine: a player's lifetime fact count is small (hundreds); measure before caching (YAGNI).

7. **`PaymentProvider` trait with `MockPaymentProvider`.** `charge(player_id, quest_id) -> PaymentOutcome::Approved { payment_ref }` (mock always approves, ref = `"mock-pay-<n>"`). Checkout consults the provider only on the Payment path (coupon 100% bypasses — nothing to charge) and records `payment_ref` as the grant's `source_ref`. The trait is the locked owner decision, not speculative abstraction; the mock is honest about being the only impl.

8. **Frontend identity is one module.** `lib/identity.ts`: `getDeviceId()` (mint-once UUIDv4, versioned key), `currentPlayerId()` (session player_id else `dev:<device>`), `getSession()/setSession()/clearSession()` (`localStorage['geohod-session:v1']`), `authHeaders()` (Bearer when session, else `X-Player-Id`). `api.ts` injects `authHeaders()` into every call; pages stop passing literals. SSR-safe: all reads behind `typeof window` guards with stable server fallbacks (no hydration mismatch).

9. **Auth page replaces the Telegram stub** (owner requirement supersedes the design HTML's TG button): register/login tabs, email+password, consent checkbox required for register (kept per design), logged-in state (email + Выйти). Same `.auth-*` design classes; copy states registration is optional and play works anonymously.

## Risks / Trade-offs

- **Lost device = lost anonymous account.** Inherent to anonymous-first; the auth page copy nudges registration as the remedy.
- **Login does not merge local anonymous progress.** A user who plays anonymously on device B then logs into account A "loses" sight of B's local coins (they remain under B's anonymous id). Recorded cut; revisit if real users hit it.
- **Email enumeration via register 409 / login 401 asymmetry.** Accepted for MVP (no confirmation flow exists to hide behind anyway).
- **argon2 verify cost (~tens of ms) on login** — acceptable; no rate limiting yet (recorded cut).

## Migration

- New DB migration `0002_auth.sql`: `players`, `sessions` tables. Purely additive; no data backfill (anonymous players have no rows by design).
- Frontend: existing localStorage device-id key name is already the locked one; no client data migration. Users who had implicit `'demo-player'` identity in dev simply mint a fresh device id (dev-only data, no migration owed).

## Open Questions

None blocking — all owner decisions are recorded above; cuts are listed in Non-Goals/Risks.
