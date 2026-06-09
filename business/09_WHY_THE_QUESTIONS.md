# Why the Questions? (And Why We Do Not Just Copy the Current Project's Behavior)

This document exists because the question was asked directly: "Why do you asking all this question, dont current project contains all of the specific behavior?"

## Short Answer

The current project contains a *large amount of implementation detail and accidental complexity*, not a clean, intentional, robust specification of business behavior.

We are not porting a system. We are **extracting business intent** from a no-code artifact that accumulated 1,163 workflows (mostly UI state machines), 47 data types, duplicated "constructor" types, UI state leaked into the User record, dead event code, unknown plugins, "666" workflows, ignored privacy rules in critical paths, and no designed support for the new hard requirements (full offline PWA + explicit versioning for snapshots).

Asking questions is the only way to separate "what the business actually needs" from "how it was wired together in Bubble under time pressure."

## Detailed Deconstruction of "The Current Project Contains the Specific Behavior"

### 1. The Old System Has No Concept of What We Are Now Building
- **Offline PWA + downloadable self-contained quest versions**: The old system had zero support for this. All answer_card creation, validation, and progress happened through API workflows that assumed connectivity. There are no bundles, no snapshot versioning, no local validation logic.
- **Explicit quest versions / snapshots tied to attempts**: The old system had `statusQuest` (published/test/project) and `Publish_on_the_site` boolean. Content was mutable in place. No historical versions of answer lists were kept for old playthroughs.
- **Clean separation of "client validates its version" vs server recording**: The old `addAnswerCard`, `create_answer_card_list`, and the entire family of scheduled "666" workflows mixed frontend state, backend mutations, and assumed server always had the latest answers.

If we had simply "copied the specific behavior," we would have no offline model at all.

### 2. Much of the "Specific Behavior" Is Technical Debt, Not Domain Rules
From the parsed data (even before workflows):

- `page` vs `page_constructor`, `quest` vs `quest_name_constructor` — same data, duplicated because the editor needed separate types.
- User record with 30 fields including `closePopup`, `deleteUser`, `current_lat`/`current_long` as persistent scalars, `techno` email/password fields, lists of everything.
- 5 database triggers existed *only* for the dead event work-time capacity state machine.
- `answer_card` has `del` (probably soft delete), `Buy_hint`, `Complited`, `You_made_it`, `Complited_quest`, `Count_wrong_answers` — a bag of flags that were mutated by dozens of imperative workflows.
- `Gift_Coins` lives on `page_constructor`. `Balance_coin` on user. `Getting_5_coins_for_completing` is a *list of quests* on the user (to track who already got the 5-coin bonus?). `countCoinMadeIt` on quest. The actual *when* the balance is increased, when "You_made_it" is set, how gift steps interact with hint buying, whether coins are per-attempt or global, whether the 5-coin award happens only on first completion — all of this lives in the 82 workflows on the `quest` page + reusable elements like "steps_for_accruing_coins_" + backend API events. It is not a clean rule; it is scattered mutations.

"Copying the behavior" would mean re-implementing the scattering.

### 3. The Discovery Artifacts Themselves Documented the Ambiguity
The original `docs/APPENDIX/OPEN_QUESTIONS.md` and the BUBBLE_DOCUMENTATION_AGENT_TASK already listed many gaps precisely because the source was noisy:
- Which branch is production?
- Why are page and page_constructor identical?
- 40 data types not in API.
- Unknown plugins driving 41 + 31 actions.
- "chatbot workflow" — what does it actually do?

The old project did *not* contain clear, self-documenting specific behavior.

### 4. We Have New Hard Requirements the Old System Never Met
- Full offline play as PWA (with ~5MB bundles).
- Client must validate locally against a specific version.
- Explicit snapshots that can be kept indefinitely.
- Clean replay + reset + continue across versions.
- Simple roles (only Administrator now).
- Email+password MVP auth only.
- No events domain.

Any "specific behavior" from the old system that assumed always-online, mutable live content, or heavy Telegram flows is now invalid or must be consciously adapted.

### 5. The Role Is Chief Staff Engineer + Relentless Critical Analyst
The mandate is not "recreate what existed."
The mandate is:
- Deconstruct
- Expose flaws harshly (including in the old system *and* in our proposals)
- Rebuild superior alternative
- Self-critique
- Iterate until it survives adversarial scrutiny
- Apply TDD, SOLID, DRY, KISS, YAGNI at the *conceptual* level first

Asking the questions *is* the work. It is how we avoid shipping a "Rust + Next.js port of Bubble spaghetti."

## What the Current Project *Is* Good For

- Source of real quest content (the actual steps, texts, images, Gift_Coins values, answer patterns that exist today) → for migration and to validate our GameStep model.
- Historical grants and attempt data (import).
- Clues about what was important enough to build (location display, hint coins, physical observation steps, gift steps that award coins, "You_made_it" moments).
- Warning signs of what to never do again (UI state in database, 444 SetCustomState, constructor duplication, 20+ event_* types for a dead feature).

We are using it. We are just refusing to treat its implementation accidents as sacred domain rules.

## Bottom Line

If the goal was to lift-and-shift the existing mess into a typed language while keeping all the same accidental complexity and missing the new offline + versioning requirements, we would not need this process.

The goal is a correct, efficient, robust, highly maintainable system that properly supports the clarified business (lifetime access, offline-first PWA, clean internal constructor, simple roles, etc.).

That requires understanding the *intent* behind the specific behaviors, not just the behaviors as they were hacked together.

This is why the questions continue until shared understanding and the model can survive scrutiny.

The current project is the *starting material*, not the *specification*.
