# GeoQuest

A marketplace of city quests, an offline-capable PWA quest player, and an internal
quest constructor. Event-sourced play over immutable, frozen quest snapshots.

The runnable system lives in **[`platform/`](./platform/)** — a monorepo with a Rust
(Axum) backend and a Next.js 16 / React 19 frontend. Start there.

```bash
cd platform
npm install
npm run dev        # backend (:8080) + frontend (:3000)
```

## Repository map

| Path | What it is |
|---|---|
| [`platform/`](./platform/) | **The product.** Backend + frontend + goldens + deploy. See [`platform/README.md`](./platform/README.md). |
| [`blueprint/`](./blueprint/) | **Canonical product spec** — CONCEPT, SPEC, TECH, PLAN (`*_RU` variants alongside). The source of truth for *what* to build. |
| [`design/`](./design/) | UI/pixel reference — the player/constructor/commerce JSX + CSS canvases the frontend mirrors. |
| [`agents/`](./agents/) | Code-quality rules: [`rust.md`](./agents/rust.md), [`react.md`](./agents/react.md). Followed to the letter. |
| [`old-knowledgebase/`](./old-knowledgebase/) | Archive — prior business docs, analyses, and the legacy Bubble reverse-engineering. Reference only. |

## Source of truth

`blueprint/` is canonical for the product model and invariants; `design/` is canonical
for UI/pixel detail. On a data/invariant conflict, SPEC wins; on a UI conflict, design
wins — and the losing artifact is edited, never left to drift. The few non-negotiable
invariants (signed balance may go negative, device-agnostic idempotent facts,
once-ever completion bonus, version-frozen attempts, client-fold == server-fold) are
spelled out in `blueprint/SPEC.md` and enforced mechanically by the shared parity
fixtures in `platform/goldens/parity/`.

## Core model in one paragraph

Identity is anonymous-first: a device mints `dev:<uuid>` and plays offline with no
round-trip; registration attaches an account to that same id (zero migration). Play
is a `grant → attempt → facts` chain — an attempt is created only for a grant holder,
binds the latest published snapshot forever, and facts append idempotently. Balance is
a plain signed fold of facts (it may be negative; there are no correction facts —
sync notices are derived client-side from projection diffs). The same fold runs in
Rust and TypeScript, kept identical by the shared goldens.
