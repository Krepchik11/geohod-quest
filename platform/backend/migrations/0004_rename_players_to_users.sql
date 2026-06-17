-- Rename the account table `players` -> `users` (access-roles work).
--
-- "player" is now overloaded: it is also a ROLE (admin/editor/player). The account
-- table therefore becomes `users`, matching what a row actually is — a registered
-- user. The `player_id` COLUMN is deliberately KEPT everywhere: it is the *playing
-- identity* (`dev:<uuid>`), present even for anonymous devices that have no account
-- row, and the partition key across attempts/facts/grants/bonus_awards/sessions. So
-- `users.player_id` reads as "the player identity this user account is attached to".
--
-- Renaming the table automatically carries the `sessions` foreign key over to
-- `users` (the constraint follows the table), so only the table itself and its
-- created_at index (named after the old table) need explicit renames. This is an
-- additive, append-only migration: editing 0002/0003 would change their sqlx
-- checksums and fail startup migration verification.
ALTER TABLE players RENAME TO users;
ALTER INDEX idx_players_created_at RENAME TO idx_users_created_at;
