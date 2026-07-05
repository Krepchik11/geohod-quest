# Deployment

Frontend → **Vercel**. Backend (Rust) → **VPS** (Podman + Caddy). Production host:
`api.quest.geohod.ru`.

## Topology (important)

The browser calls the Rust backend **directly** via `NEXT_PUBLIC_API_URL`. There is
no Next.js BFF/proxy and no SSR backend calls. So:

```
Browser ──(CORS)──> Rust backend (VPS) ──TLS──> Supabase Postgres (session pooler)
   │  ▲                                   │
   │  └── PWA assets via Vercel CDN       └── image upload: POST /api/media ──┐
   │                                                                          ▼
   └──────────── quest media, read direct ──────────────> Cloudflare R2 (custom domain)
```

Storage is managed: **Postgres → Supabase**, **quest media → Cloudflare R2** (the
backend uploads via `POST /api/media`; browsers read media direct from R2's custom
domain). **Two CORS surfaces** must be configured or production breaks: the
**backend** must allow the frontend's origins (see "Backend contract" below), and
the **R2 bucket** must allow them too, so the PWA can precache media for offline play
(see "Media storage").

---

## Go-live runbook (first Supabase + R2 cutover)

A first cutover follows this order; each step links to its detailed section. Two
consistency rules thread through it:

- **`R2_PUBLIC_BASE_URL` is the bucket's custom domain and must be IDENTICAL** every
  place it appears — the backend API unit AND the import — because media URLs are
  baked into stored quest JSON at upload time. Changing the domain later means
  re-uploading / re-importing.
- **R2 bucket CORS is required for offline play.** Without it the PWA cannot precache
  the cross-origin media, and offline shows broken images (the download logs a
  warning).

1. **Supabase** — create the project; the schema applies itself on the backend's
   first boot (`sqlx::migrate!`). Copy the **session-pooler** URL.
2. **Cloudflare R2** — create the bucket, bind the custom domain, set bucket CORS,
   mint an S3 API token (the **Media storage (Cloudflare R2)** section).
3. **VPS** — create the podman secrets (DB URL, admin token, R2 keys, SMTP url), set the R2
   identifiers in the API unit (`R2_PUBLIC_BASE_URL` = the step-2 domain), install +
   start the unit, wire Caddy (the **Backend (VPS · Podman · Caddy)** section).
4. **Vercel** — set `NEXT_PUBLIC_API_URL`; redeploy. No media env is needed (R2 URLs
   are self-contained in the quest JSON).
5. **Import the legacy quests** — `npm run upload` (the SAME `R2_PUBLIC_BASE_URL`) →
   `npm run build` → psql `load.sql` into Supabase
   (`platform/tools/bubble-import/README.md`).
