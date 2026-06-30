# bubble-import

One-shot ETL that brings the 19 quests from the legacy **bubble.io** geoquest app
into this project's `constructor_quests` table as **editable drafts**.

The lossless `raw/*.json` + the `raw/media-map.json` manifest are committed (small).
The downscaled image **bytes** (`raw/media/`, ~100 MB) are gitignored to keep clones
light — kept as a backup archive and re-downloadable via `npm run media` while bubble
lives. Media is **externalized to Cloudflare R2** (content-addressed by sha256): the
`upload` stage pushes the bytes and stamps each manifest entry with its public URL,
which the bodies reference. `transform`/`report`/`load` run **offline** from the
committed manifest alone — they no longer need the image bytes at all.

## Pipeline

```
bubble ─fetch─▶ raw/*.json ─media─▶ raw/media/*.jpg + raw/media-map.json
                                            │
                                        upload ──▶ Cloudflare R2 (sha256-keyed objects)
                                            │        + stamps r2Url into the manifest
                                            ▼
                                     transform (offline, manifest-only)
                                            ▼
                            generated/bodies/<quest>.json   (CtorQuest, R2 URLs)
                                            │
                                  ┌─────────┴─────────┐
                               report                load
                                  ▼                    ▼
                        generated/report.md   generated/load.sql + rollback.sql
```

| step | script | needs network | needs creds | output |
|------|--------|---------------|-------------|--------|
| extract | `npm run fetch` | yes (bubble) | `BUBBLE_TOKEN` | `raw/*.json` |
| media | `npm run media` | yes (S3/CDN) | — | `raw/media/*.jpg`, `raw/media-map.json` |
| upload | `npm run upload` | yes (R2) | `R2_*` | media in R2; `r2Url` stamped into the manifest |
| transform | `npm run transform` | no | — | `generated/bodies/*.json` (run `upload` first) |
| report | `npm run report` | no | — | `generated/report.md` (run `upload` first) |
| load | `npm run load` | no | — | `generated/load.sql`, `generated/rollback.sql` |
| (transform+report+load) | `npm run build` | no | — | everything in `generated/` |
| tests | `npm test` | no | — | — |

`raw/*.json` + the media manifest are committed; the downscaled image **bytes**
(`raw/media/`) are gitignored (restore from the backup tarball, or re-run `media`).
`BUBBLE_TOKEN` (fetch/media) and the `R2_*` secrets (upload) are read from env and
**never committed**. The R2 upload reads:
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
`R2_PUBLIC_BASE_URL` (+ optional `R2_ENDPOINT` to point at a local S3 mock for testing).

## Loading

The body column is opaque JSON (no backend schema validation), so we write the DB
directly. The loader is **idempotent**: `quest_id = bubble-<bubbleId>` with
`ON CONFLICT … DO UPDATE`, so re-runs upsert rather than duplicate.

```bash
npm run upload   # one-time: push media to R2 + stamp the manifest (needs R2_* env)
npm run build    # regenerate generated/load.sql (now carries R2 URLs, ~470 KB not ~135 MB)

# local (this repo's docker-compose Postgres):
docker exec -i geohod-postgres psql -U geohod -d geohod < generated/load.sql

# production (you hold the secret; not reachable from this machine):
psql "$PROD_DATABASE_URL" -f generated/load.sql

# undo:
psql "$PROD_DATABASE_URL" -f generated/rollback.sql
```

The schema must already exist (the backend applies `sqlx` migrations on boot).

## Mapping decisions (see the conversation that produced this)

- **Russian only.** EN/SRB text is dropped from the bodies but preserved in `raw/`.
- **Media externalized to Cloudflare R2**, content-addressed by sha256(bytes),
  downscaled to ≤1280px / JPEG-82 (mirrors `frontend/lib/image-file.ts`). Bodies carry
  public R2 URLs; identical bytes dedup to one object. Run `npm run upload` before
  `transform` — the resolver errors loudly if a valid image has no `r2Url`, so media is
  never silently dropped.
- **All 19 imported as `draft`.** Nothing appears in the public store until
  published from the constructor.
- **5 authors recreated as `editor`s** with a disabled password and **all-synthesized**
  `@imported.geohod.invalid` emails (real addresses, where known, kept in `raw/` only —
  never occupy a real person's email on a login-disabled account).
- **`'11'` answer sentinel kept verbatim** (surfaced in `report.md`).
- **Order = `Page_number`** (ascending). `None`/`Error` pages and the answer-card
  pool page are dropped.
- City/duration are recovered from the Start page (`Place_RU`/`Duration_RU`)
  because bubble's city/country are unreadable reference types.
- Not imported (preserved in `raw/`): bubble reviews + aggregate ratings (our
  ratings are derived from real play); 4 congrats videos (model stores no video);
  per-page custom button texts outside `task_no`.

`page_type → template`: `Start→start`, `Continue→continue`, `Question→task_answer`,
`QuestionNoAnswer→task_no`, `Congratulations→congrats`.
