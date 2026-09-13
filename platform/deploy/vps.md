# The backend host (VPS · Podman · Caddy)

Standing up and operating the machine the API runs on. The artifacts referenced
throughout live beside this file; [`releases.md`](./releases.md) covers how new
images reach this host, and [`README.md`](./README.md) the contract it must honour.

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

1. **Build & publish the image** (recommended: via CI). Any push to `main` runs the
   [release pipeline](#releases), which calls `backend-image.yml` and produces
   `ghcr.io/naborka/geohod-quest-api:latest`. Make the package **public**, or
   `podman login ghcr.io` on the VPS once.
   *Fallback (build on VPS):* the context is `platform/` (the crate embeds
   `../goldens` at compile time), so build from there:
   `cd platform && podman build -f backend/Containerfile -t localhost/geohod-quest-api:latest .`
   then set `Image=localhost/geohod-quest-api:latest` in the API unit. A locally
   built image reports `build_id=dev`, which no release can match — so a VPS pinned
   to one will fail the gate on every deploy until it is pointed back at GHCR.

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
   curl -X POST "$API/api/admin/users/<user_id>/role" \
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
   - The schema (`migrations/`) additionally enables RLS (deny-by-default) on
     **every** app table — including `auth_tokens` and `identities`, which hold
     reset-token hashes, password hashes and provider subjects — as defense in depth. It is a no-op
     for the app, which connects as the table-owner role (RLS-exempt).

## Verify

```sh
systemctl --user status geohod-quest-api.service        # active (running)
curl -fsS http://127.0.0.1:8082/health                  # local
curl -fsS https://api.quest.geohod.ru/health            # through Caddy + TLS
```
Then set Vercel's `NEXT_PUBLIC_API_URL` (Production) to `https://api.quest.geohod.ru`
and redeploy the frontend (**Actions → release → Run workflow** — the value is baked
into the bundle at build time, so it only takes effect on a new build).

## Updating

Nothing to do by hand — the [**Releases**](#releases) pipeline owns this, and the
frontend is held back until the update below has landed. Migrations run at startup
(`sqlx::migrate!`, embedded), so updating *is* pulling a newer image and restarting
the unit.

**The mechanism.** The API unit carries `AutoUpdate=registry`, and
`podman-auto-update.timer` re-pulls `:latest` when its digest changed, restarts the
unit, and **rolls back to the previous image if the new container fails to start**.
The stock timer fires **daily**, which is far too slow for a gated release — install
the one-minute drop-in from
[`deploy/podman-auto-update.timer.d/override.conf`](./deploy/podman-auto-update.timer.d/override.conf)
(see [Releases → One-time setup](#one-time-setup)). Inspect:
```sh
systemctl --user list-timers | grep auto-update
podman auto-update --dry-run
```

**Force it now** (same mechanism, no waiting for the timer):
```sh
podman auto-update                 # pulls changed images, restarts, rolls back on failure
```

**Manual (auto-update disabled).** Explicit pull + restart — note a bare `restart`
does NOT re-pull (Quadlet `Pull=missing`), so the pull is required:
```sh
podman pull ghcr.io/naborka/geohod-quest-api:latest
systemctl --user restart geohod-quest-api.service
```

**Which build is live:**
```sh
curl -fsS https://api.quest.geohod.ru/health     # {"status":"ok","build_id":"<12 hex>"}
# build_id is the CONTENT id the release gate matches on. To get the commit, read
# the image label — it may legitimately be OLDER than HEAD, because a commit that
# left the backend unchanged is never rebuilt:
podman inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' geohod-quest-api
```

`/health` reports **one** identity and it is derived. It used to also carry the
crate version — which was written at the repository's first commit and never bumped
again, so it answered "is my change live?" with `0.1.0` no matter what was actually
deployed. That is the failure this pipeline exists to end, so the field is gone
rather than documented; nothing read it (`build_id` is what the gate matches, and
the container HEALTHCHECK only looks at the status code). A locally built image
reports `build_id=dev`.

**Rollback.** Prefer `git revert` + push: the pipeline re-points `:latest` at the
older image and auto-update follows it, keeping the frontend in step. To pin by
hand instead, set `Image=ghcr.io/naborka/geohod-quest-api:sha-<commit>` in the unit
(or `:build-<id>`), then `daemon-reload` + restart — but note that a pinned unit no
longer tracks `:latest`, so the next release's gate will time out until you unpin.

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
       "AllowedOrigins": ["https://quest.geohod.ru", "https://*.vercel.app"],
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

### One-off: move already-stored images into R2

Quests authored before media was externalized carry their cover and every step
image as base64 **inside the row**. Nothing writes such a row any more — create,
save and publish all take the payload apart first — but the rows already written
have to be converted, and that cannot be a SQL migration: the payloads must be
decoded and put in the bucket.

Run it once after deploying, with the ops token. It is idempotent and
restartable, so re-running it is free and interrupting it is safe:

```sh
curl -fsS -X POST https://api.quest.geohod.ru/api/migrate/media \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"limit": 10}'
# -> {"quests_scanned":…,"quests_rewritten":…,"images_stored":…,"complete":false}
```

`limit` caps how many rows one call rewrites (default 10) so the work fits inside
the request timeout; **repeat until `complete` is `true`**. It rewrites the
authoring row, the catalog cover, and every frozen snapshot — including
superseded versions, which players mid-attempt are still bound to.

Until it has run, a quest written the old way keeps its pictures in the row: the
dashboard list carries them (slow), its PWA icon endpoint answers 404, and
re-publishing that quest at its **existing** version is refused as a frozen
snapshot, because the payload now arrives externalized while the stored one is
not. All three are fixed by the run, not by another deploy.

## Payments (YooKassa)

Checkout charges through YooKassa (redirect flow: the payer confirms on the
YooKassa page, returns to the quest page, and the backend verifies the payment
against the API before granting). Fail-closed: without credentials the API
offers only the mock provider and `provider=yookassa` answers 501.

One-time setup:

1. **Secret key** — YooKassa dashboard -> Integration -> API keys. Store it as a
   podman secret on the VPS (paste the key, press Enter, Ctrl-D):

   ```bash
   podman secret create geohod-quest-yookassa-secret-key -
   ```

2. **Shop ID** — dashboard -> Settings -> Shop. It is not a secret: set it as
   `Environment=YOOKASSA_SHOP_ID=...` in `deploy/geohod-quest-api.container`,
   and uncomment the `Secret=geohod-quest-yookassa-secret-key,...` line next to
   it. Then `systemctl --user daemon-reload && systemctl --user restart
   geohod-quest-api`.

3. **Webhook** — dashboard -> Integration -> HTTP notifications:
   `https://api.quest.geohod.ru/api/payments/yookassa/webhook`, events
   `payment.succeeded` + `payment.canceled`. The endpoint never trusts the
   notification body (it re-fetches the payment from the YooKassa API), so no
   IP allowlisting is needed. The return-page poll also settles payments, so
   the webhook is a resilience layer — it covers payers who close the browser
   before returning.

To rotate the key: issue a new one in the dashboard, then
`podman secret rm geohod-quest-yookassa-secret-key`, re-create it with the new
value, and restart the unit.

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
  4. **Bubble API token** — `BUBBLE_API_TOKEN` was committed to git history in a
     SEPARATE repository (old-knowledgebase, at discovery/config/app.env — not a
     path in this repo) and was readable in every clone and on GitHub. The
     history rewrite removed the blob, but anything already cloned or indexed
     still has it: **treat the token as compromised and roll it in the Bubble
     dashboard.**
- **Secret rotation (ongoing)**: rotate the Supabase DB password (then refresh the
  `geohod-quest-database-url` secret) and the `ADMIN_TOKEN` periodically.
- **Connection budget**: `DB_MAX_CONNECTIONS` (default 5, set in the API unit)
  must stay within the Supabase pooler's pool size — raise both together if you
  add instances or traffic.

## Frontend notes

- **PWA caching**: the service worker serves the app shell stale-while-revalidate, so
  a returning user runs the previous frontend for one navigation after a deploy (and
  an unopened installed PWA for far longer). The release pipeline cannot fix this —
  it is why the API must stay backward compatible; see
  [The invariant this pipeline does not enforce](#the-invariant-this-pipeline-does-not-enforce).
