# Offline PWA and Progress Model — The Highest-Risk Area (Business Concept v0.2)

**Status:** Updated with direct decisions (2026-06). Client performs full offline validation against the downloaded quest version. No server re-validation of answer correctness on sync. New downloads/attempts get the current published version.

**This document exists because offline play is a hard requirement. The model is deliberately simplified per stakeholder direction: trust the local snapshot for the lifetime of attempts started against it.**

## Hard Requirements

- The application must be a PWA installable on mobile (and desktop).
- A player must be able to **load/download a full quest** (content, media, step definitions, enough information to advance) and complete the experience **while completely offline**.
- Progress (step completions, answers submitted, hint spends, attempt status) made offline must be preserved locally and **synced** when the device returns online.
- Location is display-only (map pins, "show on map" for hints). No real-time geofencing enforcement required for v1.
- Server remains the source of truth for final correctness of answer steps and for granting access.

## Core Decision (Locked)

- The client must be able to fully validate progress **offline** against the quest content it downloaded.
- Each downloaded quest carries its own **version/snapshot** with embedded validation data (correct answers as list of acceptable strings for answer steps).
- Validation happens entirely against that local snapshot.
- **No re-validation of correctness on sync.** The server records what the player submitted and the local validation result for that version.
- When a player starts a *new* quest attempt (or downloads fresh), they receive the latest published version of the quest.
- Old attempts/bundles remain valid against the version they were started with. This freezes the "correct" answers for those playthroughs.

This removes the two-phase tension at the cost of freezing answer correctness per downloaded snapshot.

## Updated Offline Model (v0.2 — per decisions)

### 1. Downloadable Quest Snapshot (Versioned Bundle)
- A player with valid AccessGrant (or free quest) can download the current published version of a quest.
- The bundle is a self-contained snapshot containing:
  - Full GameStep sequence + all rich content (text in Russian, images, short videos 10-30s, geo for display/hints).
  - For answer-required steps: the list of acceptable answers (strings, possibly multiple synonyms/phrases/numbers) exactly as authored for that version.
  - Version identifier (quest + published version or snapshot id).
  - Integrity information (hash of the snapshot for the client to verify on load).
- ~5 MB expected total size per quest — highly feasible for PWA caching (Service Worker + IndexedDB for structured data + Cache API for media).
- The local quest version is the sole source of truth for validation during any attempt started from that download.

### 2. Pure Local Validation + Recording Sync
- **While offline (or even online):**
  - Physical / no-answer steps: Player performs the real-world action (go to location, touch the statue, etc.) and then taps the confirmation control in the app ("I completed this step", "I found the object", "Done"). This marks the step complete locally. There is no "correct answer" to validate — completion is the player's explicit action.
  - Answer-required steps: Player enters their answer (text, number, phrase). Client compares against the list of acceptable answers in the local snapshot (initially simple exact or "contains" match; normalization rules added later). Immediate feedback: correct / wrong + wrong answer counter.
  - Hint spend (coins): Deduct from the attempt's local coin balance (or player's cached balance), reveal the geo pin + any hint content for that step. Purely local.
  - Narrative, video, gift, terminal steps: Advance with the appropriate UI control. Gifts may award coins locally.
- Player can fully complete (or partially play) quests using only the downloaded snapshot.

- **On sync / reconnect:**
  - Client uploads the attempt's StepCompletions for this snapshot version:
    - Which step
    - Submitted value (for answer steps) or confirmation flag (for physical steps)
    - Local is_correct / completed result according to the snapshot
    - Timestamp(s)
    - Coins spent on hints for specific steps
  - Server **records** the submissions and local outcomes as facts about that attempt + that quest version.
  - Server does **not** re-validate correctness against the live quest.
  - Server reconciles coin balance (master player coins = sum of earnings from completed quests/gifts minus spends). Local spends are applied.
  - Server may record analytics (what wrong answers were submitted against this version) for authors.
  - If the player later starts a *new* attempt on the same quest, they download (or use) the latest published version at that moment.

### 3. Versioning & "Next quest will be started with synced new version"
- Quest has a publishing/versioning mechanism (at minimum: Draft vs Published, plus a content version or snapshot id that increments on significant publishes).
- An attempt is tied to the specific quest version/snapshot it was started against.
- Old attempts continue to be playable and validatable from their original local bundle (or re-download of that exact snapshot if the player clears data).
- When the admin publishes an updated quest, only *new* downloads and *new* attempts see the changes (including new/corrected answer lists).
- This matches the stated intent: client validates its local version fully; new play starts fresh with current content.

### 4. Sync Payload (Minimal Authoritative Record)
The server stores, for each StepCompletion in an attempt:
- quest_version / snapshot_id
- step_position or step_id
- submitted_answer (string or null for physical steps)
- player_confirmed (boolean for physical steps)
- is_correct (boolean — as determined by the client against that version)
- coins_spent_on_hint (integer)
- completed_at (client time)
- synced_at

This is recording + analytics, not re-authoring the outcome.

### 5. Answer Data in the Bundle (per decisions)

- For answer-required steps the bundle includes the list of acceptable answers as plain strings (as entered by the admin for that version).
- In the quest constructor, this is a simple multiline input (one value per line).
- Initial client matching: simple (exact match or membership in the list, possibly basic case-insensitive contains for MVP).
- Normalization (trim, case folding, punctuation removal, number canonicalization, synonym handling) is explicitly a later iteration.
- Because the client needs to validate fully offline, the acceptable answers must be present in usable form in the local snapshot. (Cheating model is deprioritized per direction for v1.)

### 6. Physical Steps Clarification (Proposal — Needs Confirmation)