6. **Verify** — `curl https://api.quest.geohod.ru/health`; in the constructor upload an
   image (it lands in R2) and publish; play the quest; then DevTools → Network →
   Offline and confirm media still renders (served from the SW's quest-bundle cache).

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
                                                  │
                                                  └──TLS──> Supabase session pooler
                                                            aws-0-<region>.pooler.supabase.com:5432
```

- **Port 8082** for the API (8080/8081 are already used by app./dev.geohod.ru).
- API published on **loopback only** — the public reaches it solely via Caddy.
- The database is **managed Postgres (Supabase)**, reached over the internet (TLS).
  There is no local DB container on the VPS.

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

2. **Create secrets** (never plaintext env files).
   ```sh
   # DATABASE_URL = the Supabase SESSION-mode pooler string (Dashboard -> Connect
   # -> Session pooler). Use this pooler, NOT the direct db.<ref>.supabase.co host
   # (IPv6-only) and NOT the :6543 transaction pooler (it breaks sqlx prepared
   # statements + migration advisory locks). Keep ?sslmode=require. URL-encode any
   # special char in the password (a raw / + : @ corrupts URL parsing — sqlx then
   # fails with "invalid port number").
   printf '%s' 'postgres://postgres.<ref>:<enc-pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require' \
     | podman secret create geohod-quest-database-url -
   printf '%s' "$(openssl rand -hex 24)" | podman secret create geohod-quest-admin-token -

   # SMTP_URL = transactional mail (password reset / email confirmation). The
   # login AND password ride inside the url — hence a secret, not plain env.
   # Beget: the login is the full mailbox address, so its @ must be %40; also
   # URL-encode any : / @ + in the password. Port 465 = implicit TLS (smtps://),
   # 587 = STARTTLS (smtp://…?tls=required).
   printf '%s' 'smtps://no-reply%40geohod.ru:<enc-pw>@smtp.beget.com:465' \
     | podman secret create geohod-quest-smtp-url -
   ```
   The admin token must equal the frontend's `NEXT_PUBLIC_ADMIN_TOKEN`.
   Without the smtp secret the API logs mails instead of sending them — but the
   unit references the secret, so either create it or drop that `Secret=` line.
   `MAIL_FROM` / `FRONTEND_BASE` are plain env in the unit (already set there).

   `ADMIN_TOKEN` also authorizes the user-management surface (`GET /api/admin/users`,
   `POST /api/admin/users/{id}/role`) behind the `/admin` page. Roles default to
   `player`; **bootstrap the first admin** with the shared token (it bypasses the
   self-change guard, so it can also recover if every admin is demoted):
   ```sh
   curl -X POST "$API/api/admin/users/<player_id>/role" \
     -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"role":"admin"}'
   ```
   After that, admins manage roles from the `/admin` page using their session — and
   on a public deployment you can leave `NEXT_PUBLIC_ADMIN_TOKEN` unset so the bundle
   carries no secret and access is purely role-based.

3. **Install the Quadlet unit:**
   ```sh
   mkdir -p ~/.config/containers/systemd
   cp platform/deploy/geohod-quest-api.container ~/.config/containers/systemd/
   systemctl --user daemon-reload
   systemctl --user start geohod-quest-api.service
   ```
   (Generated service names match the unit filenames. There is no DB unit — the
   database is Supabase.)

4. **Caddy:** append `platform/deploy/Caddyfile.snippet` to the host Caddyfile and
   reload (`sudo systemctl reload caddy` or `caddy reload`).

5. **Harden Supabase** (one-time, dashboard). The app uses its own auth and talks
   to Postgres directly, never Supabase's auto-generated Data API — so close that
   surface:
   - **Disable the Data API for `public`**: Project Settings → API → remove
     `public` from the exposed schemas. The backend's pooler connection is
     unaffected; only the public PostgREST surface is.
   - The initial migration (`0001_init.sql`) additionally enables RLS
     (deny-by-default) on every app table as defense in depth. It is a no-op for
     the app, which connects as the table-owner role (RLS-exempt).

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
start**. Inspect:
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

## Media storage (Cloudflare R2)

Quest images are stored content-addressed (sha256) in an R2 bucket; the quest JSON
only carries URLs. The backend uploads on the editor's behalf (`POST /api/media`,
editor-gated) and hashes the bytes server-side.

**Two serving modes** (set `R2_PUBLIC_BASE_URL` accordingly; it bakes into stored
JSON, so it must be identical in the API unit AND the import):

- **Custom domain** (`https://media.<domain>`) — players read R2 **directly**; needs
  the zone on Cloudflare + bucket CORS. Steps 1–7 below.
- **Via the API** (`https://api.<domain>/api/media`) — **no custom domain / no NS
  change**. The backend streams bytes from R2 at `GET /api/media/{hash}`
  (`media.rs` R2 `get()`); players read through the API origin. **Skip steps 2–4**
  (custom domain, cache rule, bucket CORS) — the backend's own `CORS_ALLOWED_ORIGINS`
  is the single CORS surface. Still do steps 1, 5, 6 (bucket, S3 token, secrets).
  Tradeoff: media transits the VPS (cacheable, immutable); storage stays in R2.

One-time setup:

1. **Create the bucket** (Cloudflare → R2 → Create bucket), e.g. `geohod-quest-media`.

2. **Bind a custom domain** (bucket → Settings → Public access → Custom Domains →
   Connect Domain), e.g. `media.quest.geohod.ru`. Cloudflare provisions DNS + TLS
   and serves objects at `https://media.quest.geohod.ru/<key>`. Leave the `r2.dev`
   dev URL **disabled** — the custom domain is the only public surface. Access stays
   gated in practice: the sha256 URLs are unguessable and are only ever handed out
   inside grant-gated snapshots.

