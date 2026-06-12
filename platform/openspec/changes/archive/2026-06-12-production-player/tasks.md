# Tasks: production-player

## 1. Pure model + data

- [x] 1.1 `shared-model`: optional `Media.video { ref?, duration_label?, caption? }`; `wrongAnswersAt` + `shouldOfferHint` pure helpers — vitest first (RED) covering 1st-wrong-no-popup / 2nd-wrong-popup / hint-already-bought / no-hint.
- [x] 1.2 `lib/design-step.ts`: pure `toDesignStep(step: GameStep): DesignStep` mapper (all 7 templates incl. video/duration/caption, action/nav/gift/hint/allowNote) + vitest against ironia + mystery goldens.
- [x] 1.3 `goldens/golden-ironia-sudby-v1.json`: 8 steps, all 7 templates, full design copy (acceptable ['1730'], hint 5, gifts 3/5, navigator coords, allow_note, terminal congrats).
- [x] 1.4 `lib/goldens.ts`: register ironia snapshot.

## 2. Backend

- [x] 2.1 Seed loop publishing BOTH demo quests (mystery + ironia) with real meta; `cargo fmt` + `clippy -D warnings` + `cargo test` green.

## 3. Player

- [x] 3.1 `useOnline()` hook + banner state machine (offline/syncing/done-2.4s/hidden); delete `simOffline` plumbing.
- [x] 3.2 Rebuild `QuestPlayerClient`: designed chrome only (PlayerFrame/TopBar/StepView/overlays/StartGate), CoinToast + coin chime (sound-toggle-gated), wrong-answer threshold via `shouldOfferHint`, real elapsed time on congrats, router-based exit; delete debug card/footer/facts dump/legacy popups.
- [x] 3.3 Rewrite `BundleGate`: bundle → API (store on success) → designed access/unavailable screens; no golden fallback, no fake grant.
- [x] 3.4 Route: `app/quest/[questId]/page.tsx` full-bleed shell; `app/quest/page.tsx` → redirect (`?golden=` compat); delete 9 dead components.

## 4. Sweep + links

- [x] 4.1 Landing: remove dev callout + admin-demo block; buy status stays inside #shop; play links → `/quest/{id}`.
- [x] 4.2 Update links in my-quests, commerce, quest-detail, cabinet, constructor; delete `MarketplaceList.tsx`.
- [x] 4.3 `e2e-identity.mjs` → new URL.

## 5. Gates

- [x] 5.1 `npm run lint` (0 errors), vitest suite, frontend prod build.
- [x] 5.2 Backend fmt/clippy/test.
- [x] 5.3 Manual/Playwright pass: buy → play `/quest/ironia-sudby` through all 7 templates, offline banner via devtools offline, hint popup only on 2nd wrong.
