# GeoQuest

A marketplace of city quests, an offline-capable PWA quest player, and an internal
quest constructor. Event-sourced play over immutable, frozen quest snapshots.

```bash
cd platform
npm install
npm run dev        # backend (:8080) + frontend (:3000)
```

## Repository map

| Path | What it is |
|---|---|
| [`platform/`](./platform/) | **The product** — backend, frontend, goldens, deploy. See [`platform/README.md`](./platform/README.md). |
| [`agents/`](./agents/) | Code-quality rules: [`rust.md`](./agents/rust.md), [`react.md`](./agents/react.md). Followed to the letter. |

## Core model in one paragraph

Identity is anonymous-first: a device mints `dev:<uuid>` and plays offline with no
round-trip; registration attaches an account to that same id (zero migration). Play
is a `grant → attempt → facts` chain — an attempt is created only for a grant holder,
binds the latest published snapshot forever, and facts append idempotently. Balance is
a plain signed fold of facts (it may be negative; there are no correction facts —
sync notices are derived client-side from projection diffs). The same fold runs in
Rust and TypeScript, kept identical by the shared goldens.

## Invariants

Five rules the system may never break:

1. A signed balance may go negative — there are no correction facts.
2. Facts are device-agnostic and idempotent: the same natural key appends once.
3. The completion bonus is awarded once ever, per player and quest.
4. An attempt is frozen to the snapshot it bound at creation; a later publish never rebinds it.
5. The client fold and the server fold produce identical state.

They are enforced mechanically, not by prose: the shared parity fixtures in
[`platform/goldens/parity/`](./platform/goldens/parity/) run the Rust and TypeScript
projectors over the same fact logs and require the same output. A change that breaks
an invariant fails those tests.

## Deploying

A push to `main` runs one ordered pipeline
([`.github/workflows/release.yml`](./.github/workflows/release.yml)): quality gates →
backend image → **the backend is live on the VPS** → the frontend is promoted. That
middle step polls `/health` until it reports the build id of this commit's backend
sources, so a new frontend can never reach users ahead of the backend it needs. The
window is only closed in one direction, so the API must stay backward compatible
with the previous frontend — cached PWA clients outlive any deploy.

The database schema lives in [`platform/backend/migrations/`](./platform/backend/migrations/),
applied by sqlx at startup. Every feature flag ships **off**; a fresh deployment
enables what it needs from the admin panel. See
[`platform/DEPLOYMENT.md`](./platform/DEPLOYMENT.md) for the full first-boot procedure.
