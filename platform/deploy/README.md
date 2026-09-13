# Deploying GeoQuest

Frontend → **Vercel**. Backend (Rust) → **VPS** (Podman + Caddy). Production API:
`api.quest.geohod.ru`. Production frontend: `quest.geohod.ru` — the same origin the
committed [`geohod-quest-api.container`](./geohod-quest-api.container) allows, which
is the value that actually runs.

This directory holds both the deploy artifacts and the documentation for them, so a
file and its explanation are never in different places:

| Read this | When |
|---|---|
| **This file** | What the two halves are, and what they must agree on across a deploy. |
| [`releases.md`](./releases.md) | How a push to `main` reaches production, and what to do when it doesn't. |
| [`vps.md`](./vps.md) | Standing up and operating the backend host: Podman, Caddy, R2, payments, backups. |
| [`geohod-quest-api.container`](./geohod-quest-api.container) | The Quadlet unit the VPS runs. |
| [`Caddyfile.snippet`](./Caddyfile.snippet) | The edge block to append to the host Caddyfile. |

It used to be one 694-line DEPLOYMENT.md with seven `#` headings, two sections
called `## Topology` and two called `## One-time setup` — the second of each
unreachable by anchor, because markdown gives them colliding ids. It was three
documents in one file, so it is three files.

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

## Frontend ↔ backend contract

- **HTTPS is required** (the Vercel page is HTTPS; a plain-HTTP API would be blocked
  as mixed content). Caddy provides this on `api.quest.geohod.ru` automatically.
- **CORS is an env-driven allowlist** (`backend/src/main.rs`, `build_cors_layer`).
  Set `CORS_ALLOWED_ORIGINS` (comma-separated) to the frontend's production origin
  plus the Vercel preview wildcard, e.g.
  `https://quest.geohod.ru,https://*.vercel.app`. Each entry is an exact origin
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
