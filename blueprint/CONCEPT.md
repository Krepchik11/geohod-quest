# CONCEPT

## Product Structure
The site has three main components:
- Marketplace of quests (discovery, purchase, collection).
- Quest (the player experience).
- Quest Constructor (for internal administrators only).

## Quest as Sequence of Steps
A quest is a linear sequence of game steps (no branching in v1).
Each game step is initiated by the quest.
The player completes it by:
- Moving to a location and sometimes performing an action with an object (for example, find a statue, touch its hands, and feel the cold metal — see the "Mystery of the Fortress" quest).
- Or determining and entering a correct answer (general knowledge question, information from a memorial plaque, count windows on a building, solve a rebus or puzzle).

There are exactly two task types:
1. No answer required (physical / move + optional action).
2. Answer required (enter correct value).

## Four Primary Templates (Page Structure)
Quest pages (game steps) are unified and presented in these templates:
1. First screen (start / greeting).
2. Task no answer (physical / move + optional action).
3. Task with answer (question / input).
4. Continue (narrative advance / terminal).

## Graphic Content
Every game page contains a specific comic-like image that participates in the gameplay.
The interaction principle is like a comic:
- Image can contain the task.
- Introduce a new character and start dialogue.
- Serve as a hint.
- Create the quest atmosphere.

## Navigator Button
On pages that require finding an object on location (physical / no-answer tasks), there is a button to enter navigator mode.
It determines the player's location and plots the shortest route to the task object.
The navigator is essentially a hint and its use is not mandatory.

## Bonuses (Coins)
For completing tasks the player receives coins.
This process is animated and voiced (like in computer games).
Coins can be spent on hints or accumulated to increase the player's personal rating.

## Hints
There is no separate button for taking a hint.
If the player enters a wrong answer, a popup appears with the option to exchange coins for a hint.

## Feedback
- Report quest errors: from any page via menu button "Оставить отзыв" (Leave feedback). The player can report errors from any step/context.
- Rate or comment: after completing the quest, the player can leave a rating or comment.

## Access Model
Players buy a quest once (or receive it for free / via coupon) and get lifetime access.
They can replay, reset progress, or continue previous attempts.
Grants are lifetime (no expiry in v1).
Sources of grants: payment, coupon redemption (percentage discount, including 100% = free), free quest, admin.

## Core Constraints (from vision and decisions)
- Full offline support as PWA: player downloads the quest (~5 MB bundle) and can complete most or all of it without network. Progress syncs when connected.
- Client fully validates correctness against the downloaded snapshot (no server re-validation on sync).
- New attempts use the latest published version; old attempts stay bound to their original version.
- Rich content is the main way to create atmosphere and differentiation.
- One clean GameStep shape (no 14 overloaded page types from the old system).
- Economy is lightweight but robust: coins come only from play (gifts defined in steps + completion bonuses); no admin manual adjustments and no real-money coin purchases in v1.
- Constructor is for internal team only (no external authors in v1).
- Language: Russian only in v1.
- No events/calendar/tours domain (that part is dead and not required).

## Key Invariants
- Quest = ordered sequence of GameSteps.
- Every published quest has at least one step.
- Steps have stable order per version.
- All content, rules, and amounts (acceptable answers, gift coins, hint costs, etc.) are frozen in the snapshot at publish time.
- Old attempts always use the rules and amounts from the version they started with.
- Grant is required before creating an attempt or downloading a bundle.
- Progress and coin movements are recorded as immutable facts (not direct mutations of state).
- Player balance is a deterministic projection of those facts.
- Client is authoritative for validation inside its own snapshot; server only records the submitted values and the client's local outcome claim.

## What We Explicitly Cut (Dead or Out of v1)
- Entire events/calendar/tours domain.
- External authors or semi-privileged content creators.
- Multi-language (EN/SRB) support.
- Magic links or password reset for legacy users.
- Complex leaked UI state.
- Old "constructor" duplication patterns and 1,163+ imperative workflows from the Bubble system.
- Any data retention / GDPR obligations (none apply).
- Branching in quests (linear only in v1).
- Real-money purchases of coins.
- Manual admin adjustment of player coin balances.

## Old System Problems (Cautionary — Do Not Recreate)
The previous Bubble implementation had:
- 47+ types, 36-field records with heavy multilingual explosion.
- 14 Page_type variants driving specialized code.
- 1,163 workflows (mostly UI state machines and direct mutations).
- Scattered coin logic, answer_card flag bags, no versioning, no offline design.
- Mutable content that could change under active players.
- No clean aggregates or invariants.

We must ruthlessly simplify to the model above and keep only what is justified by the clarified business needs.