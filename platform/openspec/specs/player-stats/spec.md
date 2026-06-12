# player-stats Specification

## Purpose
TBD - created by archiving change player-identity-live-commerce. Update Purpose after archive.
## Requirements
### Requirement: Player statistics are a pure deterministic fold over all of the player's attempt facts plus grants
The system SHALL provide `GET /api/players/me/stats` returning, for the resolved identity: signed coin balance folded over ALL facts of ALL the player's attempts (plain fold, MAY be negative, no clamping server-side), quests_completed (count of distinct quest_ids having at least one attempt with an `attempt_completed` fact), the list of completed quest_ids, attempts_count, and grants_count. The fold SHALL be a pure function in the projector module (no IO); storage backends only gather fact logs — folds are never re-implemented in SQL. Results SHALL be identical on both storage backends and stable under idempotent re-appends (no double counting).

#### Scenario: Cross-attempt balance and completion fold
- **WHEN** a player has quest A completed (gift +5, completion_bonus +5) and quest B in progress with a hint spend (−12)
- **THEN** stats report balance −2 (signed, unclamped), quests_completed 1 with completed list [A], attempts_count 2, grants_count 2; re-posting the same fact batches changes nothing.

#### Scenario: Identity enforcement applies to stats
- **WHEN** stats are requested for a registered player without a token, or with a valid token
- **THEN** the tokenless request is rejected 401 and the tokened request returns the stats; an anonymous (never-registered) player id gets its stats tokenless.

### Requirement: Profile page renders live player statistics per design with an offline fallback
The profile page SHALL render the design's game tiles — coin balance (signed, displayed as-is), personal rating = max(balance, 0) (display floor client-side per SPEC), quests completed — from the live stats endpoint for the current identity, plus user data (email when registered, anonymous label otherwise). When the backend is unreachable the page SHALL fall back to the local facts fold (current behavior), clearly labeled as local/offline data.

#### Scenario: Registered player sees live account stats
- **WHEN** a registered player with synced facts opens the profile online
- **THEN** the tiles show the server-folded balance, rating floored at 0, and quests-completed count; the user-data card shows the registered email.

#### Scenario: Unreachable backend falls back to local fold with a label
- **WHEN** the profile opens while the backend is unreachable
- **THEN** the tiles render from the locally stored facts fold and the page indicates the data is local/offline; no crash, no blank tiles.

