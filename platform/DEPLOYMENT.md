# Deployment

Frontend → **Vercel**. Backend (Rust) → **VPS** (Podman + Caddy). Production host:
`api.quest.geohod.ru`.

## Topology (important)

The browser calls the Rust backend **directly** via `NEXT_PUBLIC_API_URL`. There is
no Next.js BFF/proxy and no SSR backend calls. So:

```
Browser ──(CORS, cross-origin)──> Rust backend on VPS
   ▲
   └── static/PWA assets served by Vercel CDN
```

This means **the backend MUST allow the frontend's origins via CORS** or nothing
works in production. See "Backend contract" below.

---

## Vercel setup (one-time)

1. **Import** `github.com/naborka/geohod-quest` into Vercel (New Project → import the repo).
2. **Root Directory:** set to `platform/frontend`. Vercel auto-detects Next.js.
   (`platform/frontend/vercel.json` already pins framework, `npm ci`, and the
   monorepo ignore step — no manual build/install overrides needed.)
3. **Node version:** Project Settings → set to **22.x** (matches CI; Next 16 needs ≥20).
4. **Environment Variables** — add `NEXT_PUBLIC_API_URL` for **each** environment:
   - **Production** → `https://api.your-domain.com` (your VPS backend, HTTPS).
   - **Preview** → a staging/preview backend URL (NOT production, or previews hit prod).
   - Leave **Development** unset → code falls back to `http://localhost:8080`.

   ⚠️ `NEXT_PUBLIC_*` is **baked into the bundle at build time**. Changing it
   requires a **redeploy** to take effect. If it is missing in prod, the build
   **fails by design** (see `lib/api.ts`) instead of silently shipping localhost.
5. Deploy. From now on: **push to `main` → Production**, **open a PR → Preview URL**.
   No deploy GitHub Action is needed — Vercel's Git integration does this.

## What runs where, and why

- **Deploy** = Vercel Git integration (automatic). Do **not** add a GH Actions deploy job.
- **Quality gate** = `.github/workflows/frontend-ci.yml` (lint + typecheck + test +
  build) on PRs touching `platform/frontend`. `next build` does not run eslint/vitest,
  so this is the only thing stopping a broken-but-compiling app from deploying.
  Add it as a **required status check** in GitHub branch protection for `main`.
- **Ignored builds**: `vercel.json` `ignoreCommand` skips Vercel builds when the
  commit didn't touch `platform/frontend` (so `blueprint/`, `design/`, `backend/`
  edits don't trigger pointless frontend redeploys).

## Frontend ↔ backend contract

- **HTTPS is required** (the Vercel page is HTTPS; a plain-HTTP API would be blocked
  as mixed content). Caddy provides this on `api.quest.geohod.ru` automatically.
- **CORS is an env-driven allowlist** (`backend/src/main.rs`, `build_cors_layer`).
  Set `CORS_ALLOWED_ORIGINS` (comma-separated) to the frontend's production origin
  plus the Vercel preview wildcard, e.g.
  `https://app.quest.geohod.ru,https://*.vercel.app`. Each entry is an exact origin
  or a single-`*` wildcard. **If unset, the API reflects ANY origin** (dev
  convenience, logged as a warning) — so production must set it. Auth is carried in
  `Authorization`/`X-Player-Id` **headers, not cookies**, so credentials are not
  enabled. Note: `https://*.vercel.app` allows *any* Vercel app's origin; scope it
  to your project (e.g. `https://geohod-quest-*.vercel.app`) if you want it tighter.

---

# Backend (VPS · Podman · Caddy)

Artifacts live in `platform/backend/Containerfile`, `platform/deploy/*`, and
`.github/workflows/backend-image.yml`.

## Topology

```
Browser ──HTTPS──> Caddy (host) ──HTTP──> 127.0.0.1:8082  (API container)
                                                  │ podman network "geohod-quest"
                                                  └──> geohod-quest-db:5432 (Postgres container + volume)
```

- **Port 8082** for the API (8080/8081 are already used by app./dev.geohod.ru).
- API published on **loopback only** — the public reaches it solely via Caddy.
- Postgres is **not** published to the host; only the API sees it (netavark DNS).

## Prerequisites

- DNS: an `A`/`AAAA` record for `api.quest.geohod.ru` → this VPS (ports 80/443 open).
- `podman --version` ≥ **4.4** (for Quadlet). If older, use `podman generate systemd`
  on hand-run containers instead of the `.container` units.
- Rootless user with lingering so units start at boot:
  `loginctl enable-linger "$USER"`.

## One-time setup

1. **Build & publish the image** (recommended: via CI). Push to `main` touching
   `platform/backend/**` runs `backend-image.yml`, producing
   `ghcr.io/naborka/geohod-quest-api:latest`. Make the package **public**, or
   `podman login ghcr.io` on the VPS once.
   *Fallback (build on VPS):* the context is `platform/` (the crate embeds
   `../goldens` at compile time), so build from there:
   `cd platform && podman build -f backend/Containerfile -t localhost/geohod-quest-api:latest .`
   then set `Image=localhost/geohod-quest-api:latest` in the API unit.