3. **Set bucket CORS** so the PWA can `fetch()` media cross-origin to precache it for
   offline play (bucket → Settings → CORS policy):
   ```json
   [
     {
       "AllowedOrigins": ["https://app.quest.geohod.ru", "https://*.vercel.app"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

4. **Cache immutably** (recommended): content-addressed keys never change, so add a
   Cloudflare Cache Rule on `media.quest.geohod.ru` with a long Edge + Browser TTL
   (e.g. 1 year). The CDN layer is the right place for caching policy (the backend
   intentionally does not set per-object `Cache-Control`).

5. **Create an S3 API token** (R2 → Manage R2 API Tokens → Create, **Object Read &
   Write**, scoped to the bucket). Record the **Access Key ID** and **Secret Access
   Key** (the secret is shown once).

6. **Provision on the VPS** — two podman secrets + three identifiers in the unit:
   ```sh
   printf '%s' '<ACCESS_KEY_ID>'     | podman secret create geohod-quest-r2-access-key-id -
   printf '%s' '<SECRET_ACCESS_KEY>' | podman secret create geohod-quest-r2-secret-access-key -
   ```
   Then edit `~/.config/containers/systemd/geohod-quest-api.container`: set
   `R2_ACCOUNT_ID` (your Cloudflare account id), confirm `R2_BUCKET` /
   `R2_PUBLIC_BASE_URL`, then `systemctl --user daemon-reload && systemctl --user
   restart geohod-quest-api.service`. The startup log must NOT show the
   "R2 media storage partially configured" warning (that means a var is missing).

7. **Verify a round-trip** (editor credential = the ops `ADMIN_TOKEN`):
   ```sh
   curl -fsS -X POST https://api.quest.geohod.ru/api/media \
     -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: image/png' \
     --data-binary @test.png            # -> {"url","hash","content_type","size"}
   curl -fsSI "https://media.quest.geohod.ru/<hash>"   # -> 200, content-type image/png
   ```

## Backups

The database is Supabase — **managed backups come with the platform** (frequency
and retention depend on your plan; Point-in-Time Recovery is a paid add-on). See
Project → Database → Backups. For an off-platform copy, `pg_dump` over the session
pooler, e.g. `pg_dump "$DATABASE_URL" | gzip > dump-$(date +%F).sql.gz`.

## Tracked follow-ups (not blocking first deploy)

- **⚠️ REQUIRED — rotate the cutover credentials.** During the 2026-06-30 cutover
  the Supabase DB password AND the R2 S3 secret access key were pasted into a chat
  transcript (via `platform/tools/bubble-import/.env`). Both are exposed and MUST be
  rotated once the import is done:
  1. Supabase → Project → Database → reset the DB password; recreate the
     `geohod-quest-database-url` podman secret (URL-encode the new password) and
     `systemctl --user restart geohod-quest-api.service`.
  2. Cloudflare → R2 → roll the S3 API token (new Access Key ID + Secret); recreate
     the `geohod-quest-r2-*` podman secrets and restart.
  3. Delete the local `platform/tools/bubble-import/.env` (the import is one-shot;
     it carries both plaintext secrets and is gitignored but not encrypted).
- **Secret rotation (ongoing)**: rotate the Supabase DB password (then refresh the
  `geohod-quest-database-url` secret) and the `ADMIN_TOKEN` periodically.
- **Connection budget**: `DB_MAX_CONNECTIONS` (default 5, set in the API unit)
  must stay within the Supabase pooler's pool size — raise both together if you
  add instances or traffic.

## Frontend cleanup (recommended, not blocking)

- **Two lockfiles**: `platform/package-lock.json` (workspace) and
  `platform/frontend/package-lock.json`. Vercel + CI use the **frontend** one, so
  keep it authoritative and regenerated (`cd platform/frontend && rm -rf node_modules && npm install`).
  Since the backend is Rust, the npm workspace shares no JS — consider dropping the
  `workspaces` field in `platform/package.json` later so there is a single lockfile.
- **PWA caching**: the service worker can serve stale assets to returning users after
  a deploy. Verify the SW update/skip-waiting strategy when you cut the first prod release.
