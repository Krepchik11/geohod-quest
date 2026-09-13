# Releases

One ordered pipeline takes a push to `main` to production. The frontend is promoted
only after the backend it needs is live and has said so. See
[`README.md`](./README.md) for the topology these steps move, and
[`vps.md`](./vps.md) for the host they move it onto.

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
   (`https://quest.geohod.ru`), the custom domain rather than the
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
