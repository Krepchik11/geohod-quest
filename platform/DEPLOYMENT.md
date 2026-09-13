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

# Releases

**A push to `main` runs one ordered pipeline** —
[`.github/workflows/release.yml`](../.github/workflows/release.yml):

```
quality gates ──> backend image ──> backend LIVE on the VPS ──> frontend promoted
   (cargo test,      (GHCR)          (gate: /health reports        (vercel deploy
    vitest, lint)                     this commit's build id)        --prod)
```

The gate is the whole point. The two halves used to ship on independent clocks:
Vercel promoted a push in ~2 minutes, while the VPS only noticed a new image when
`podman-auto-update`'s **daily** timer next fired. A new frontend therefore
routinely called a backend up to a day behind that could not serve it. Now the
frontend is promoted only after `https://api.quest.geohod.ru/health` reports the
`build_id` of the commit being released.

## Build ids, not commit shas

`build_id` is a hash of everything the backend image is built from — the crate and
the goldens it embeds (`platform/backend/` + `platform/goldens/` minus `parity/`),
the `platform/.dockerignore` that decides what the build context contains, and
`backend-image.yml` — and **not** the commit sha. That is what makes the gate
correct for every commit rather than only for backend ones:

| Commit touches | Image | VPS | Gate |
|---|---|---|---|
| backend | rebuilt, new digest | pulls + restarts | waits (~1–3 min) |
| frontend / docs only | build id unchanged → **not rebuilt**, `:latest` re-pointed at the same manifest | nothing to pull, no restart | passes on the first poll |

A commit-sha identity would have failed both rows: the gate would wait forever for
a redeploy a frontend-only commit never triggers, and every commit would restart
the API for no reason. `backend-image.yml` skips the build outright when
`<image>:build-<id>` already exists, so "unchanged backend ⇒ unchanged digest ⇒ no
restart" is a guarantee, not a build-cache accident.

## One-time setup

1. **VPS — reconcile every minute, not daily.** Without this the gate stalls on
   every backend change until it times out.
   ```sh
   systemctl --user enable --now podman-auto-update.timer
   mkdir -p ~/.config/systemd/user/podman-auto-update.timer.d
   cp platform/deploy/podman-auto-update.timer.d/override.conf \
      ~/.config/systemd/user/podman-auto-update.timer.d/
   systemctl --user daemon-reload
   systemctl --user restart podman-auto-update.timer
   systemctl --user list-timers | grep auto-update    # next fire ≤ 1 min away
   ```
   Deployment stays **pull-based**: the VPS needs no inbound SSH key and no
   webhook listener, and a host that was offline during a release converges by
   itself when it comes back.

2. **GitHub — a `Production` environment** (Settings → Environments → New
   environment, named exactly `Production`) carrying:
   - **secret** `VERCEL_TOKEN` — a credential.
   - **variables** `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` — identifiers, not
     credentials; they appear in URLs and in `.vercel/project.json`, and masking
     them only makes a failed deploy harder to read.

   ⚠️ An environment's secrets and variables are **invisible to a job that does
   not declare `environment:`** — they expand to the empty string with no
   warning. `preflight` and `frontend` both declare it. A job you add later that
   needs them must too, or it will fail with a value that looks unset while the
   settings page plainly shows it.

   Optional repository **variable** `API_BASE_URL` if the API is not at
   `https://api.quest.geohod.ru`.

   The release's `preflight` job asserts all three before anything is built or
   pushed, so a missing one stops the run with the names it wants instead of
   deploying the backend and failing at the last step.

3. **First release only** — the backend currently running predates `build_id` and
   reports none, so the gate waits for the new image. That is the normal path
   (≤ 1 min); `podman auto-update` on the host forces it immediately.

## Base-image security updates

"Identical sources are never rebuilt" means an unchanged backend keeps running the
`rust:1.96-bookworm` / `debian:bookworm-slim` layers it was first built on, however
old they get. Refresh them with **Actions → release → Run workflow →
`force_rebuild`**. Caveat: the build id is unchanged by definition, so the gate
cannot observe that rebuild landing — it passes immediately and the frontend may be
promoted while the API restarts. Harmless (no frontend or API behaviour changed),
but do it off-peak.

