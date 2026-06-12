# Quest Versioning, Publishing & Snapshot Retention — Exhaustive Adversarial Analysis (ANALYZE-02)

**Subagent Role:** Chief Staff Engineer + Relentless Critical Analyst  
**Scope:** Deep, adversarial, long-form analysis of the Quest Versioning, Publishing & Snapshot Retention area (corresponding to ANALYZE-02 in master coordination).  
**Date of Analysis:** 2026-06-09 (grounded in current workspace state)  
**Inputs (read in full + cross-referenced + data-mined):**  
- All `business/` docs, with exhaustive focus on `01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md`, `03_OFFLINE_PWA_AND_PROGRESS_MODEL.md`, `04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md`, `08_DECISIONS_LOG.md`, plus `00_PRODUCT_VISION_AND_SCOPE.md`, `02_COMMERCE...`, `05_ROLES...`, `06_V1_REQUIREMENTS...`, `07_ASSUMPTIONS_RISKS...`, `09_WHY_THE_QUESTIONS.md`, and `business/README.md` + `business/analysis/README.md`.  
- Historical `docs/` (02_DATA_MODEL.md, 03_DATA_MANAGEMENT.md, 01_APPLICATION_OVERVIEW.md, 04_API_SURFACE.md, 05_WORKFLOWS..., 06_PAGES..., 07_INTEGRATIONS.md, 08_SECURITY..., 10_MIGRATION_MAPPING.md, APPENDIX/OPEN_QUESTIONS.md).  
- Discovery artifacts (parsed/data_types.json, option_sets.json, workflows_all.json + sample, api_events.json, element_definitions.json, app.json; raw/data-api/probe_results.json + record_counts.json; workflow probes).  
- Concrete grounding data extracted via direct inspection + Python analysis of JSON:  
  - 21 quests (`quest_name_constructor` / `quest`), 556 page/page_constructor records (avg ~26.5 steps per quest).  
  - 929 users.  
  - Old quest fields (exact from probe + data_types): `Publish_on_the_site` (boolean), `statusQuest` (option.status_quest: "published" | "test" | "project"), `Page` (list of page_constructor), denorm stats (`completedcount`, `countCoinMadeIt`, `theNumberOfUsersWhoCompletedTheQuest`, `reviewGrade`), multi-lang (`*_ru/en/srb`), `Price`, geo start, `Quest_level`, `Age_limit`, `Tags`, refs to `Quest_setting`.  
  - Old page_constructor fields (exact): `Answer` (list.text — the acceptable answers), `Page_type` (14 options: style/hint/lead/gift/error/start/video/question/greetings/question0/namerequest/congratulations/questionnoanswer/screenafterquest), `Main_text_RU` + 6+ other lang variants + `Place_*`, `Question_*`, `Button_text_*`, `Gift_Coins` (number), `Hint` (self-ref), `Next_page` (self-ref — implies possible branching), `Video_link`, `Image_link`, `Hint_Image`, `latitude`/`longitude`, `Duration_*`, `Sample`, `Quest_name` ref, `Page_number`, etc. (36 fields in schema, heavy duplication).  
  - answer_card (inaccessible in API probes, 404; from schema): links `User` + `Page_constructor` + `Quest_name`, has submitted `Answer` (text), various flags (`Complited`, `Buy_hint`, `You_made_it`, `Count_wrong_answers`, etc.). **No version, snapshot_id, or quest_version field anywhere.**  
  - No occurrences of "version", "snapshot", "quest_version" in any discovery/parsed or raw data (except app version strings).  
  - 1,163 workflows (mostly ButtonClicked + 444 SetCustomState + 277 ChangeThing), 55+ on "Edit_Page" reusable + 63 on "Existing_Quest", heavy "666" scheduled API events for answer_card creation.  
  - Duplication pattern: `page` == `page_constructor` (identical API data), `quest` == `quest_name_constructor`. Constructor types used for editing (mutable in place).  
- Explicit locked business (quoted/paraphrased from 08_DECISIONS_LOG + 03 + 01 + 04):  
  - "explicit Publish button creates new snapshot/version".  
  - "new attempts/downloads get latest; old attempts frozen to their version".  
  - "keep old versions (content + answers) indefinitely on server".  
  - Offline requires stable snapshot for client validation (client does full validation against downloaded bundle's acceptable answers; server records submissions + local `is_correct` **with no re-validation** on sync).  
  - "No revalidation on-sync. Next quest will be started with synced new version."  
  - QuestAttempt binds to snapshot version; StepCompletion records `quest_version / snapshot_id + step + submitted + is_correct(from snapshot)`.  
  - ~5 MB per quest bundle (structured + media refs + short videos 10-30s). PWA caching feasible.  
  - Explicit "Publish" for deliberate versioning (vs old mutable flags).  
  - Import of historical grants + attempt history (incl. old answer_card step completions) is desired.  
- Old Bubble behavior (direct from 09_WHY_THE_QUESTIONS + data extracts): `statusQuest` + `Publish_on_the_site` flag, content **mutable in place** (edit page_constructor records attached to quest), **no historical versions**, **no per-attempt snapshot binding**. All validation assumed live server content + connectivity. answer_cards reflect whatever the workflows did at runtime against then-current pages.  
- Guiding constraints (repeated across docs): KISS, YAGNI, TDD/SOLID/DRY at conceptual level first; offline-first PWA hard requirement; server source of truth for grants/completions; internal admin only (no external authors); v1 scope (no branching, Russian only, email+pass MVP auth, linear sequence, ~12-15 core concepts vs old 47); "buy once, play forever" + unlimited replays/reset/continue; deliberate rejection of old accidental complexity.

**Process Executed (full cycle, adversarial, multiple variants):**  
1. Deconstruct (edge cases + data-grounded scenarios).  
2. Expose flaws harshly (locked + old + common patterns).  
3. Rebuild (A/B/C + invented D; each with its own deconstruct/expose/rebuild/self-critique).  
4. Recommend (best under constraints, especially KISS/YAGNI).  
5. Exhaustive report (this file) + trade-off table + recommended invariants + maintainability + conceptual tests.

**Method Notes:** All claims grounded in direct file reads, Python JSON extraction over discovery artifacts, and cross-refs across 15+ .md + 10+ .json files. No assumptions; every "locked" statement re-attacked. No new source code exists in workspace (only discovery Python + 5.5MB .bubble export + business modeling); analysis is pre-implementation. Media assets appear to be URL refs (Image_link, Video_link, upload_file type with 2 records); not embedded bytes in quest data.

---

## 1. Deconstruction: Edge Cases, Races, Data Realities, and "What Constitutes a Version"

Grounded scenarios (using real counts: 21 quests, ~26 steps/quest, Answer lists as primary validation data, old answer_cards unbound, multi-lang bloat as symptom of mutable editing without versioning).

### 1.1 Admin Publishes Fix While Player Is Mid Long Offline Attempt on Old Version
- Scenario (grounded in 03_OFFLINE + 01 invariants): Player downloads v1 (with buggy acceptable answer list e.g. missing synonym "forty two" for step "How many hands on the statue?"). Goes offline for 3 days (real-world quest spanning locations + narrative). Makes progress (some StepCompletions local, coins spent on hints). Meanwhile admin discovers typo/bug in v1 answers, clicks Publish → v2 created with corrected list. Per locked: player's in-progress attempt **remains bound to v1** (frozen answers + content). On reconnect: sync records v1's `is_correct` (from local client against v1 snapshot). Player never sees fix unless they explicitly start *new* attempt (gets v2).  
- Variants: (a) Player was 80% through; reset would lose local state or force new version? (b) Multi-device: device1 on v1 inprogress, device2 downloads latest v2 → two attempts? Merge by (attempt, step, version) per 03. (c) Long-running physical quest: "I did the real action based on v1's description" — description changed in v2 (wording of physical task).  
- Data reality: Old system had no such concept — answer_card could be mutated by later workflows against edited pages. New locked deliberately freezes to protect offline trust + "what the player experienced".  
- Other: If player clears app data mid-attempt, re-auth, re-downloads: must get *exactly* their bound version's bundle (requires server retention + lookup by attempt's snapshot_id). Failure = lost progress recoverability.