Physical / "no answer required" steps are the ones where the designed experience is "go to a real place, find an object or perform a physical action (e.g. touch the cold metal hands of the statue), then mark the step done in the app."

In the model:
- The step has rich descriptive content + optional geo pin (display only, "show on map" if hint coins spent).
- There is **no list of acceptable answers**.
- Completion = explicit player action in the UI: a prominent "I did it", "Found it", "Completed this task" button (possibly with optional short free-text note like "felt the cold metal").
- The client records it as completed with `player_confirmed = true`.
- No "is_correct" computation beyond the fact that the player chose to mark it done.
- These steps are the easiest for pure offline because there is nothing for the client to "get wrong" except the player's own honesty about having done the real-world action.

If this does not match the intended experience for physical steps, provide counter-examples.

### 7. Attempt, Replay, Reset & Continue (Unchanged from prior, reinforced)

- QuestAttempt remains the unit of one playthrough and is tied to a specific quest_version/snapshot.
- Multiple attempts per player per quest are supported.
- "Continue" = resume the latest (or selected) in-progress attempt using its original local snapshot data + any synced state.
- "Reset progress" on an attempt = clear its StepCompletions locally (and on next sync). The attempt record and grant survive. Player can start the sequence again with the same version's answers.

**Post-SYNTH 2026-06 update (from ANALYZE-05 + reviewer + client mismatch + 08_DECISIONS_LOG):** Progress and coin movements are append-only facts (AttemptFact with device_id + local_seq + snapshot_id + local_is_correct claim + coins_delta; unified CoinFact ledger). Sync = append pending facts (idemp by fact_id) + pull + re-project + explicit corrections (no "last-write or union", no destructive "clear" for reset). Reset default: new independent attempt id (history preserved on old for replay/audit; banked rewards + grant survive). Client maintains local event log + identical deterministic projection for full offline (must match server fold exactly; golden tests from real quests). Bundle now includes (per client req + mismatch): comic role images (task/character/hint/atmosphere), navigator data for location steps, animation/voice refs for bonuses. Historical snapshot retention mandate (acceptable lists + positions + gift amounts + comic/nav refs) for re-dl of in-progress/cleared old attempts. See business/analysis/review-progress-sync.md, client-requirements-mismatch-analysis.md, CONCEPTUAL_DESIGN_RU.md, and 08 for schema, policies (per-step LWW for current view + full log), client flows (4 templates, wrong-popup hints, any-page FeedbackReport, navigator, rating coins), and full invariants. "Facts as source, projections as read model" is now the locked model across Play & Progress + Coins.
- New attempts (after reset or after finishing) can pull the latest quest version if the admin has published updates since the previous attempt was started.

### 5. Sync Strategy Invariants

- All offline mutations are eventually consistent and converge to server truth.
- A completion that the server marks incorrect (or a hint spend that would overdraft coins) can cause the local attempt state to be corrected on next load.
- Player should see clear indication when they are "offline mode" vs "synced".
- If connectivity returns mid-quest, the player should not be forced to stop; background sync is ideal.

## Edge Cases (Updated for v0.2 Model)

- Admin publishes corrected answers or new steps → only affects new attempts / new downloads. Old attempts keep their frozen version's answers and outcomes. This is intentional.
- Player has an old bundle with "wrong" answers (from author's perspective). They complete the quest using the old definition. The attempt is recorded with the version it used. Analytics will show the version.
- Multi-device: Each device can have its own local snapshot + local attempt state. On sync the server merges by (attempt, step, version). Last-write or union semantics needed for coin spends and completions.
- Storage: 5 MB target is comfortable. Client should still warn if many quests are cached or if device is low on space.
- Re-download / reinstall: Player can re-download the exact version of a quest for which they have an in-progress attempt (if the system keeps historical snapshots) or fall back to latest for new attempts. Progress for old attempts should be recoverable from server records where possible.
- "I completed a physical step but later want to undo" — reset of the attempt covers this.

## What the Old System Had (and Why It Is Insufficient)

The old `answer_card` + complex scheduled API workflows had no versioning, no bundle concept, and no intentional offline design. All validation was server-side via workflows that assumed connectivity. We have replaced that with an explicit snapshot + local validation model.

## Remaining Risks & Self-Critique of This Model (v0.2)

- Freezing answers per version means a buggy quest version can never be "fixed" for players who already downloaded it. They will always see the old (possibly wrong) correct answers for their attempts.
- No server re-validation means the recorded `is_correct` is only as good as the client implementation for that version. If the client has a bug in matching, the server will happily record the wrong outcome.
- Analytics on "what answers players actually submitted" becomes more valuable because we cannot correct after the fact easily.
- Snapshot storage on server (to allow re-download of old versions for existing attempts) adds a requirement we must decide on.
- Physical steps still rely entirely on player honesty about having done the real-world action. This is accepted.

This model is simpler and directly satisfies the "client validates offline, new play gets new version" rule. It is also less robust for content quality over time.

## Self-Critique of This Section (as required)

(Old two-phase critique section removed — superseded by the v0.2 client-local-validation model above.)

## Dependencies (Updated)

- Content model and how authors enter the list of acceptable strings per answer step (see 04_).
- Quest publishing / versioning mechanism in the constructor (when does a new version become available for new downloads?).
- Whether we retain historical quest snapshots server-side (for re-download of old versions tied to in-progress attempts).
- Exact player confirmation language and UI for physical steps: "no difference" across physical steps. All use the same simple confirmation mechanism (player marks the step done after performing the real-world action). No subtypes or special variants for v1.

**This is now the authoritative offline model for v1.**