## When a release fails

- **Preflight fails** → nothing was built, pushed or deployed. The error names the
  `Production` environment credentials that are unset; set them and re-run.
- **Gate times out** → the frontend was **not** promoted; production stays on the
  previous, self-consistent pair. Diagnose on the host with
  `journalctl --user -u podman-auto-update.service -n 50`, then re-run the workflow.
- **Frontend job fails** → the backend is already live and serving the *old*
  frontend. Safe by construction (see the invariant below), but fix forward.
- **Rollback** → revert the commit and push. The revert restores an earlier backend
  build id, `backend-image.yml` re-points `:latest` at that existing image, and
  auto-update rolls the VPS back to it.

## The invariant this pipeline does not enforce

**The API must stay backward compatible with the previous frontend.** Ordering
closes the skew window in one direction only; in the other it cannot help:

- between the backend restart and the frontend promotion, the old frontend is
  calling the new backend;
- an installed PWA holds a cached app shell (`public/sw.js` serves the shell
  stale-while-revalidate), so returning users can run a frontend that is **days**
  old against today's backend;
- an attempt is frozen to the snapshot it bound at creation, so long-lived play
  sessions outlive any single deploy.

So change the API by *expand then contract*: add the new field/route and ship it,
let the frontend start using it, and only remove the old one in a later release.
Deleting or renaming a route in the same commit that stops calling it will break
every client that has not reloaded. Nothing mechanical enforces this today — the
parity goldens hold the two *folds* in agreement, not the HTTP surface.

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
4. **Vercel** — set `NEXT_PUBLIC_API_URL`, then redeploy (**Actions → release → Run
   workflow**; a Git push no longer deploys `main`). No media env is needed (R2 URLs
   are self-contained in the quest JSON).
5. **Import the legacy quests** — `npm run upload` (the SAME `R2_PUBLIC_BASE_URL`) →
   `npm run build` → psql the generated
   `platform/tools/bubble-import/generated/load.sql` into Supabase. The importer
   lives at `platform/tools/bubble-import/` **on disk only** — it is gitignored, because its
   raw dumps carry real user PII and it is run by hand against a live source, never
   built or deployed with the platform. See its own README there.
6. **Enable the features you need** — a fresh database stores no overrides, and every
   flag ships OFF (see **First boot: feature flags** below). Until you do this, the
   sign-in buttons do not render and checkout answers 501.
