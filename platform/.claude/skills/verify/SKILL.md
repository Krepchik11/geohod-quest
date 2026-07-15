---
name: verify
description: Build, launch and drive the GeoQuest platform (Axum backend + Next.js frontend) to verify a change end-to-end in a real browser.
---

# Verify: run the platform and drive it

## Launch

1. **Postgres** (backend `.env` expects `postgres://geohod:geohod@localhost:5432/geohod`):
   - Normal machine: `cd platform && docker compose up -d postgres`.
   - No docker daemon (sandbox): download portable binaries from
     `github.com/theseus-rs/postgresql-binaries/releases` (needs `libxml2.so.2` —
     `apt-get download libxml2` + `dpkg-deb -x` + `LD_LIBRARY_PATH` works without root),
     then `initdb -U geohod`, `pg_ctl start -o "-p 5432 -c unix_socket_directories=''"`
     (long socket paths overflow the 107-byte limit — TCP only), `createdb -U geohod geohod`.
2. **Backend**: `cd platform/backend && cargo run` → :8080. Reads `.env`
   (DATABASE_URL + `ADMIN_TOKEN=dev-admin-secret-change-me`). Migrations run at startup.
3. **Frontend**: `cd platform/frontend && npx next dev --port 3100` (3000 is often
   claimed by a stale lock: "Another next dev server is already running").
   `.env.local` already carries `NEXT_PUBLIC_ADMIN_TOKEN` matching the backend, which
   admits you through the /quest-editor role gate with no login.
   Production builds additionally need `NEXT_PUBLIC_API_URL` set.

## Drive

- Playwright is in `platform/node_modules` (`npx playwright install chromium` once).
  Probe scripts live at platform root (`e2e-*.mjs`) — some are stale vs the current UI;
  prefer writing a scoped probe per change.
- Editor flow: `BASE/quest-editor` → dashboard (`.qcd-*` classes) → «Создать новый
  квест» → builder (`.wsp-*`) → «Настройки и обложка» for quest meta. Autosave debounce
  is 350ms.
- API checks: `curl -H 'x-admin-token: dev-admin-secret-change-me' :8080/api/constructor/quests`.
  NOTE: constructor lists are author-scoped — a bare ops-token call is the author "ops",
  NOT the browser's device identity, so it won't see quests the UI created. For
  cross-author evidence query Postgres directly with `psql`.

## Sandbox gotchas (no root, no docker)

- Chromium needs ~22 shared libs: `apt-get -o Dir::State=<tmp> -o Dir::Cache=<tmp>
  -o Dir::State::status=/var/lib/dpkg/status download <pkgs>` then `dpkg-deb -x` into one
  dir and `LD_LIBRARY_PATH` it (Debian t64 names: libglib2.0-0t64, libatk1.0-0t64, …).
- Fonts: Skia FATALs with no fontconfig setup. Extract `fonts-dejavu-core`, write a
  minimal `fonts.conf` (`<dir>…/usr/share/fonts</dir><cachedir>writable</cachedir>`) and
  set `FONTCONFIG_FILE`.
