# Assumptions, Risks, and Open Questions (Business Concept v0.2)

**This document is the attack surface. Everything here should be questioned until it is either confirmed, removed, or turned into a deliberate, documented decision with trade-offs.**

## Major Assumptions (v0.2 — Updated & Some Resolved)

1. **Client fully validates against its downloaded quest version/snapshot. No server re-validation of correctness on sync.** New attempts/downloads receive the latest published version. Old attempts are frozen to the version they started with. (This is now the explicit model; risk of frozen buggy answers is accepted.)

2. **Linear sequence of steps is sufficient for v1.** Branching is noted as a good future TODO. No current branching in shipped quests.

3. **Physical "no answer required" steps are completed by explicit player confirmation in the app after performing the real-world action.** "No difference" between physical steps — all use the same confirmation mechanism. Optional note possible. No digital proof required for v1.

4. **Coins are earned only through quest completions and gifts defined inside steps.** No admin manual balance changes, no real-money coin purchases in v1.

5. **One quest at a time purchase (no complex basket/cart) is acceptable for players.**

6. **"Save then switch to real player as test user" is sufficient preview for the MVP constructor.**

7. **Importing historical grants + attempt history (including old step completions) from the Bubble data is desirable.**

8. **"Buy once, play forever + unlimited replays with reset/continue" is the model.**

9. **Russian only for v1.** (Already locked.)

10. **No GDPR/retention obligations.** (Already locked.)

11. **MVP auth is email + password only.** Other methods (OAuth, Telegram, etc.) added post-MVP.

## High-Impact Risks (v0.2)

- Frozen answers per snapshot: a published quest version with incorrect or suboptimal answers can never be corrected for players who already started attempts against it.
- Client is the sole judge of correctness for the version it downloaded. Any bug in client matching logic permanently affects recorded outcomes for those attempts.
- If we do not retain historical quest snapshots on the server, players may lose the ability to continue old attempts after clearing local data (because the exact old version's answer list is gone).
- Physical step completion mechanic feels too trivial ("just tap done") and reduces the magic for location-based physical tasks.
- 5 MB is comfortable, but accumulated cached quests + media across many quests could still pressure mobile storage.
- Importing old attempt history may be more complex than expected because old `answer_card` data was created through complex scheduled workflows without clean versioning.
- MVP email+password only may have higher friction than the previous Telegram-heavy flow.

## Open Questions — Grouped by Dependency

### Auth & Identity
- Primary authentication method for new players?
- Do we support Telegram login at all (as secondary/convenience), and how do we link it?
- Separate admin auth surface or unified?
- Anonymous or device-only play for already-downloaded quests (strongly discouraged)?

### Content & Steps
- Precise definition of acceptable answers for the constructor (one string? list? normalization rules? support for numeric ranges or multiple puzzle solutions?).
- Real usage of video in quests? Expected sizes?
- How common and important is branching or optional steps in actual published quests?
- "Namerequest" and similar special steps — still relevant?
- Exact UI the player sees for a physical step vs an answer step (prompts, confirmation language, success/failure states).

### Commerce
- Single quest purchase only, or do we need a cart that can hold multiple quests + one coupon?
- Gift purchases (buy for a friend)?
- 100% coupon vs "free quest" flag — are they the same to the player, or is there a distinction in discovery?

### Offline & Sync
- What exact "protected representation" of answers will be put into the downloadable bundle? (Hashed with what salt? Encrypted? Something else?)
- When an answer is validated locally as correct but server says incorrect on sync (author changed the answer, or hash mismatch), what does the player see and what happens to attempt stats?
- Can a player start playing a quest from multiple devices offline and have the attempts merge cleanly?
- Storage quota handling and "this quest is too big to download" UX.

### Constructor & Admin
- Is live preview inside the constructor mandatory for v1, or is "save and open in real player as test user" sufficient?
- What minimal stats does an admin need on the quest detail page to decide if it is working?
- Coupon management UI — create, list usage, disable — in v1 or post-launch?

### Data & Migration
- Do we need to import historical attempts and completions for existing users who have played, or only active grants + ability to replay?
- What happens to old `answer_card` data that was created via the complex scheduled workflows?

### Future / Non-v1
- When (if ever) would we want to revive events as a separate product vs. inside this codebase?
- Is there any appetite for external authors later, and does that change the constructor or permission model we design now?

## Process Note

Every assumption above is a potential flaw. Every open question above is a dependency that should be resolved before we consider the conceptual model "stable enough to start detailed design or code."

As Chief Staff Engineer, I will continue to treat the current proposals (including the ones in these docs) as suspect until they have been walked through with concrete examples from real quests (e.g., walk through "Mystery of the Fortress" step by step) and until the offline answer protection strategy has a clear, attack-resistant write-up.

## Next Actions (Recommended)

1. Provide answers / decisions on the highest-leverage open questions (auth primary method, answer representation for offline, branching reality, video importance).
2. Walk through 2-3 real quests (or their step lists) using the proposed GameStep model — identify gaps.
3. Decide the exact offline validation strategy (hashed, provisional, hybrid) and document the cheating model we are willing to accept.
4. Only then move to producing a more detailed spec (use cases, invariants per aggregate, error scenarios) or beginning implementation planning.

The old documentation and discovery artifacts are now historical reference only. These `business/` documents are the new foundation.
