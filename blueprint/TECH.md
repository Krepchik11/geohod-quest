# TECH

## Snapshots and Versioning
- An explicit Publish action creates a new immutable version (snapshot) of the quest.
- The snapshot contains the full ordered list of GameSteps with:
  - All rich content.
  - Plain acceptable answer lists (for offline client matching).
  - Frozen supporting values (gift coins, hint costs, etc.).
  - Comic images / media references.
  - Navigator data and animation references (when present).
- New attempts and new downloads always receive the latest published version at that moment.
- Old attempts remain permanently bound to the exact version (snapshot) they started with.
- Historical snapshots (or at minimum the data needed to re-materialize them) must be retained on the server indefinitely for any version that still has active or recently-reset in-progress attempts. This allows a player to re-download the exact bundle if they clear their local data.
- Publishing is deliberate. It is not the same as just flipping a "published" flag on mutable content (old system anti-pattern).

## Event-Sourced Progress and Coins
All play actions, completions, coin earnings, and spends are recorded as immutable append-only facts/events:
- AttemptFact (or StepCompletionFact): records what the player actually did on a specific step inside a specific attempt bound to a specific snapshot.
  - Types include: physical_confirmed, answer_submitted, hint_purchased, gift_claimed, attempt_completed, reset_requested, etc.
  - Payload carries the client's local outcome claim (local_is_correct), submitted value (when applicable), coins_delta, note, device_id, local sequence number, client timestamp.
- CoinFact (narrow ledger): records every coin movement (GIFT, COMPLETION_BONUS, HINT_SPEND, RATING_SPEND, LEGACY_CREDIT, CORRECTION).
  - Every fact has an idempotency key (attempt + step + kind + snapshot).
  - Amount is signed.
  - Frozen source amount is copied from the bound snapshot at the time the fact is created.

QuestAttempt current state and the player's master coin balance are not mutated directly. They are deterministic projections (folds) of the fact log.
- Client maintains a local event log + identical projection while offline.
- On reconnect: client uploads pending facts; server appends them (idempotent), projects authoritative state, returns corrections if needed (e.g. overdraft detected → hint unrevealed and balance adjusted).
- Facts from different devices merge cleanly by key (union). Conflicting reveals are resolved by "once revealed, stays revealed".
- Projection policy for current view: per-(attempt, step, snapshot) last-write-wins using (client_ts + device + local_seq). Full log is kept for audit, replay, and analytics.
- Reset of an attempt: by default creates a fresh independent attempt ID (history stays on the old one for replay/audit). Banked global rewards and the grant survive. The selected attempt's facts are cleared for the new projection.

This approach survives all known races (dual-device play, reset concurrent with play, version drift + re-download, coin earn/spend interleaving, long offline, clock skew) without lost or double rewards, and without heroic merge logic.

## Offline PWA Model
- Player downloads a self-contained ~5 MB bundle for a specific snapshot.
- Bundle must allow full play of the entire sequence while disconnected:
  - Render steps according to the 4 templates.
  - Local validation of answers against the plain acceptable list embedded in the bundle.
  - Physical confirmations (trust + explicit "I did it").
  - Hint purchases via the wrong-answer popup (local coin deduction + reveal).
  - Navigator data (if present).
  - Animated/voiced bonus awards.
  - Local projection of coin balance from the frozen gifts + local completions.
- Client is the sole judge of correctness for the snapshot it downloaded. Server never re-validates the outcome on sync — it only records what the client claimed.
- Service worker + Cache API + IndexedDB for offline assets and local event log.
- On reconnect the client syncs facts and receives authoritative corrections (displayed clearly to the player: "syncing...", "balance corrected").
- "Offline mode" banner or indicator while there are pending facts.

## Client vs Server Split
- Client: full local validation + projection + UI delight (animations, voice, immediate feedback) against its snapshot.
- Server: durable append-only log of facts, projectors that maintain read models (current attempt state, player balance, per-version analytics), corrections when local provisional state was wrong, historical snapshot retention.
- Server records the client's submitted value and the client's local_is_correct claim. It does not override the player's outcome for that versioned snapshot.

## Commerce and Access
- A player must have a valid lifetime AccessGrant (or the quest must be free) before they can create an attempt or download any bundle.
- Grant sources (audited): successful payment, coupon redemption, free quest flag, admin grant.
- Grants are idempotent (at most one per player+quest).
- Single quest purchase only (no cart) in v1.
- Coupons are percentage discounts (different percentages supported; 100% coupon = free via coupon).
- Free quests use identical mechanics to paid ones (just added to collection, price 0 or explicit is_free).
- Grants survive content updates (new versions do not revoke existing access).

## Constructor Approach
- Lean form + ordered list as baseline.
- Immediate structured data entry for correctness (especially answers and gifts) because published snapshots are frozen for offline players.
- 4-template picker that pre-fills sensible defaults (button text, confirmation copy, etc.).
- Structured AnswerListEditor (chips/rows + "Paste lines" helper) + live "Test match" box that runs the exact same client matching function that will ship in the bundle for that version.
- Dedicated gift subform (narrative + coins number + note that the value freezes in the snapshot).
- Per-role comic image zones (task, character, hint, atmosphere) + thumbnails.
- Navigator config (geo picker + "enable navigator button" toggle) on physical steps.
- Animation/voice asset assignment for task bonuses.
- Popup hint wiring (default for answer tasks).
- Per-step mini-previews using the real shared player components (against current draft values).
- Pre-publish validation gates + checklist (must have primary comic on Task templates, valid answers, etc.) + optional "dry-run serialize".
- Explicit big Publish button that creates the immutable snapshot and triggers bundle materialization.
- "Save + switch to real player as test user" is acceptable for final validation (exercises the real PWA, real attempt, real coins from this snapshot, real sync).
- Import tab (YAML/JSON paste or file) as power-user path that parses, validates, and loads into the composer list.
- Every publish creates a new version. The editor always works on the "next" draft. Published quests keep their historical steps for active attempts.

The goal for constructor code itself is small, focused, heavily typed components with shared renderers between admin and player.

## Facts as the Unifying Primitive
Progress, coin movements, hint spends, navigator uses, animated bonus triggers, mid-quest FeedbackReports, and rating spends are all expressed as facts/events.
This gives:
- Replay / audit ("what was the balance at date D?").
- Deterministic merge on multi-device and after long offline.
- Clear accounting ("this gift step in vX awarded 10 because this completion was recorded").
- Easy per-version analytics (submitted wrongs, hints used, navigator clicks, reports per step).
- Import path that can synthesize historical facts once (idempotent job) instead of trying to reverse-engineer scattered old mutations.

## Migration from Old System (High Level)
- Historical grants (buy_a_qest + payments + coupons + free) → AccessGrant facts + projections.
- Old answer_card data + user lists + Balance_coin + Getting_5... + page_constructor Gift_Coins → synthetic legacy snapshots (at export-time content) + StepCompletionFacts + CoinFacts (best-effort submitted values and timestamps preserved where possible).
- One-time idempotent job. After import the new system is clean. Legacy items are marked "imported" with notes. Old scalar balance is reconciled via log diffs (manual review, no auto-adjust).

## Non-Functional Basics
- Expected bundle size ~5 MB (images + occasional 10-30s videos + structured content + now also comic roles, navigator data, animation/voice refs). Must be re-estimated with real assets.
- PWA must support full play while offline and graceful degradation on low-end devices.
- No GDPR / data retention obligations.
- Growth rate unknown — design for small-to-medium scale first with clean boundaries.