7. **Verify** — `curl https://api.quest.geohod.ru/health`; in the constructor upload an
   image (it lands in R2) and publish; play the quest; then DevTools → Network →
   Offline and confirm media still renders (served from the SW's quest-bundle cache).

---

## First boot: feature flags

The flag registry lives in code (`backend/src/features.rs`); the database holds only
admin-set overrides. **Nothing is seeded**, so a brand-new deployment comes up with
every feature off — that is deliberate (fail-closed), and it means a fresh deploy is
not usable until you turn things on.

What is off until you enable it, in `/admin` → features:

| Flag | Off means |
|---|---|
| `auth_google` | no "Sign in with Google" button |
| `auth_telegram` | no Telegram login |
| `payments_yookassa` | real checkout answers 501 — **nobody can buy** |
| `payments_mock` | the always-approving test provider is unavailable |
| `player_back_button` | system back leaves the play screen instead of rewinding a step |
| `player_universal_answer` | the platform-wide universal answer is not accepted |

Enabling a flag is a runtime decision and needs no redeploy. Note the second gate:
a flag can never switch on what the deployment cannot do — `auth_google` without
`GOOGLE_CLIENT_ID`, or `payments_yookassa` without the YooKassa secret, stays
unavailable no matter the override. Configure the credentials first, then flip the flag.

Leave `payments_mock` OFF in production: it grants access without charging.

---

## Vercel setup (one-time)

1. **Import** `github.com/naborka/geohod-quest` into Vercel (New Project → import the repo).
2. **Root Directory:** set to `platform/frontend`. Vercel auto-detects Next.js.
   (`platform/frontend/vercel.json` already pins framework, `npm ci`, and the
   monorepo ignore step — no manual build/install overrides needed.)

   ⚠️ Leave **«Include files outside of the Root Directory in the Build Step»**
   ON (Vercel's default). There is exactly one lockfile in this repository and it
   lives at `platform/package-lock.json`, one level above the Root Directory:
   `npm ci` run in `platform/frontend` walks up to the workspace root and
   installs from it. With that setting off, the lockfile is not in the build
   container and install fails outright — loudly, at deploy time, which the
   release pipeline reports rather than shipping a half-built frontend.
3. **Node version:** Project Settings → set to **22.x** (matches CI; Next 16 needs ≥20).
4. **Environment Variables** — add `NEXT_PUBLIC_API_URL` for **each** environment:
   - **Production** → `https://api.your-domain.com` (your VPS backend, HTTPS).
   - **Preview** → a staging/preview backend URL (NOT production, or previews hit prod).
   - Leave **Development** unset → code falls back to `http://localhost:8080`.

   ⚠️ `NEXT_PUBLIC_*` is **baked into the bundle at build time**. Changing it
   requires a **redeploy** to take effect. If it is missing in prod, the build
   **fails by design** (see `lib/api.ts`) instead of silently shipping localhost.

   Add `NEXT_PUBLIC_SITE_URL` too — the site's **own** address
   (`https://app.quest.geohod.ru`), the custom domain rather than the
   `*.vercel.app` host. It is what `sitemap.xml`, `robots.txt` and the canonical
   half of a share card are written against. Unlike the API base it never fails
   a build: unset, the app behaves identically and simply cannot hand a crawler
   an absolute link, so the sitemap is empty and `robots.txt` drops its
   `Sitemap:` line instead of naming a host nobody confirmed.
5. **Release credentials.** Production deploys are driven by CI, not by Git, so
   put `VERCEL_TOKEN` (Vercel → Settings → Tokens) as a **secret**, and
   `VERCEL_ORG_ID` + `VERCEL_PROJECT_ID` as **variables**, on the GitHub
   `Production` environment — see **One-time setup → 2** above for why the scope
   matters.

   Scope the token to **this project only**. The pipeline deploys exactly one
   project and needs nothing else. Read both ids straight from the API with that
   token — no linking, no dashboard hunting:
   ```sh
   curl -s -H "Authorization: Bearer $VERCEL_TOKEN" https://api.vercel.com/v9/projects \
     | jq '.projects[] | {VERCEL_PROJECT_ID: .id, VERCEL_ORG_ID: .accountId, rootDirectory}'
   ```

6. Deploy. From now on: **open a PR → Preview URL** (Vercel's Git integration),
   **push to `main` → the release pipeline promotes production once the backend is
   live** (see **Releases** above).

## What runs where, and why

- **Preview deploys** = Vercel Git integration (automatic, PR → preview URL).
- **Production deploys** = `.github/workflows/release.yml`, via the Vercel REST
  API (`POST /v13/deployments` pinned to the released commit, then poll
  `readyState` until `READY`), and only after the backend gate passes.
  `vercel.json` sets `git.deploymentEnabled.main = false` so a push to `main`
  cannot promote the frontend behind the pipeline's back — that bypass is exactly
  the bug the pipeline exists to prevent. That setting stops **automatic**
  deployments only; an explicit API deployment is unaffected, which is what the
  pipeline uses.
- **Why the API and not the CLI**: the release credential is a token scoped to
  this one project — the correct least-privilege choice. Every CLI path resolves
  the team by first loading the token's *user*, which such a token does not have,
  so `vercel link` fails with `Not able to load user … (404)` and `vercel pull`
  with `Could not retrieve Project Settings`. The REST API takes the scope as an
  explicit `teamId`, so nothing is inferred from the credential.
- **Quality gate** = `.github/workflows/frontend-ci.yml` (lint + typecheck + test +
  build). `next build` does not run eslint/vitest, so this is the only thing
  stopping a broken-but-compiling app from deploying. It runs on PRs touching
  `platform/frontend`, and `release.yml` calls it as a stage on `main` — a
  regression cannot be published while its test run is still going. Add it as a
  **required status check** in GitHub branch protection for `main`.
- **Every release builds the frontend.** `vercel.json` carried an `ignoreCommand`
  that skipped a build when the commit did not touch `platform/frontend`. A skipped
  build ends the deployment as `CANCELED`, which a release cannot tell apart from a
  broken one — so a backend-only commit would have failed every release. Vercel now
  builds each released commit, and the pipeline waits for it. One build per release
  is the price of a promotion that either happened or failed, with nothing in
  between.
- **Nothing is checked out for the deploy.** The sources Vercel builds come from
  the commit named in the API call, and the build settings (Root Directory
  `platform/frontend`, framework, install command) live in the Vercel project.

## Frontend ↔ backend contract

- **HTTPS is required** (the Vercel page is HTTPS; a plain-HTTP API would be blocked
  as mixed content). Caddy provides this on `api.quest.geohod.ru` automatically.
- **CORS is an env-driven allowlist** (`backend/src/main.rs`, `build_cors_layer`).
  Set `CORS_ALLOWED_ORIGINS` (comma-separated) to the frontend's production origin
  plus the Vercel preview wildcard, e.g.
  `https://app.quest.geohod.ru,https://*.vercel.app`. Each entry is an exact origin
  or a single-`*` wildcard. **If unset, the API reflects ANY origin** (dev
  convenience, logged as a warning) — so production must set it. Auth is carried in
  `Authorization`/`X-User-Id` **headers, not cookies**, so credentials are not
  enabled. Note: `https://*.vercel.app` allows *any* Vercel app's origin; scope it
  to your project (e.g. `https://geohod-quest-*.vercel.app`) if you want it tighter.
- **Response compression is negotiated, not forced** (`CompressionLayer`, br/gzip).
  A client that sends no `Accept-Encoding` is answered exactly as before, so no
  cached PWA client can be broken by it. Measured on the real golden quests, the
  frozen snapshot a player downloads over mobile data drops ~66–71%; the
  catalogue drops far more. Already-compressed types (images) and tiny bodies are
  skipped by the default predicate, so content-addressed media is untouched.
- **Every API response carries `X-Content-Type-Options: nosniff` and HSTS**
  (`max-age=63072000`, no `includeSubDomains` — the API host does not speak for
  its siblings). HSTS matters here specifically: the API carries session tokens
  in a header, so one plain-HTTP request is one stolen session.

## Browser-side headers, and the one that is deliberately missing

`frontend/next.config.ts` sets `nosniff`, `Referrer-Policy`,
`X-Frame-Options: DENY`, HSTS, a `Permissions-Policy` denying the device APIs the
app never calls, and a CSP of `base-uri 'self'; object-src 'none'; frame-ancestors
'none'`. Each of those is provable for this app: it has no `<base>`, no
`<object>`/`<embed>`, and is never framed.

There is **no `script-src`**, and that is a decision, not an oversight:

- Next inlines its own bootstrap script, so a `script-src` without
  `'unsafe-inline'` needs a per-request nonce — which means middleware on every
  request, and middleware is the one thing this deployment has deliberately
  avoided (see **Topology**: no BFF, no proxy).
- The media host is a backend runtime value (`R2_PUBLIC_BASE_URL`), unknown to
  the frontend build, so `connect-src`/`img-src` cannot be enumerated at build
  time. A guessed allowlist would break offline media downloads.
- Both sign-in providers load a first-party script from their own host, and both
  ship behind feature flags that are **off** by default — so a wrong `script-src`
  would break a flow nobody exercises in CI and nobody notices until a user does.

If the nonce route is taken later, the two provider hosts are
`https://accounts.google.com/gsi/client` and `https://oauth.telegram.org`, and
they are loaded from exactly one place (`app/components/SocialAuthButtons.tsx`).

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
