## Context

Current state after three archived cycles (quest-player-pwa: 4-template player + goldens fidelity + ctor "Save+test"; backend-facts-sync: append-only + client-matched projectors on real export goldens ("МИХАЙЛО ПУПИН"+gift+5 + edges) + idemp + corr + manifest + rust gates; player-reconnect-wiring: real reconnect wiring making simulate use the contract, TDD goldens reconnect/corr cases, enhance existing small, 100% shared, YAGNI, gates): facts model + 4-template player + offline/reconnect real on export data per PLAN are locked. Frontend landing has 3-component cards with Marketplace stub describing "Buy once (or get free/coupon). Lifetime access grants." Ctor has publish stub (local alert + serialize) + "Save + open in real player". Backend: InMemoryFactStore (Mutex, natural key idemp, projectors exact match, manifest for snaps, corrections, tests green on goldens + reconnect). Player: small comps (QuestPlayerClient reducer for facts + sync to /facts /state, OfflineBanner, etc), 100% import shared-model for isAnswerCorrect/project*/Fact. Shared: QuestSnapshot + GameStep + Fact + pure fns + goldens (mystery + happy). No grants, no checkout, no published list, no eligibility yet (demo always allows). Primary: ../blueprint/PLAN.md (Phase 3 Commerce/Marketplace bullets + explicit cuts + risks), SPEC.md (AccessGrant: player+quest, lifetime, source Payment/CouponRedemption/FreeQuest/Admin, idempotent, required before attempt/bundle, survives versions; Commerce v1 single quest + % coupons incl 100%, free identical, Marketplace peer with primary comic + template summary), TECH.md (client/server: grant before attempt, snapshots frozen, facts append-only). Archived artifacts (proposals/designs/specs/tasks for player-pwa/facts/reconnect) + current code + goldens + agents (rust/react) + old-knowledgebase/02_COMMERCE... + analysis/commerce-grants-variants read as deps. OpenSpec status: proposal done; this design + specs ready.

Per full adversarial cycle (deconstruct/expose/rebuild/self-crit applied to every decision below and to proposal/specs/tasks): see Decisions and Risks for exposed flaws + superior choices + self-crit.

## Goals / Non-Goals