2. **Create secrets** (never plaintext env files). Use one strong password in BOTH
   the DB password and the URL — they must match. Generate it **URL-safe** (hex):
   the password is embedded in `DATABASE_URL`, so a `/`, `+`, `:`, or `@` (which
   `openssl rand -base64` produces) corrupts URL parsing — sqlx fails with
   "invalid port number". `openssl rand -hex` avoids all of them.
   ```sh
   PGPW="$(openssl rand -hex 24)"
   printf '%s' "$PGPW" | podman secret create geohod-quest-db-password -
   printf 'postgres://geohod:%s@geohod-quest-db:5432/geohod?sslmode=disable' "$PGPW" \
     | podman secret create geohod-quest-database-url -
   printf '%s' "$(openssl rand -hex 24)" | podman secret create geohod-quest-admin-token -
   ```
   The admin token must equal the frontend's `NEXT_PUBLIC_ADMIN_TOKEN`.
   (`POSTGRES_PASSWORD` only applies on first DB init — changing it later requires
   removing the `geohod-quest-pgdata` volume so Postgres re-initializes.)

3. **Install Quadlet units:**
   ```sh
   mkdir -p ~/.config/containers/systemd
   cp platform/deploy/geohod-quest.network \
      platform/deploy/geohod-quest-pgdata.volume \
      platform/deploy/geohod-quest-db.container \
      platform/deploy/geohod-quest-api.container \
      ~/.config/containers/systemd/
   systemctl --user daemon-reload
   systemctl --user start geohod-quest-db.service geohod-quest-api.service
   ```
   (Generated service names match the unit filenames.)

4. **Caddy:** append `platform/deploy/Caddyfile.snippet` to the host Caddyfile and
   reload (`sudo systemctl reload caddy` or `caddy reload`).

## Verify

```sh
systemctl --user status geohod-quest-api.service        # active (running)
curl -fsS http://127.0.0.1:8082/health                  # local
curl -fsS https://api.quest.geohod.ru/health            # through Caddy + TLS
```
Then set Vercel's `NEXT_PUBLIC_API_URL` (Production) to `https://api.quest.geohod.ru`
and redeploy the frontend.

## Updating

CI rebuilds and pushes `ghcr.io/naborka/geohod-quest-api:latest` (and a
`sha-<commit>` tag) on every backend change. Migrations run automatically at
startup (`sqlx::migrate!`, embedded), so updating = pulling a newer image and
restarting the unit. Three ways, pick one:

**Recommended — automatic (`podman auto-update`).** The API unit carries
`AutoUpdate=registry`. Enable the timer once:
```sh
systemctl --user enable --now podman-auto-update.timer    # needs linger (set above)
```
The timer (default daily) re-pulls `:latest` when its digest changed, restarts
the unit, and **rolls back to the previous image if the new container fails to
start**. The DB is intentionally NOT labeled, so it is never touched. Inspect:
```sh
systemctl --user list-timers | grep auto-update
podman auto-update --dry-run
```

**On-demand (same mechanism, no waiting).** Run it yourself right after a release:
```sh
podman auto-update                 # pulls changed images, restarts, rolls back on failure
```

**Manual (no auto-update).** Explicit pull + restart — note a bare `restart`
does NOT re-pull (Quadlet `Pull=missing`), so the pull is required:
```sh
podman pull ghcr.io/naborka/geohod-quest-api:latest
systemctl --user restart geohod-quest-api.service
```

**Which build is live / rollback by hand:**
```sh
podman inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' geohod-quest-api
# pin a known-good build instead of :latest, then daemon-reload + restart:
#   Image=ghcr.io/naborka/geohod-quest-api:sha-<commit>
```

> After editing any `~/.config/containers/systemd/*.container` file, run
> `systemctl --user daemon-reload` before restarting — Quadlet regenerates the
> service unit from the file on reload.

## Backups (do this before real users)

Postgres data is in the `geohod-quest-pgdata` volume. No backups are configured yet.
Minimum viable: a cron `pg_dump` to off-box storage, e.g.
`podman exec geohod-quest-db pg_dump -U geohod geohod | gzip > dump-$(date +%F).sql.gz`.

## Tracked follow-ups (not blocking first deploy)

- **DB connect retry**: `PgPoolOptions::connect()` fails fast if PG isn't ready yet;
  `Restart=always` covers it but a bounded retry in `main.rs` removes the crash-loop.
- **Demo seeding in prod**: `seed_demo_quests` runs every boot and writes demo quests
  into the prod DB. Gate behind a `SEED_DEMO` env flag before launch.
- **Backups + secret rotation** as above.

## Frontend cleanup (recommended, not blocking)

- **Two lockfiles**: `platform/package-lock.json` (workspace) and
  `platform/frontend/package-lock.json`. Vercel + CI use the **frontend** one, so
  keep it authoritative and regenerated (`cd platform/frontend && rm -rf node_modules && npm install`).
  Since the backend is Rust, the npm workspace shares no JS — consider dropping the
  `workspaces` field in `platform/package.json` later so there is a single lockfile.
- **PWA caching**: the service worker can serve stale assets to returning users after
  a deploy. Verify the SW update/skip-waiting strategy when you cut the first prod release.