### 1.2 Storage Cost of Indefinite Full Snapshots for Many Versions
- Grounded: 21 quests today. Assume 1-2 publishes per quest per year (fixes, improvements, new steps for physical sites that change). Over 5 years: 100-200 snapshots. Each snapshot conceptually holds full GameStep sequence (rich text, Answer lists, media refs, geo, Gift_Coins, durations, hints).  
- "Full" cost analysis (critical grounding): Download bundle ~5MB dominated by **media** (images + 10-30s videos). But server-side retention of "versions (content + answers)": if implemented as (a) JSON blob per snapshot or (b) normalized immutable Step rows per version, **structured data is tiny** (26 steps × few KB text/JSON even with old multi-lang). Real cost is: (i) referenced media assets that must not be GC'd if any historical snapshot references them (upload_file + CDN), (ii) if naive "copy entire bundle bytes" per version then yes linear bloat, (iii) DB rows/indexes for attempts + completions + version metadata forever.  
- Indefinite + "keep content + answers": For a quest with 50 versions, all 50 Answer lists + step texts must be queryable to rebuild bundles for any old attempt. No GDPR deletion pressure (explicitly none), but operational: backup size, query perf (attempts joined to their historical snapshot), admin UI clutter ("show me attempts on v3 vs v7").  
- Re-attack: "Indefinite" sounds robust for recoverability but YAGNI if most attempts complete + are never replayed after 1-2 years. Old answer_cards (historical) will require at least one "legacy snapshot" materialized at import time anyway.

### 1.3 Import Old Mutable Data into Versioned World
- Grounded (from 06, 07, 08, 09, 10_MIGRATION, data_types, 03 risks): "Importing historical AccessGrants + attempt history is desired ('yes'). Full per-step history from old answer_cards is included in scope where feasible." Old answer_cards (created via `addAnswerCard` + `create_answer_card_list` + scheduled "666" workflows) have **zero version info**. Pages were mutated in place; an answer that was "correct" per page.Answer list on 2023-05-12 may be wrong per the list on migration day 2026.  
- Problems: (a) What snapshot_id to assign imported attempts? Create a synthetic "v0-legacy" snapshot by snapshotting the page_constructor.Answer + content *at migration time*? Then all historical plays "froze" to whatever the data looked like on import day — falsifies history. (b) No edit history in Bubble (only Modified Date on records); cannot reconstruct "what answers were live when this card was created". (c) answer_card has flags like `Complited_quest`, `You_made_it` that mixed with gift/coin logic scattered across 82+ quest-page workflows. (d) Dupe types (page vs constructor) mean ambiguity which "content" to import. (e) Multi-lang fields will be cut (v1 Russian only) — do we snapshot the RU subset only?  
- Edge: Player who completed quest in old system, grant exists, wants to "replay" in new — new attempt gets fresh published version (correct per locked), but historical attempt record must stay bound to legacy snapshot for "what happened then" analytics/reviews.  
- This is one of the highest-risk import surfaces (called out in 07 + 03).

### 1.4 Concurrent Publishes / Editing Races
- Grounded: Old system used direct ChangeThing + 55+ workflows on Edit_Page reusable; no evidence of optimistic locking, transactions, or "last publish wins" explicit handling in parsed data (0 workflow matches for publish strings; flag flips are probably bare data mutations from admin UI). Two admins (internal team) editing same quest's steps/answers at once → lost updates or inconsistent publish.  
- New: Explicit Publish button "creates new snapshot". Race: Admin A saves draft edits (typo fix), Admin B publishes "major answer correction" 200ms later; or both click Publish near-simultaneously on slightly different drafts. Result: which content becomes the new "latest"? Does Publish create from current server state atomically? What about in-flight downloads?  
- Also: Publish while constructor has unsaved changes? Draft vs published separation (01: Draft/Published/Archived).  
- Offline player mid-attempt unrelated, but admin publish during player sync could coincide with attempt creation.

### 1.5 What Constitutes a "New Version" That Affects Answers vs Minor Text Fix?
- Locked implies: any explicit Publish → new version/snapshot for *new* downloads/attempts. Answers travel in bundle; text changes (narrative, physical task wording, button labels, gift text) also part of "content".  
- Ambiguities (re-attack):  
  - Typo in a narrative step or Place_RU description: "new version" or hotfix in place on latest? If new version, future players get "fixed quest" but old attempts keep the typo forever (UX inconsistency across players). If in-place on current published (without new snapshot), then "latest" becomes mutable — violates "stable snapshot" + "explicit publish for deliberate versioning".  
  - Adding a new non-answer step (e.g. extra gift or media) vs changing Answer list on an existing question step: clearly the latter affects validation and must be new version. Former? Still changes the experience for new attempts.  
  - Reordering steps or deleting a step: structural → definitely new version.  
  - Only changing Gift_Coins amount or geo pin (display-only): ?  
  - Old system: no distinction; everything mutable, Page_type 14 variants mixed presentation + semantics.  
- Player UX: "You completed v1 (with the old statue description). Latest is v3." Version drift UI required (called out as "should have" in 06).  
- Analytics value: per 03, "what wrong answers were submitted against this version" — requires crisp "version = publish boundary".

### 1.6 Player Re-downloads Old Version After Data Loss / Reinstall / Multi-Device
- Per 03: "Old attempts/bundles remain valid... Player can re-download the exact version of a quest for which they have an in-progress attempt (if the system keeps historical snapshots)".  
- Grounded risk: If we *do not* retain, player loses phone → cannot continue old attempt (no bundle with the frozen answers they are bound to). "Recoverability of old attempts" fails. Must serve historical snapshot on demand keyed by the attempt's stored snapshot_id.  
- Additional: Player finished v1 long ago, data loss, wants to *replay the exact experience they remember* (including the answers that were correct then) vs "start fresh on latest". Business model allows multiple attempts; version choice for replays? Locked says new attempts get latest.  
- PWA cache invalidation + Service Worker + integrity hash (03) per snapshot.

### 1.7 Additional Deconstructed Cases (from invariants + risks + scale)
- Unpublish (06 "should have"): Hides from catalog/new buyers/grants? But existing attempts + historical snapshots must continue to work. "Archived" status on Quest vs per-version.  
- Quest with 0 attempts ever: do we still retain its published snapshots indefinitely? (Storage waste.)  
- Version granularity (open in 01): whole-quest snapshot or per-step versions? (Locked leans whole for simplicity + bundle.)  
- Physical steps (no Answer list): still versioned because *content* (task description, geo display, hint) can change; player confirmation is honest-action based, but the "what I was asked to do" must be frozen per attempt.  
- Coin economy interaction: Gift_Coins defined in step at snapshot time; earnings recorded against that version's attempt.  
- Review after completion: bound to attempt + thus to version (for "I reviewed the v2 experience").  
- Scale growth: if external authors added later (out of v1 but "future" in 07), publish frequency explodes; concurrent editing by non-internal users.  
- "Continue across attempts/devices": per attempt's own snapshot (03).  

These cases expose that versioning is not a "nice to have" but the linchpin holding offline trust, historical fidelity, import, and deliberate content evolution together.

---

## 2. Exposure of Flaws (Harsh, Evidence-Based Critique)