**Goals:**
- Lifetime AccessGrant as idempotent source-audited record (not mutable flag); checkout (stub/simple) creates grant + applies coupon % (100% = free source); free quests identical grant/attempt/snapshot/facts mechanics (source=FreeQuest).
- Peer Marketplace surface (enhance existing landing card + small comps): lists published quests (derive primary comic + 4-template summary 100% from snapshot data); "buy once" or "get free" buttons create grant through surface; publish flow (ctor) surfaces to list (register snapshot meta).
- 100% reuse: snapshots (listing/owned checks + summary), facts/projectors (post-grant usage/attempt eligibility), existing goldens + player-replay.test.ts (extend for grant creation idemp + post-grant attempt eligibility + coupon redemption + free identical); enhance existing small (no god, no dupe logic).
- TDD goldens contract first (RED on grant/attempt/coupon flows in replay + new backend tests, then impl to green); client/server invariants (grant required before attempt facts; snapshot frozen at publish/buy time; idemp on (player,quest)).
- Backend: minimal in-mem grants store (idemp create, lock for races, explicit extension point like facts for future Jsonl/Sqlite); routes for list quests, checkout, grants check, publish surface; integrate with facts store in AppState.
- Frontend: small focused per react (MarketplaceList, CheckoutForm w/ coupon input, PublishSurface hook); narrow 'use client' island in landing or co-located; ctor publish enhanced to surface (POST register); player additive eligibility gate (prop/fetch based, preserves reconnect/goldens).
- Strict agents (rust.md: docs on pub, #[test] mods, 4-space, no unwrap, Result; react.md: no waterfalls, derived in render, small comps, narrow deps/effects, no barrels); TDD/SOLID/DRY/KISS/YAGNI; quality gates (replay green + grant cases, cargo test/clippy/fmt -D, frontend build/lint, reuse greps, manual flows).
- Survives races (concurrent buy/grant creation, coupon double-redeem, publish while checkout, grant for historical snapshot, multi buy same, grant during active attempt, multi-device, version publish mid-flow); audit via source; "buy once" lifetime (grant independent of later versions).

**Non-Goals:**
- No real-money (YAGNI per cuts; stub checkout always "succeeds", fake or omitted price, no gateway/coin purchase).
- No recurring subscriptions, no multi-quest cart, no external authors, no deep coupon model (limits/validity/uses_count/persistence — simple % input or code; redemption source only).
- No full snapshot storage on publish (register id + summary meta only; reuse goldens for demo listing).
- No persistent grants (in-mem; documented swap path like facts; restart loses ownership acceptable for this slice).
- No new attempt creation endpoint or full server grant gate in facts append (client gate + eligibility pure for TDD; server stub for future; demo attemptId still works).
- No high-fidelity preview, advanced normalization, magic links, etc. (per cuts).
- No bloat: no shared crate yet (YAGNI until dupe proven), no SWR/retry libs, enhance not rewrite prior player/facts code.
- Marketplace remains card/section in landing (no full /marketplace route yet); demo player fixed ("demo-player").

## Decisions

**Decision: Grant key = (player_id, quest_id) primary for idemp/lifetime "at most one"; source is audited field recorded at creation time (not part of uniqueness). Concurrent create or different source attempt returns existing grant (no-op, no double).**

Rationale (after deconstruct): Per SPEC "idempotent (at most one per player+quest)", "lifetime", "survives new quest versions", "required before create Attempt". PLAN "Buy once, own forever". Old anti-pattern mutable has_access flag exposed: concurrent race (two buys both succeed), no source audit (can't distinguish Payment vs CouponRedemption vs Free or correct errors), can't replay/audit like facts, violates immutable append-only + snapshot invariants proven in prior cycles. Using (player,quest,source) per some briefing notes would allow multiple (e.g. free + paid on same) which contradicts "buy once" and "lifetime access". Natural key + exists check under short lock (like facts append_idempotent) survives concurrent buys (one wins, other sees existing). Source recorded for audit (Payment/CouponRedemption/FreeQuest/Admin) enables future admin visibility without extra table. In-mem HashMap<(String,String), AccessGrant> + vec audit log option for history (YAGNI full log now).

Alts considered & rejected:
- Mutable user.has_access map or scalar: races, no audit, correction impossible, drifts from facts/snapshots contract (harshly exposed in deconstruct).
- Append-only GrantFact in facts log: mixes access with progress (violates separation in SPEC/TECH; facts per-attempt, grants lifetime per-quest); bloats facts enum for non-progress.
- (player,quest,source) uniqueness: allows "double buy" semantics, contradicts PLAN "buy once".
- Full coupon entity + validation store now: violates YAGNI (no real coupons in cuts; simple % suffices for grant source + UI demo).
- Client-only grants: server bypass, no idemp across devices/reload, no future admin.

Self-crit of this choice: survives? Yes — idemp + source audit per PLAN/SPEC, simple, reuses facts store pattern (DRY), TDD testable (idemp cases in goldens + rust tests), no bloat. Flaw: if business later wants one-per-source (e.g. coupon + payment both count?), requires key change + migration; but YAGNI now, explicit in design. In-mem loses on restart (like facts pre-persist); documented.

**Decision: Marketplace is peer surface (list + buy flows through it); published quests registered on ctor publish (backend in-mem published meta: id, name, primary_comic, template_summary); list derives comic + summary 100% from snapshot data (reuse getSnapshot or registered meta); buy/get-free POST /checkout creates grant.**

Rationale: PLAN "Marketplace as peer component: lists published quests with primary comic + template summary; publish flow surfaces to it; grants/purchases flow through the surface." "peer not god". Current stub card + ctor publish isolated (publish alert only). Rebuild: enhance landing card to dynamic list (RSC + small client island for interactivity per react), small MarketplaceList/CheckoutForm (no dupe snapshot logic — import shared + derive primary = first task media.task or atmosphere or stub; templates = steps.map(t => t.template).reduce count or string). Ctor publish (on success after gates) does fetch to /api/quests/publish {quest_id, name, primary_comic: derive from local snap, template_summary, snapshot_version} (registers idemp in backend). Marketplace fetches /api/quests for list. "Buy" in list calls checkout (coupon input in form), on success marks owned locally + enables play link. Reuse snapshots: listing uses same GOLDENS + getSnapshot as player/ctor (DRY, fidelity). Free vs paid: "Get free" or coupon=100 both -> source FreeQuest or CouponRedemption, identical grant record + player eligibility.

Alts rejected:
- Marketplace god component with embedded snapshot parse + grant state + buy logic: violates small comps (react), DRY (dupe from shared/goldens), not peer.
- Client-only published list (no backend register): publish doesn't surface reliably, grants (backend) out of sync with list, multi-device demo broken.
- Full snapshot persist on publish for list: YAGNI (goldens + meta sufficient; facts manifest already for attempts; adds size/serde now).
- Separate "published" facts: mixes concerns (quests vs attempts).

Self-crit: survives? Yes — peer small comps, 100% snapshot reuse for comic/summary (no dupe), publish surfaces via contract (ctor -> backend -> marketplace visible), grants/purchases thru surface, YAGNI (meta only). Flaw: publish timing (ctor local snap vs server registered) — if network fail, list stale until reload; mitigated by client optimistic + manual "refresh list"; tasks cover manual verify. For real quests (non-golden), meta must be sent (ok, additive).

**Decision: Checkout is stub (always succeeds for demo; no price enforcement or external payment); coupon is simple numeric % input (0-100); if 100 or free button -> source=CouponRedemption/FreeQuest; grant created idemp via store; "identical mechanics" means same snapshot access + facts post-grant + attempt eligibility path for free/paid/coupon.**

Rationale: PLAN "Single quest checkout + coupon % (including 100%)", "Free quests (identical mechanics)". "No real-money coin purchases". Expose: no 100% path would special-case free quests (different grant/attempt code, drift from goldens/facts contract). Coupon double-redeem race: for YAGNI no persistent coupons, simple input just sets source (no uses_count decrement); future store would need idemp redeem like grants. 100% treated as free source makes mechanics identical (grant record same shape, eligibility same, post-grant facts/attempts unchanged). Stub checkout: input coupon, player/quest, create grant (source logic), return; UI "buy once" vs "get free" or coupon field. Reuses player facts flow post-grant.

Alts rejected:
- Real prices + coin deduction on buy: violates explicit cuts ("no real-money coin purchases").
- Persistent coupon codes with validation/limit: YAGNI (deep UI + store bloat; % input + source sufficient for TDD goldens + demo).
- Different attempt path for free: violates "identical", PLAN/SPEC, would require goldens fork.

Self-crit: survives? Yes — coupon 100% free identical, stub YAGNI per cuts, idemp via store, simple % for UI. Flaw: no price display realism or coupon code validation (user can "100%" any quest); documented YAGNI, sufficient for "enables real commerce" per briefing. Races (concurrent coupon redeem) not hit in demo (single user); store lock + idemp protects grant.

**Decision: Backend grants as parallel InMemoryGrantStore (or co-located in existing store.rs behind same Mutex pattern); new thin grants.rs for types (Grant enum or struct with source) + idemp fn + docs + #[cfg(test)]; AppState holds both; no new deps. Frontend grant status via fetch or prop (demo fixed player); eligibility additive in player (before append or start) + pure helper in shared for TDD replay.**

Rationale (deconstruct): Current facts store uses Arc<Mutex<InMemoryFactStore>> + short critical sections (pure). Replicate for grants (separate concern: lifetime vs per-attempt progress) keeps SOLID (single resp). Co-locate in one store risks god. New module per rust (thin, documented). Idemp fn mirrors append_idempotent. For eligibility: since no attempt create yet, client gate (hasGrant state from marketplace success or fetch /grants/check) + server can 4xx later on facts if needed (YAGNI now). Pure isEligible(grant: AccessGrant | null, quest_id, is_free_quest) in shared for goldens replay tests (RED first: attempt facts without grant -> fail eligibility; with grant or free -> allow). Reuse facts for post-grant (no change to projectors).

Alts rejected:
- Grants as facts in same store: pollutes progress log with non-attempt events; eligibility would scan all facts (inefficient, wrong scope).
- Full DB grant table now: violates YAGNI (in-mem like facts was).
- Pure client grants: no cross-device idemp, no server audit for future admin.

Self-crit: survives? Yes — reuses exact facts store pattern (DRY, robustness on lock), separate module clean, pure for TDD (goldens), client/server split per prior (client authoritative for now). Flaw: two Mutexes in state (minor; or one combined state later); in-mem for grants (same as facts, restart loses "owned" — tasks document + manual note "re-grant after restart"). Eligibility not yet in facts append (would require quest_id binding on attempt; current snap_id only; future slice).

**Decision: TDD goldens first + extend existing player-replay.test.ts (and backend tests) for grant flows; RED (assert create idemp fails without impl, post-grant attempt eligibility, coupon 100% source, free identical projection/attempt) before any grant/checkout/marketplace code; turn green after.**

Rationale: Prior cycles non-negotiable: "goldens + facts/snapshots the TDD contract". Expose: no goldens for grant/attempt post-grant -> drift (like pre-facts-sync server/client mismatch on "owned" + eligibility). Extend replay harness (already has normalize, sim facts from actions/snap, project asserts on happy "МИХАЙЛО ПУПИН"+5) with grant mock scenarios: createGrantIdemp(player,quest,source) -> {grant, created}, assert idemp second call returns existing not new; isEligible(grant, quest) true -> allow facts sim; 100% coupon -> source=== 'CouponRedemption' but mechanics (snapshot used, facts produced) identical to free source; free quest grant source 'FreeQuest'. Backend tests: concurrent append sim under lock, post-grant facts ok. Matches "TDD goldens for grant creation + attempt post-grant + coupon redemption + free identical; idemp grant creation".

Alts rejected:
- New separate grant-goldens.json + test file: violates DRY (enhance existing per prior reconnect), more files than needed (YAGNI).
- Impl first then test: violates TDD + "RED for grant/attempt" in briefing + prior artifact pattern (player-replay started RED).

Self-crit: survives? Yes — goldens drive (non-negotiable fidelity), reuse existing test (small), covers races/idemp/coupon/free/attempt. Flaw: replay is client sim; backend grant tests separate (ok, rust #[test]); no full e2e "buy in market -> grant -> player attempt" until manual (tasks cover).

Other decisions (brief): in-mem grants (explicit swap comment like facts store.rs); coupon UI minimal (numeric input, no code validation beyond %); publish surface timing (optimistic client + fetch, tasks manual); eligibility client primary now (server later); demo player fixed string; no prices (symbolic or omitted).

## Risks / Trade-offs

[Concurrent grant creation (double-click buy or multi-tab)] → Mitigation: idemp create under Mutex lock + exists check (returns existing; no double record); TDD goldens + rust tests cover; short critical section (pure like facts).
[Coupon double-redeem or 100% abuse] → Mitigation: YAGNI no persistent coupon store (simple % sets source only; no uses decrement); grant idemp still protects quest access; future store would mirror grant pattern.
[Publish while checkout / version drift mid-flow] → Mitigation: grant binds to quest (not specific snapshot version); marketplace lists current published meta (registered at publish time); buyer gets access to latest at play time (per SPEC "new attempts use latest"); historical for old attempts via facts manifest. Ctor publish surfaces immediately for demo.
[Grant during active attempt or multi-device grant visibility] → Mitigation: lifetime grant independent; player eligibility checked on load/start (additive); facts idemp already handles multi-device; grant fetch or local state after buy.
[In-mem grants lose ownership on backend restart (unlike player LS)] → Mitigation: explicit like facts (InMemoryGrantStore comment + extension point); demo re-grant easy via marketplace; TDD unaffected; documented YAGNI (swap to persist same as facts plan).
[Eligibility only client gate (bypass possible until facts append checks quest)] → Mitigation: server stub ready (checkout/grants routes); future append can take player/quest and 4xx or correct if no grant (additive, no rewrite); goldens TDD covers client sim eligibility; manual "buy -> attempt" verifies.
[Marketplace list stale if ctor publish fails to register] → Mitigation: initial golden hardcoded as published; client can re-fetch; publish in ctor awaits response or falls back to alert; tasks include manual surface verify + reconnect.
[Scope creep to real payment/cart/auth] → Mitigation: explicit YAGNI + cuts in proposal/tasks; pre-impl grep gates in tasks (no "payment|stripe|cart" etc); self-crit at end.
[Dupe logic or god in marketplace/player] → Mitigation: 100% snapshot reuse (derive in one place), small comps only, grep for imports/reuse in gates; enhance existing (landing card, player client) not new pages/routes.
[Goldens drift post-impl] → Mitigation: RED first (failing asserts on grant/attempt/coupon), green only after; replay + backend tests + manual; prior fidelity preserved (happy path untouched).

## Migration Plan

- No prod data/migrations (YAGNI; in-mem only).
- On apply: artifacts written; impl per tasks (TDD goldens RED->green, gates); manual "from ctor publish -> marketplace sees it -> buy/get free (coupon 100%) -> grant created idemp -> /quest attempt eligible, facts flow, reconnect still works".
- Future: swap InMemoryGrantStore for persistent (same API); add real coupon entity when needed; gate facts append by grant (player/quest binding); persist published quests with full snapshot data.
- Rollback: revert change dir + code (no data loss; goldens unchanged).

## Open Questions

- Exact player_id strategy for demo vs future auth (fixed "demo-player" now; query param? localStorage?).
- Whether grants should emit "grant_created" fact for analytics (future admin per-version grants count) — YAGNI now, separate from progress facts.
- Coupon model depth (code validation, per-user limit, quest scope) when real coupons arrive (deferred per YAGNI/cuts).
- Bind grant to specific snapshot_version at buy time (for "bought this version") or always latest — current follows SPEC (survives, new attempts latest).

All decisions survived full cycle (deconstruct exposed mutable/race/no-audit/no-goldens/god/dupe; rebuild chose idemp record + source + peer small + 100% reuse + TDD RED + YAGNI in-mem; self-crit applied: idemp+audit+identical+small+reuse+goldens hold, remaining flaws documented + mitigated + task-covered). Design references proposal for Why/What, will reference specs for exact reqs/scenarios. Ready for specs/tasks.