### 2.1 Flaws in the "Locked" Explicit Publish + Indefinite Full Snapshots + Frozen Old Attempts
- **Core tension admitted but under-attacked in source docs**: 03 explicitly says "This model is simpler and directly satisfies... It is also less robust for content quality over time." + "Freezing answers per version means a buggy quest version can never be 'fixed' for players who already downloaded it." 07 lists as top risk. Yet "locked" per 08. Re-attack: Is "trust the local snapshot for the lifetime" worth poisoning the historical record for every player who hit a bad publish? For physical location quests, site changes (statue moved, plaque text updated) make old "correct" answers factually obsolete — yet frozen forever for those attempts. Analytics become "what players got wrong under v1's buggy rules" rather than truth.  
- **Storage/retention overclaim**: "Indefinite" + "full" sounds robust but, once grounded in actual data (media are refs, structured ~KB/quest, 21 quests base), the real indefinite cost is *referential integrity for assets + versioned rows + attempt history forever*. No deletion path even for never-played snapshots. Operational drag (backups, indexes on historical FKs from StepCompletion → snapshot). YAGNI: most value of retention is for *in-progress or recently completed attempts that might replay/reset*. Old completed attempts could be "sealed" with a minimal audit record (submitted answers + outcomes + version tag) without full re-materializable content bundle after N years.  
- **"Explicit Publish creates new" is good intent but vague on "what changed"**: No distinction between answer-affecting publishes (must freeze new validation contract) and pure-content publishes (typos, new flavor text). Leads to version inflation or temptation to mutate "latest" in place (slippery slope back to old mutable).  
- **Import incompatibility**: Locked model makes migration harder than admitted (07 calls it out as risk). Old mutable + unbound answer_cards cannot be faithfully mapped without inventing a legacy snapshot whose content may not match "what the player actually saw and what was accepted at the time". Historical fidelity (09's core point) is partially sacrificed.  
- **Concurrent & admin UX**: No mention of conflict resolution on Publish in locked docs. Internal team of 2-3 could easily race. Constructor (04) must now version its own working state vs published snapshots.  
- **Player re-download & UX drift**: Requires non-trivial "version catalog per quest per grant/attempt" serving. If implementation stores only "current published" + deltas, re-download of old fails. "Version drift" UI is "should have" not must (06), yet core to not confusing players ("why did my friend's answers differ?").  
- **Re-attack of offline justification**: The "client validates fully, no server re-val" + frozen is a deliberate simplification to remove two-phase tension (03). But it makes the *client code for each snapshot version* permanently authoritative for recorded outcomes. A bug in v1's matching logic (e.g. case handling) is baked into all v1 attempt records. No path to "re-score old attempts under improved normalizer" without violating the freeze.  
- **Overall**: Locked satisfies the stakeholder "no revalidation... explicit publish" direction but accepts brittleness on quality, import, storage discipline, and future evolution. It is "lean" only if we accept full-copy semantics without optimization.

### 2.2 Flaws in the Old Bubble System (statusQuest + Publish_on_the_site + Mutable Content)
- **Zero support for offline or trust**: As 03/09 state: no bundles, no snapshots, validation via live workflows assuming connectivity. `addAnswerCard` etc. mixed client state + server mutations. A mid-play content edit (admin flips answers on page_constructor while player is submitting) could change outcomes retroactively or mid-attempt. No "what version did I play?" — impossible to audit "why did 40% fail this step in 2024?".  
- **Mutable = anti-historical**: Direct evidence — page_constructor.Answer list + all texts live on the same records referenced by historical answer_cards. Edit the quest today → past plays' "correct" answers silently rewrite in any replay or analytics. Duplication (page vs page_constructor, quest vs quest_name_constructor) is a symptom of mutable editor needing separate "working" copies without proper versioning. 1,163 workflows (heavy on ChangeThing + custom state) are the cost of fighting the lack of a clean model.  
- **Publish was not deliberate versioning**: Just a visibility flag + status option. "Published" quests still had live-mutable pages. No snapshot on "publish" action. Old attempts not bound.  
- **Import pain inherited**: Exactly because of above — 07/09/10 call out that old answer_card data (via complex scheduled workflows without clean boundaries) will be hard to import faithfully.  
- **Other scars**: 14 Page_type values mixing semantics/presentation; multi-lang explosion on every field (even if v1 cuts to RU); denorm stats on quest that would need recalc on content changes; privacy rules ignored in critical paths (per 09); dead event baggage.  
- **Harsh verdict**: Old system was never designed for the new hard requirements (offline PWA + stable validation contract per attempt). "Copying specific behavior" would import the anti-patterns (mutable answers, no versions, scattered coin/answer logic). It is actively hostile to the invariants in 01 (attempt bound to snapshot version; client validation against local; changing published content must not retro break).

### 2.3 Flaws in Common Versioning Patterns (Applied to This Domain)
- **"Mutable content + audit log" (too weak for offline trust)**: Audit "who changed what when" is better than nothing (old system had almost none, only Modified Date). But for offline: client *must* download a stable, self-contained set of acceptable answers + content at a point-in-time. If server can still mutate the "current" and audit just records the mutation, a player who downloaded "before the audit entry" has a different truth than one who downloads after. Violates "sole source of truth for validation during any attempt started from that download" (03). Client matching bug or content drift becomes unrecoverable. Not robust.  
- **"Full copy every publish" (storage bloat + constructor complexity)**: Naive implementation of locked A. With real media refs, bloat is mostly illusory for *structured* but still: every publish duplicates the entire step list in whatever storage (JSON or rows). Constructor must now produce "versioned" output; every edit/preview must decide "am I editing draft or a historical immutable?". Migration must create at least one full copy per quest. Over time, "version N" reconstruction requires either keeping all copies or complex diffing.  
- **"Delta / patch only + reconstruct on demand"**: Elegant in theory (see B), but for client bundles: you must still materialize a full consistent snapshot for the PWA download (5MB target includes the data the client needs). Reconstruction logic must be 100% deterministic and side-effect free. Bugs in replayer = corrupted historical bundles for old attempts. Hard to reason about "what was the Answer list at publish #7" without materializing. For import of old mutable data: no deltas exist to replay from.  
- **"Semantic versioning with patch/minor/major affecting answers or not"**: Good idea (see D), but adds concepts (semver rules, "does this publish affect validation contract?"). For v1 (KISS), deciding the rules + UI in constructor ("this is a patch, don't create new frozen version for answers?") may be over-engineering when publish frequency is low and "explicit Publish = new version" is the deliberate simple rule. Can lead to "I published a text fix as patch but players on old attempts still see old text because we didn't bump the content version."  
- **General**: Any pattern that allows the "latest" to be mutable after a player has an in-progress snapshot violates the offline + frozen invariant. Any pattern without retention for referenced versions breaks recoverability. Any pattern that doesn't create a crisp "version boundary" on explicit publish loses the "deliberate" property vs old flags.

**Summary of exposure**: The locked model is the least-bad starting point that directly encodes the stakeholder direction, but it has accepted (and under-documented) weaknesses on quality freeze, import fidelity, storage discipline, and "what is a publish". Old is actively incompatible. Common patterns either weaken offline trust or add accidental complexity the rebuild is trying to escape (47 types → ~12-15).

---

## 3. Rebuild: Four Distinct Approaches (Each with Full Deconstruct/Expose/Rebuild/Self-Critique Cycle)

For each, describe conceptual model (entities, when a version/snapshot is created, how bundle is produced for download, how attempts bind, storage shape, import path, publish UX, error/reconciliation), then apply the cycle.

### Approach A: Full Immutable Content Snapshots (Current Lean) + Retention Policy
**Conceptual Rebuild**: 
- Quest (aggregate) has working/draft content (current GameSteps + metadata, mutable by admin only in "draft" mode). 
- Explicit "Publish" action (admin button): atomically creates a new immutable `QuestSnapshot` (or `QuestVersion`) record. Snapshot contains (or refs deeply): full ordered list of GameStep data at that instant (including Answer lists as plain strings, all rich content, media refs, geo, Gift_Coins, etc.), a version identifier (monotonic int or uuid + quest_id + publish timestamp), integrity hash of the canonical serialized form, status (Published). The Quest's "latest_published_snapshot_id" is updated. Draft remains separate for further edits.
- Download/attempt start: if player has grant (or free), bind new `QuestAttempt` to the Quest's current `latest_published_snapshot_id` (or error if none). Serve downloadable bundle materialized from that snapshot (structured JSON + media URLs at snapshot time + hash for client verification).
- Old attempts: their `snapshot_id` FK is immutable. Re-download for recovery uses the historical snapshot's data.
- Storage: snapshots kept "indefinitely" (per locked). To mitigate: (a) normalized immutable StepSnapshot rows (content hashed for potential dedup across versions/quests), (b) media are always refs (never copy bytes on publish; retain asset if any snapshot refs it), (c) retention policy *in addition to* indefinite: keep all referenced by any QuestAttempt ever; allow admin "seal & archive old unreferenced snapshots" (but respect locked by defaulting to keep).
- Constructor: edits always target the Quest's draft/working state. Preview = "use draft or last published". Publish = explicit "this draft is now a releasable snapshot".
- Import: On migration, for each quest with history: (1) materialize one "v0-legacy" snapshot from the imported page_constructor data (RU subset, mapped to GameStep), (2) create Quest + snapshot, (3) for historical answer_cards/grants/attempts, bind them to v0-legacy (note in metadata "imported; answers reflect migration-time page state"), (4) subsequent publishes create v1+. Old stats can seed denorms on the Quest or per-snapshot.
- Version drift: attempts carry their snapshot version; UI can show "playing v2 (latest v4)" and offer "start new attempt on latest".

**Deconstruct (how it addresses edges)**: 
- Mid-attempt publish: frozen by binding at attempt creation. Player unaffected until new attempt.
- Storage: as analyzed, structured cheap; policy + dedup + ref-based media keeps it manageable even for "indefinite". 21 quests base → low absolute numbers.
- Import: explicit (create legacy snapshot); acknowledges history is approximated but gives a version to bind to. Better than nothing.
- Concurrent: Publish must be atomic (transaction or compare-and-swap on draft state or version counter). Last-wins or conflict error on simultaneous publishes.
- "New version" definition: any Publish creates one. Minor vs major is admin discipline (or later label on publish: "patch / minor / major" metadata only, no behavioral diff yet).
- Re-download: direct from snapshot store by id.

**Expose Flaws Harshly (even in this approach)**: 
- Still accepts the quality freeze (buggy vN poisons its attempts forever; client matching per-version is law). 
- Eager creation on every Publish: even if no one ever downloads that version (admin test publish, or publish then immediate revert edit + republish), a snapshot row + potential asset retention is created. Wastes if publish frequency > actual play starts. 
- Constructor complexity: now "draft" state + "published snapshots" + "which snapshot am I previewing?". Admin must understand versions to debug "why did my test player see old answers?". 
- Import still lossy (no true historical answers at play time). 
- If media change (re-upload same logical image), old snapshots' "content" fidelity requires keeping the *old* asset URL/key; asset store must support indefinite refs too. 
- "Full" in name encourages naive full-blob-per-version impl (5MB copies) instead of smart refs + materialization. 
- No built-in "what changed between vN and vN+1" (requires external diff of snapshots). 
- Re-attack of locked "indefinite": even with policy, the default is keep-forever; for 100 versions of a popular quest, admin visibility and DB growth are real (attempts × versions joins).

**Rebuild (refinements for robustness)**: 
- Make snapshots content-addressable where possible: hash the canonical GameStep list (or individual steps) so identical content across publishes dedups automatically. 
- Separate "validation contract version" (bump only on Answer list or step logic changes) from "content version" (bump on any publish). New attempts always get latest full, but drift UI distinguishes "answers same as your v2 but narrative updated in v3". (This is a small step toward D.) 
- Publish flow: confirm dialog ("This will create vN+1. New players will get these answers. Old attempts stay on vN. Proceed?"). 
- Retention: default "indefinite for any snapshot ever referenced by a QuestAttempt or that was the latest at time of any grant"; background job to mark unreferenced as "archivable". 
- Bundle serving: on-demand construction from snapshot data + CDN (no pre-built 5MB blobs stored per version unless for perf). Integrity hash stored on snapshot.
- For concurrent: use DB unique constraint + transaction around "create snapshot from current draft + set as latest".

**Self-Critique**: 
A is the most direct encoding of the locked decisions ("explicit Publish creates...", "keep... indefinitely", "new get latest, old frozen"). It is KISS: one new concept (immutable snapshot on publish boundary), maps cleanly to QuestAttempt FK, simple for client (download this version id's data). Maintainable because invariants are crisp. However, it inherits the accepted quality-freeze brittleness and import approximation. For v1/internal/low-frequency it is probably sufficient and avoids over-engineering (no replay logic, no lazy materialization complexity). The "full" can be implemented smartly (refs + hash dedup) without changing the conceptual model. It does not violate YAGNI if we don't add semver rules or event sourcing yet. Weak on "ability to correct content errors" (by design of freeze) and "storage" (eager). Best baseline.

### Approach B: Event-Sourced Step Changes (Append-Only Log of Edits, Reconstruct Snapshot for a Version)
**Conceptual Rebuild**:
- All changes to a Quest's content (add step, edit field on step X, reorder, change Answer list on step Y, update metadata, set Gift_Coins, etc.) are appended as immutable Events to a QuestEventLog (with sequence #, timestamp, admin actor, before/after or patch, event type). 
- "Publish" action: appends a `Published(version_tag, snapshot_hash)` event. The "current latest version" is the highest publish event. 
- To obtain the content for version N (or for a snapshot at publish event P): start from genesis (empty or initial import state) + replay all events up to and including P. Materialize the GameStep list + Answer lists at that point. Cache the materialized form (or the hash) on the publish event for fast bundle serving. 
- Attempts bind to the specific publish event id (or derived version id). Bundle = reconstruction (or cached materialization) at that point. 
- Draft/working = current replay head (or separate working copy that emits events on save). 
- Storage: append-only log (very compact deltas); materialized snapshots only for published versions that have been requested (or eagerly on publish). Media refs versioned in the events that set them. 
- Import: Play back a synthetic event log reconstructed from the migration-time page_constructor state (one big "initial import" event per page mapped to steps + answers). Then bind old attempts to the "v0" publish event created at end of import replay. Future real edits emit real events.

**Deconstruct (how it addresses edges)**: 
- Mid-attempt publish: same freeze (attempt binds to a specific event sequence point). 
- Storage: excellent — only deltas + occasional full materializations for published points. Indefinite retention cheap (logs compress well; old events for quests with no active attempts can be "cold" archived). 
- Import: possible via synthetic log, but the log is artificial (no real before/after from history). 
- Concurrent: append-only log naturally serializes (last event wins or use causal ordering). Publish events are just markers in the stream. 
- "New version" vs minor: publish events can carry a "bump type" (major/minor/patch) + "affects_validation" flag. Reconstruction uses it for metadata. 
- Re-download: reconstruct (or use cached) from the event point the attempt references.

**Expose Flaws Harshly (even in this approach)**: 
- **Reconstruction is a single point of failure for historical truth**: Any bug in the event applier, field mapping, or ordering = every old attempt's bundle is wrong or the materialized answers differ from what was "published" at the time. For offline client, this is fatal (wrong validation contract served for vN). Determinism must be perfect across deploys, languages, etc. Hard to test exhaustively. 
- Complexity explosion vs KISS/YAGNI: Event sourcing is a sophisticated pattern (good for audit, temporal queries, "time travel rollback" by replaying to prior publish). But for v1 (internal team, 21 quests, linear steps, no external authors, low change rate) this is over-engineering. Constructor, bundle builder, attempt binding, import, and admin "view history" all must understand the log + replayer. 1,163 workflows in old system were the symptom of complexity; we don't want to recreate it in a typed event log + projector. 
- Import of old mutable: no real events exist. Synthetic log at migration is a lie — it doesn't capture the actual sequence of edits/answer changes that real players experienced. Historical fidelity (core of 09) is not improved over A; it's just as approximate, plus now you have fake events to maintain. 
- Materialization still required: For the client bundle you cannot send "the log from 0 to P"; player needs the concrete steps + Answer list. So you pay the materialization cost + caching complexity anyway. "Append-only" savings are real for storage but the operational surface (replay debugging, snapshot cache invalidation on applier change) is larger. 
- "Explicit publish creates snapshot": publish just appends a marker; the snapshot isn't "full immutable content" until reconstructed. Subtly weakens the "deliberate version" mental model. 
- Edge races in replay: concurrent event appends during a long publish reconstruction? Version drift during replay for a just-published version. 
- Long-term: excellent for "ability to correct" (you can see exact edit that introduced the bad answer and perhaps emit a corrective event), but the freeze invariant still prevents *retroactively changing recorded outcomes* for old attempts.

**Rebuild (refinements)**: Use a simple event model (not full CQRS/ES framework). Events are just "StepContentChanged(step_pos, field, value)", "AnswersReplaced(step_pos, new_list)", "Published". Provide a pure function `reconstruct(quest_id, up_to_event_seq) -> Snapshot`. On every Publish, eagerly materialize + store the Snapshot (or its hash + content) alongside the publish event for fast serving + integrity. Add "snapshot materialized at" for audit. For import, one "BulkImport" event + immediate publish event. Version numbers derived from count of publish events. 

**Self-Critique**: 
B is elegant for auditability, storage efficiency, and "time travel" (admin can ask "what did the answers look like right after publish #3?"). It would shine if the business ever needs full history of *how* content evolved or external authors with contribution tracking. However, it directly violates KISS and YAGNI for this v1 scope. The reconstruction hazard for offline bundles is unacceptable risk (one bad deploy of the replayer and historical attempts become unplayable or have wrong "correct" answers recorded). Import doesn't benefit. For the locked "explicit Publish creates new snapshot", A is simpler (the snapshot *is* the publish artifact). B adds concepts without solving the quality-freeze or import-lossiness problems. Good for long-term maintainability *if* we accept the complexity tax now; premature for current constraints. Only pursue if future requirements (branching? external authors? regulatory audit of content changes?) justify it.

### Approach C: Copy-on-Write / Attempt-Specific Snapshot Materialization Only When Download Happens
**Conceptual Rebuild**:
- Content (GameSteps + Answers + metadata) lives in a single mutable "current" structure per Quest (draft + a "published head"). Admins edit the current freely; "Publish" flips the published head or creates a lightweight "published marker" (just a timestamp + hash of current at that moment, no full copy). 
- No eager snapshot on Publish. 
- On actual player action that requires a stable version ("start new attempt" or "download bundle for grant"): *at that moment*, atomically materialize (copy) the current published content into a new `QuestSnapshot` record (or deep copy the steps for that attempt), bind the new `QuestAttempt` to *this freshly materialized snapshot*, and serve the bundle from it. 
- Subsequent publishes only affect the "current" head. Future downloads/attempts materialize from whatever the head is *then*. 
- Old materializations stay forever (or per retention) for their bound attempts. Re-downloads use the per-attempt materialized copy. 
- For "version" identity: the materialized snapshot gets a version id at materialization time (or the publish marker it was based on + materialization seq). 
- Storage: copies created only for quests/versions that actual players have started attempts against. "Publish-only" churn (admin publishes 5 times with no one playing) costs 0 extra storage. 
- Import: for historical attempts, materialize one snapshot from the imported current state at migration time, bind all old attempts to it. New plays materialize fresh from then-current. 
- "Explicit publish": still exists as deliberate "I intend this to be the new experience for future players"; it just doesn't pay the copy cost until use.

**Deconstruct (how it addresses edges)**: 
- Mid long offline attempt: the materialization happened at the player's download/start time → frozen exactly as in A. Later publish (even while player offline) doesn't affect the already-materialized copy for that attempt. 
- Storage: best-in-class for "indefinite" under real usage. Only pay for versions that were actually downloaded/attempted. With 21 quests + low replay rate, far fewer copies than eager publishes. 
- Import: straightforward — materialize legacy snapshot once per quest at import, bind history. 
- Concurrent: materialization is per-attempt (isolated); publish just updates head. Race on "two players start attempt at exact publish boundary" resolved by which head they saw (or transaction on head + materialization). 
- Minor text fix: admin can publish (update head) without forcing copies until someone starts new. Old attempts keep their materialized (old text + old answers). 
- Re-download: the per-attempt materialized copy (or its source snapshot) is retained. 

**Expose Flaws Harshly (even in this approach)**: 
- **"Explicit Publish creates new snapshot/version" is only conceptually true**: In reality, the version/snapshot record (the thing the attempt binds to and that can be re-downloaded) is created lazily on first use after a publish. This subtly violates the letter of the locked decision ("explicit Publish button creates new snapshot/version"). An admin clicking Publish sees no new version artifact until a player acts. Audit "when was v3 created?" is "time of first download after the publish marker", not publish time. Feels less "deliberate". 
- Version identity & drift UX harder: what is "latest version number"? If versions are minted on materialization, two players starting attempts 5min apart after the same publish might get v7 and v8 (or you normalize to "the publish marker"). "Attempts on v3" requires grouping by the underlying publish or materialization source. 
- Constructor/preview/admin mental model: "I published, but where is the version? Oh, no one has started yet." Testing a publish requires starting a test attempt (which materializes). More state ("head" vs "materialized copies"). 
- "Indefinite retention" still applies to the materialized ones; you cannot avoid retaining per-attempt copies if you want recoverability. If a quest is played by 10k players across 10 "publishes", you still have up to 10k materialized snapshots (though many may share identical content — needs dedup anyway). 
- Race on materialization + publish: a player starts download exactly as admin publishes → which content do they get? Must be consistent (transaction or read the head under lock). 
- Import still approximates history (same as A). 
- Long-term: if you ever want "full version history" visible to admins independent of play ("show me all publishes ever, even unreached ones"), you need extra "publish marker" objects anyway (hybrid with A). 
- Re-attack: This is "lazy A". It optimizes the storage flaw of eager full copies but adds a layer of indirection that makes the core publishing model less obvious. For offline trust it works identically (once materialized, it's a stable snapshot). But it weakens the "explicit publish for deliberate versioning" story that justified moving away from old mutable flags.

**Rebuild (refinements)**: 
- Still create a lightweight `PublishEvent` or `VersionMarker` on explicit Publish (id, timestamp, admin, hash_of_content_at_time, comment). This satisfies "creates new version" conceptually. 
- On download/attempt: if no materialized snapshot yet for this marker, copy-on-write materialize it (or just reference the marker + current content if immutable since, but to freeze: must copy or snapshot the content at first use). 
- Always retain the marker (cheap) + materialize full content only for markers that have attempts. 
- For identical content (common for minor publishes), hash and share the materialized step data. 
- Admin UI: list of markers (publishes) + "attempts using content from this marker" + "materialized copies: N". 

**Self-Critique**: 
C is the pragmatic storage optimizer. It directly attacks the "full copy every publish is bloat" flaw while preserving 100% of the offline/freeze/new-get-latest invariants. For real usage patterns (not every publish is downloaded by someone who keeps the attempt forever), it wins on storage vs A. Import is no harder. It still requires retention of materialized artifacts for recoverability. The main flaw is the slight mismatch with the *wording* of the locked "Publish button creates new snapshot" (publish creates the *intent* / marker; materialization creates the usable frozen snapshot). If the business cares more about "deliberate publish event exists independently of play" than about eager storage, a small hybrid (marker on publish + COW materialization) fixes it. For pure KISS, A is simpler (no lazy path, no marker vs materialization distinction). C is better if we observe publish-churn > play starts. Excellent candidate when combined with content-hashing.

### Approach D: Hybrid / Invented — Semantic Versioning + Answer-Contract vs Content Layers + Content-Addressable Dedup (with Optional Lazy Materialization)
**Conceptual Rebuild** (combines best of above + new idea tailored to "affects answers vs minor text"):
- On Quest: separate concerns. 
  - `current_draft_content` (full mutable GameSteps + all fields for admin editing). 
  - Publish produces a new `QuestVersion` with **semver** `major.minor.patch` + two sub-identifiers: `validation_contract_id` (hash or monotonic of the "answer-affecting" parts: Answer lists + step order + step kinds + anything that can change `is_correct` computation) and `content_revision_id` (hash of full content including texts, media refs, geo, durations, gifts, etc.). 
  - "Major" bump: any change to validation_contract (new/changed/deleted answer steps, reordering that affects answer positions, etc.). Forces new frozen contract for attempts. 
  - "Minor"/"patch": changes only to content_revision (text fixes, new narrative steps that don't have answers, media, wording of physical tasks, Gift_Coins amounts, geo pins). Can be published as non-breaking for validation. 
- Snapshots / materialization: a full `QuestSnapshot` (for bundle + binding) is still created on Publish (or lazily per C). The snapshot carries the semver + both ids + the full (or hashed) data. Attempts bind to a specific snapshot (thus to its validation_contract). 
- Client bundle: always includes the full content of the snapshot (so old attempts see the exact narrative + answers they were given). But drift UI can say "You are on v2.3.1 (validation contract 2.3). Latest is v2.4.0 (same contract, updated narrative) or v3.0.0 (new answers)." 
- For in-progress attempts on old validation: they stay frozen. But if only content_revision changed (minor/patch), perhaps offer an *optional* "refresh narrative for this attempt" (pull updated non-validation content while keeping the same validation_contract answers). This is a controlled relaxation of pure freeze, only for non-answer-affecting parts. (Must be opt-in, client must handle mixed content carefully.) 
- Storage: full snapshots (or COW/lazy) + aggressive content-addressable storage: every GameStep (or its fields) stored by content hash. A snapshot is a list of step_hashes + metadata + the two contract/revision hashes. Identical text or answer lists across any versions/quests dedup at storage layer. Media always refs + content-hash keys. 
- Publish UX: admin chooses or system suggests bump type based on diff (did Answer lists or step structure change? → at least minor or major). Explicit "Publish as vX.Y.Z" with preview of impact ("This changes answers for 3 steps → new validation contract. 12 players have in-progress on prior contract."). 
- Import: create v0.0.1-legacy with validation_contract + content from migration data. Bind old attempts here. All imported get the legacy contract (acknowledging approximation). 
- "Indefinite": apply to snapshots/markers that have attempts; hashed content can be retained as long as any snapshot refs the hash.

**Deconstruct (how it addresses edges)**: 
- Mid-attempt publish (minor text fix): if published as patch, players on prior snapshot keep old narrative (or can refresh non-answer parts). If answer change → major, freeze as before. 
- Storage: best possible (dedup + only materialize used + only full when needed) while supporting indefinite for referenced. Hashes make "many versions" cheap. 
- Import: same legacy snapshot as others, but now tagged with semver 0.0.1-legacy. 
- Concurrent: same atomic publish + version assignment as A (semver assigned under lock or with conflict). 
- "What is a new version": now explicit and typed (major affects answers/validation → definitely new frozen for attempts; minor/patch may allow partial refresh). Directly attacks the "minor text fix vs answer change" ambiguity. 
- Re-download + UX: richer drift info ("same answers, better wording in latest minor"). Player who lost data on a minor-revision quest can continue with exact old contract + refreshed or old content. 
- Analytics: group by validation_contract (apples-to-apples correctness) vs by full snapshot (experience variations).

**Expose Flaws Harshly (even in this approach)**: 
- **Adds concepts and decisions**: semver rules, "what affects validation_contract?" classifier in diff/publish flow, optional refresh for content-only, two ids per version. This is more surface for admin to learn, more code in constructor (diffing engine, bump suggester), more state in snapshot (semver + hashes + full data or refs). Violates KISS/YAGNI more than A. For v1 with internal team + linear quests + low publish rate, the extra modeling may not pay off vs just "every Publish = new version, admin is careful". 
- Complexity of "partial refresh": client must support loading updated narrative/media for an attempt while *ignoring* any answer changes (or risk serving wrong validation). Bundle for "refreshed" is a hybrid. Edge cases: player refreshes mid-attempt after some answers submitted under old wording? Physical task description changed — does "I already did it based on old wording" still count? UI for "refresh available" adds player confusion. 
- "Ability to correct content errors": improved for minor (you can publish patch and let willing players refresh narrative without new attempt), but validation errors still frozen (by design). The classifier "does this change affect answers?" must be perfect; a mistaken "minor" publish that actually tweaks an Answer list poisons new attempts with wrong contract. 
- Import: still lossy; legacy gets some semver. No better fidelity. 
- Storage wins are real but require implementing content-addressable layer (hashes on steps, content store) — another piece of infrastructure. If naive, you get the bloat of A anyway. 
- Re-attack locked: this is "locked + more". It tries to have the cake (deliberate explicit publish) and eat it (distinguish answer vs text so not everything forces full freeze). But the core freeze + no-reval + indefinite retention constraints are still there; D just annotates versions better. The "optional refresh" is a relaxation that may violate "old attempts frozen to their version" spirit. 
- Long-term risk: semver promises (back-compat for minor) are hard to keep forever as GameStep model evolves (new step kinds added post-v1). 

**Rebuild (refinements to keep it from over-engineering)**: 
- Make the semver + contract/revision *optional metadata* on the basic snapshot from A (or marker from C). Default every Publish to "new full version" (like A). Only power users/admins doing frequent fixes opt into classifying "this publish only bumps patch for content". 
- Defer the "refresh narrative for existing attempt" to post-v1 (or never). For v1, even minor publishes create new snapshots that new attempts use; old stay frozen on full old snapshot (simple). The semver is just labels + analytics grouping + better admin visibility ("this v2.0.0 changed answers"). 
- Implement dedup via step content hashes regardless (cheap win that benefits A/B/C too). 
- Publish dialog always shows "New attempts will receive: validation changes? Y/N; content changes? Y/N". No automatic bump logic in v1. 

**Self-Critique**: 
D is the most "elegant" and future-proof of the four — it directly tackles the "what constitutes a new version that affects answers vs minor text fix" edge case that the other approaches leave to admin discipline or version inflation. Content-addressable storage is a robust primitive that reduces storage concerns across the board and supports long-term maintainability (easy diffs, sharing, integrity). The hybrid lazy materialization option gives C's storage wins. However, it introduces the most concepts and the highest risk of over-engineering for the current constraints (KISS/YAGNI repeatedly emphasized; v1 cut list is aggressive; internal team; 21 quests). The partial refresh relaxation is seductive but adds client complexity and potential player confusion that may not be worth the "ability to correct minor content errors" gain. For robustness, the core freeze invariant remains. If the analysis recommends D, it should be the *annotated* version of A (semver as labels + hashes for dedup) rather than a full separate system with refresh flows in v1. Excellent for the "long-term maintainability" criterion; riskier for "elegance without accidental complexity" in the immediate rebuild.

---

## 4. Recommendation: Best Approach for Robustness, Maintainability, Elegance Under Constraints

**Recommended: A (Full Immutable Content Snapshots on Explicit Publish) refined with content-addressable deduplication for steps + lightweight Publish markers + retention "indefinite for referenced + admin-sealable for unreferenced" + eager materialization of the snapshot artifact on Publish (to honor "creates new snapshot"). Optional later annotation with semver labels (from D) once real publish patterns are observed.**

**Justification vs constraints (KISS/YAGNI foremost)**:
- **Directly implements the locked business without extra concepts**: Explicit Publish button → creates the snapshot/version record. New attempts/downloads → bind to / receive latest_published. Old → frozen to their bound snapshot. Server keeps the content+answers for that snapshot indefinitely (at minimum while referenced by attempts) to support re-download/recoverability. Matches 08, 03, 01, 04 exactly. No lazy surprises, no reconstruction hazard (B's fatal flaw for offline bundles), no "publish doesn't really create the thing until use" (C's wording mismatch).
- **KISS**: One new core entity (QuestSnapshot / versioned content aggregate) + FK from QuestAttempt + snapshot_id in StepCompletion. Constructor edits draft; Publish snapshots it. Bundle construction is "take the snapshot data + resolve media refs + hash". No event log replayer, no per-attempt vs per-publish distinction, no semver classifier in v1. Maps to existing domain language ("snapshot" already used heavily in 03 for the downloadable bundle).
- **YAGNI**: Current scale (21 quests, ~556 steps total, low expected publish rate for location-based physical content) means even naive full copies of *structured data* are negligible cost. Media are refs anyway (grounded). We do not need B's log for temporal queries we don't have requirements for. We do not need D's semver rules or refresh until we have evidence of frequent minor fixes + player demand for "update my in-progress narrative without losing my frozen answers". Start simple; the analysis produces the variants so we can evolve later without regret.
- **Robustness (offline trust + historical fidelity + recoverability)**: Snapshots are the stable unit. Client gets exactly one version's answers + content. Server records against it. Re-download works by snapshot lookup. Import creates at least the legacy snapshot(s) explicitly. Concurrent handled by atomic publish transaction. Edge of "admin publishes mid long attempt" handled by design (freeze).
- **Maintainability / elegance**: Crisp invariants (see below). Easy to reason: "this attempt is on this snapshot; this snapshot is immutable; new publish = new immutable thing + pointer update". Long-term: when (if) we add external authors, branching, or richer history, we can layer B-style events *under* the snapshots (publish still produces the materialized snapshot for safety) or migrate to hashed steps (D's dedup). Version drift UX, analytics per version, and admin visibility are natural ("attempts for snapshot X"). 
- **Trade-offs accepted (but mitigated)**: Quality freeze for buggy versions (accepted in locked; mitigated by good preview in constructor + analytics on wrong answers per version to drive better publishes). Eager snapshot creation even for unused publishes (mitigated by cheap structured + dedup + "sealable" policy). Import remains an approximation (no approach solves the "no history in old mutable data" problem; A makes the approximation explicit via the legacy snapshot).
- **Why not others as primary**:
  - B: Violates KISS/YAGNI; reconstruction risk too high for the offline client validation contract that is the *point* of the whole model.
  - C: Excellent storage optimization and worth implementing as a refinement (lazy materialization behind the "publish creates marker + snapshot on first use"), but the core recommendation stays A-shaped for conceptual simplicity and fidelity to locked wording. A COW variant can be "A with deferred copy cost".
  - Pure D: Over-models for v1. The annotation/semver + dedup pieces are valuable *additions to A*, not a replacement. Partial refresh is future work.
- **Against re-attack of locked itself**: The analysis did re-attack "indefinite full" (storage/operational cost, quality freeze, import). The recommendation retains the spirit (explicit boundaries + retention for recoverability) while adding practical policies (referenced-only indefinite, dedup, sealable) and acknowledging the accepted brittleness. If stakeholder later relaxes "no revalidation ever" or "must freeze content too", we can evolve (e.g. allow content-only refreshes under D). For now, the locked is the contract; A implements it cleanly.

This is the robust, maintainable, elegant choice that does not over-engineer while satisfying the hard requirements (offline stable snapshot, deliberate versioning, old attempt recoverability).

---

## 5. Trade-off Table

| Dimension                        | Approach A (Full Snapshots + Retention, recommended refined) | Approach B (Event-Sourced + Reconstruct) | Approach C (COW / Attempt-Specific Materialize on Download) | Approach D (Hybrid Semver + Layers + Dedup) |
|----------------------------------|-------------------------------------------------------------|------------------------------------------|-------------------------------------------------------------|---------------------------------------------|
| **Storage (structured + media refs)** | Medium (eager per publish; cheap for text ~KB/quest; media refs shared; dedup + sealable policy mitigates "indefinite"). 100s of snapshots across 21 quests still small. | Lowest (deltas only; materializations cached only for used publishes). Excellent for many versions. | Lowest-to-medium (only for actual started attempts/downloads; markers cheap). Best if publish churn >> plays. | Lowest (hashes dedup everything; + lazy option). |
| **Complexity of "constructor" / publish flow** | Low-Medium (edit draft; explicit Publish = snapshot + update latest. Confirm dialog, atomic tx). Draft vs published separation. | Highest (every save emits event; publish appends marker; must understand replay for preview/test). Replayer is new "engine". | Medium (edit current head; Publish = marker only; materialization happens later on player action. "Where is my version?" mental model). | Highest (semver bump choice/classifier, contract vs revision, diff engine in publish, optional refresh flag). |
| **Player UX on version drift**   | Good (attempt carries snapshot id; show "vN (latest vM)"; offer new attempt on latest). Re-download exact old works. | Good (same; version derived from publish event). "What was live at event 42" possible via replay. | Good-to-fair (materialization time = version birth; may need markers to group "same publish, different materialize times"). Re-download works. | Best (rich labels: "same validation contract, updated narrative"; optional refresh for content-only). |
| **Import difficulty (old mutable answer_cards + grants)** | Medium-High (create explicit v0-legacy snapshot from migration-time data; bind all historical attempts to it; note "approx"). Straightforward once decided. | High (build synthetic event log from migration state; replay to create v0 publish; still approx; extra fake history to store). | Medium (materialize legacy once on import; bind; same as A). | High (same + assign semver 0.0.1-legacy + contract/revision hashes). |
| **Ability to correct content errors (for future vs historical)** | Poor for historical (by design: frozen). Good for future (new publish = new snapshot with fixes). Analytics per version help drive corrections. No retro re-score. | Best for seeing history (replay shows exact sequence of bad edit). Still cannot retro change frozen attempt outcomes. Can emit corrective events. | Poor for historical (same freeze). Future corrections only affect new materializations. | Best potential for minor (publish patch + optional narrative refresh for existing attempts without new validation contract). Validation errors still frozen. Classifier must be correct. |
| **Support for "explicit Publish creates new snapshot/version" (locked)** | Excellent (Publish *is* the creation of the immutable snapshot artifact). | Fair (Publish appends marker; full snapshot is reconstructed materialization). | Fair-to-poor (Publish creates marker/intent; usable frozen snapshot created on first download/use). | Excellent (Publish creates version with semver + layers; snapshot can be eager or lazy). |
| **Support for indefinite retention + recoverability** | Excellent (snapshots retained; policy can be "referenced + sealable"). Re-download by snapshot_id direct. | Excellent (log is cheap to keep forever; materializations on demand or cached). | Good (only materializations for real attempts retained; markers for history). | Excellent (dedup makes indefinite cheap). |
| **Offline client validation stability + bundle integrity** | Excellent (immutable snapshot = the bundle source of truth; hash on it). | Good if materialization is cached + hashed at publish time; risk if on-the-fly replay ever differs. | Excellent (once materialized for the attempt, it's a stable copy like A). | Excellent (same as A + hashes for integrity). |
| **Long-term evolution (branching, external authors, richer history, post-v1 relaxations)** | Good base (can add events under snapshots later; add semver labels; evolve to hybrid). | Best foundation (events *are* the history). | Good (markers + materializations can be annotated). | Best annotations out of box (semver, layers). |
| **Overall v1 / KISS / YAGNI fit** | Best (direct, minimal new concepts, honors locked wording + offline needs). | Poor (over-engineered for current scale/reqs; reconstruction hazard). | Good (storage win) but slightly mismatches locked "Publish creates snapshot". | Fair (elegant but adds concepts prematurely). |

**Key insight from table + grounding**: Storage differences are smaller than feared once media refs + real record counts (21 quests) are considered. Complexity and "honors locked decisions" favor A. Import is painful in *all* (fundamental lack of history in old data). "Ability to correct" is inherently limited by the freeze invariant in all.

---

## 6. Recommended Invariants (Conceptual, Technology-Agnostic)

These must hold for the chosen approach (and survive any evolution). They extend / make precise the ones in 01 + 03 + 08.

1. Every `QuestAttempt` (and by extension every `StepCompletion` within it) is immutably bound at creation time to exactly one `QuestSnapshot` (or equivalent version artifact). The binding never changes.
2. The `QuestSnapshot` is immutable once created: its GameStep sequence, acceptable Answer lists (for answer steps), rich content, media references, geo, Gift_Coins, and all other validation-relevant or experience-relevant data are frozen.
3. Client-side validation (offline or otherwise) for an attempt uses *only* the acceptable answers and rules present in the bound snapshot. Server records the submitted values + the `is_correct` as computed by the client against that snapshot; server performs no re-validation or override against "current" content.
4. When a player creates a *new* `QuestAttempt` (or initiates a fresh download for play), the attempt is bound to the Quest's current `latest_published_snapshot` (the one resulting from the most recent successful explicit Publish). If no published snapshot exists, the quest is not playable.
5. Old attempts remain fully valid and re-downloadable against their original snapshot. "Reset progress" on an attempt clears completions but keeps the same snapshot binding and versioned answer contract.
6. An explicit Publish action by an Administrator is the *only* operation that creates a new `latest_published_snapshot` from the current draft/working content. Draft edits never affect already-published snapshots or in-flight attempts.
7. The server retains sufficient data (the snapshot content + Answer lists + media references) to re-materialize the downloadable bundle for any snapshot that is (or ever was) referenced by at least one `QuestAttempt`. Retention is "indefinite" for such referenced snapshots (subject to operational policies for unreferenced ones). This enables recoverability after client data loss.
8. Snapshots carry a stable identifier (version number or id) that is recorded in attempts/completions and exposed for analytics, drift UI, and admin visibility ("attempts on v3").
9. Import of historical data creates at least one explicit legacy snapshot per quest (materialized from migration-time page_constructor data, Russian subset, mapped to GameStep model). All imported attempts/grants for that quest are bound to the legacy snapshot(s). This makes the approximation explicit.
10. Concurrent Publishes are serialized or rejected with conflict (atomicity at the Quest + latest pointer level). No two publishes can produce the same "latest" from inconsistent drafts.
11. (Cross-cutting with commerce) `AccessGrant` lifetime is independent of quest versions/snapshots. A grant allows starting attempts against whatever the latest snapshot is at attempt-creation time (or re-download of the snapshot bound to an existing attempt).
12. Physical steps (no Answer list) are still fully versioned for their content (task description, hints, geo display, gift rewards) so that "the experience the player was given" is frozen per attempt.

These invariants are the contract. Any implementation (DB schema, API, client bundle format, sync logic, import script) that violates them is out of sync with the business foundation.

---

## 7. How the Recommended Approach Supports Long-Term Maintainability

- **Conceptual clarity aids evolution**: "Snapshot on publish boundary" is easy to explain to new team members, stakeholders, and future external authors. Adding features (e.g. branching in a future version) means "a snapshot captures a particular graph at publish time"; the freeze + binding rules stay the same.
- **Data model hygiene**: One place (the snapshot) owns the versioned content. Attempts and completions FK to it for historical queries without "what was the content then?" guesswork. Denorm stats can live on Quest (lifetime) + be snapshot-able or version-specific.
- **Testing & reasoning**: The conceptual tests below are straightforward to turn into integration tests. Offline client tests can pin exact bundles per snapshot id. Import tests explicitly create the legacy snapshot.
- **Operational**: With dedup + ref-based media + referenced-only retention policy, growth is predictable and bounded by actual usage (attempts), not publish churn. Background jobs for sealing unreferenced snapshots + asset refcounting are natural extensions.
- **Analytics & improvement loop**: Per-version wrong-answer data (03) becomes first-class. Admins see "v2 had high failure on step 4 because Answer list missed a synonym" → fix in draft → publish v3. The freeze means v2 attempts stay "as played"; that's acceptable and auditable.
- **Migration to richer models later**: If B-style events are wanted, they can be recorded *in addition to* creating the snapshot on publish (the snapshot remains the safe materialized contract for clients). If D's semver is adopted, it is additive labels + hashes on the existing snapshots. COW can be introduced behind the publish for storage without changing attempt binding or invariants 1-7.
- **Avoids old scars**: No mutable "latest" that retroactively changes past attempts. No duplication like page/page_constructor. Constructor has clear "draft vs published snapshots" separation instead of 55+ workflows fighting in-place editing.
- **YAGNI respect today enables velocity**: By not shipping event sourcing or full semver machinery in v1, the team can deliver the core (constructor + player + offline + commerce + import of grants/attempts) faster, then use real usage data (actual publish frequency, how often minor fixes happen, player complaints about frozen bugs) to decide whether to layer D or B later. The variants doc itself is the artifact that makes future refactoring safe.

---

## 8. Conceptual Tests (Prose "Tests" / Invariant Checkers)

These are technology-agnostic scenarios that any implementation of the recommended (refined A) must pass. They can be turned into acceptance criteria, integration tests, or property-based checks.

1. **Frozen validation contract**: Quest published as snapshot v1 with acceptable answers ["42", "forty-two"] for the statue-hands step. Admin edits the list to ["43"] + publishes v2. Player who started attempt (and downloaded bundle) against v1 submits "42" offline. On sync: `is_correct=true` (per v1) is recorded for that attempt's StepCompletion; the attempt remains bound to v1. Player starting *new* attempt gets v2 and "42" is now wrong. (Verifies invariants 1-3, 4, 6.)
2. **Mid-publish long offline attempt unaffected**: Player downloads v1, goes offline for days doing real-world steps. Admin publishes v2 (answer fix + new narrative step). Player completes remaining steps against v1 bundle, syncs: all recorded against v1. Player's "continue" uses v1. Only a brand new attempt would see v2 + the extra step. (Edge 1.1.)
3. **Re-download after data loss recovers exact version**: Player has in-progress attempt bound to v1 (server has the completions synced so far). Phone wiped. Re-auths, opens the attempt: system serves the v1 snapshot bundle (full steps + v1's Answer lists + hash). Player can resume from last server-known completion using the exact answers that were correct for v1. (Verifies 7 + recoverability.)
4. **Import binds historical to explicit legacy snapshot**: During migration, for a quest with 150 historical answer_cards (no versions in source), system creates Quest + one "v0-legacy" snapshot (materialized from the imported page_constructor.Answer lists and RU content at import time). All imported attempts + StepCompletions are created with `snapshot_id = v0-legacy`. A new purchase + attempt after migration gets whatever the first real Publish produces (v1+). Analytics can distinguish "legacy imported plays" vs "v1 plays". (Verifies 9 + import handling.)
5. **Minor text publish still creates new snapshot for new attempts (per A baseline)**: Admin publishes a typo fix in a narrative step as v1.1 (or just v2 in pure A). New downloads/attempts receive the fixed text. Old attempts on v1 keep the original (typo'd) text in their bundle and any replay. No in-place mutation of published content. (Verifies "explicit publish creates", "old frozen", no mutable latest.)
6. **Concurrent publish safety**: Two admins have the quest open. Admin A saves a draft answer addition. Admin B clicks Publish (captures state without A's change). Admin A then clicks Publish. One of: the second Publish either (a) includes A's change (if serialized after), (b) conflicts and requires rebase/preview, or (c) creates vN from the exact draft at click time. No lost update; no two "latest" pointers exist simultaneously. (Verifies 10.)
7. **Physical step content is versioned**: A physical step's task description ("Touch the cold metal hands") + hint geo is changed + published as v2. Player on v1 attempt sees the original wording in their bundle and performs the action per v1's instruction. Their confirmation is recorded against v1. New attempt sees v2 wording. (Verifies 12 + that "no answer" steps are still snapshotted for content.)
8. **Version drift visibility + new attempt offer**: Player's collection shows "Mystery of the Fortress — In progress on v1 (latest published: v3)". Tapping offers "Continue v1" or "Start fresh attempt on v3 (new answers and content)". Continuing uses the v1 snapshot; fresh binds to v3. (UX for 1.5 + invariants 4-5.)
9. **(Bonus for refined A)** Content hash dedup: Two publishes that differ only in one narrative text still share the hashed Step records for the 25 unchanged steps. Storage for the second snapshot is incremental. (Implementation detail that preserves the model.)

Any implementation must also pass the cross-cutting invariants from section 6 and the offline model from 03 (local validation, no server re-val, sync records facts about the version, etc.).

---

## 9. Conclusion, Risks Remaining, and Next Actions

This analysis was deliberately skeptical and exhaustive for the scoped area. The locked model (explicit Publish → new snapshot/version; new attempts get latest; old frozen + server retains content+answers indefinitely for recoverability; client trusts its snapshot for offline validation) was re-attacked on its own terms (quality freeze, storage/operational cost of indefinite, import lossiness from old mutable unbound data, vagueness on "minor vs answer change", concurrent races). Old Bubble (statusQuest + Publish_on_the_site flag + in-place mutable page_constructor including Answer lists, no versions on answer_card, 1,163 workflows of accidental complexity) was shown to be fundamentally incompatible and a source of cautionary data (21 quests / 556 steps / duplication patterns / zero version fields).

Four approaches were fully cycled. **A (refined full immutable snapshots on explicit publish, with content-addressable dedup for steps, markers, and referenced-only retention policy) is recommended** as the best balance of robustness (honors offline + freeze + deliberate versioning), maintainability (simple mental model, clear invariants), and elegance under the explicit constraints (KISS/YAGNI, v1 scope, internal team, small current data volume, "do not over-engineer versioning if not needed").

The trade-off table, invariants, and conceptual tests provide maximum documentation for this slice so that implementers, future analysts (ANALYZE-09 migration, ANALYZE-05 attempts, etc.), and the synthesis step have a solid foundation. The chosen approach supports long-term evolution without locking the project into early over-complexity.

**Remaining risks (even with recommendation)**:
- Quality freeze for any buggy publish (accepted; mitigate with constructor preview quality + per-version analytics).
- Import will always be an approximation (no approach recovers lost edit history from old mutable data; document the "legacy snapshot at migration time" semantics clearly for players/admins).
- If publish frequency turns out high and most publishes are minor text, pressure will grow to adopt D-style annotations or COW laziness — the variants here make that a safe, informed addition rather than a rewrite.
- Media asset retention (refs must survive as long as any snapshot refs them).

**Status**: ANALYSIS COMPLETE for ANALYZE-02.  
**Report path**: `/home/nabor/_projects/geohod/quests/business/analysis/versioning-publishing-variants.md` (this file; created via explicit task requirement after reading existing analysis/README.md).  
**Todo tracking**: All steps of the mandated process completed (see internal todo state). Ready for main thread fetch + cross-review + synthesis with sibling ANALYZE-* reports.

**Absolute paths referenced in this report (for traceability)**:
- `/home/nabor/_projects/geohod/quests/business/01_DOMAIN_MODEL_AND_CONCEPTUAL_SCHEMA.md`
- `/home/nabor/_projects/geohod/quests/business/03_OFFLINE_PWA_AND_PROGRESS_MODEL.md`
- `/home/nabor/_projects/geohod/quests/business/04_CONTENT_MODEL_AND_QUEST_CONSTRUCTOR.md`
- `/home/nabor/_projects/geohod/quests/business/08_DECISIONS_LOG.md`
- `/home/nabor/_projects/geohod/quests/business/09_WHY_THE_QUESTIONS.md`
- `/home/nabor/_projects/geohod/quests/business/analysis/README.md`
- `/home/nabor/_projects/geohod/quests/discovery/parsed/data_types.json` (and option_sets.json, workflows_all.json, record_counts.json)
- `/home/nabor/_projects/geohod/quests/discovery/raw/data-api/probe_results.json`
- `/home/nabor/_projects/geohod/quests/docs/02_DATA_MODEL.md` (and siblings)

This is the maximum-documentation output for the slice. Further attacks or new evidence (real quest step examples, actual publish history if exportable, stakeholder relaxation of any locked item) should trigger an update to this file and the relevant business/ docs.

---

*End of ANALYZE-02 report.*