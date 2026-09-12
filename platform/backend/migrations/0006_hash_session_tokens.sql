-- Session tokens are stored hashed, like every other bearer secret.
--
-- `auth_tokens` already keys on sha256 of the mailed reset link and code, for
-- the stated reason that "a database leak must not yield working reset links".
-- A session token is the same kind of secret and was the one exception: the
-- `sessions` PK held the token verbatim, so a leaked dump (backup, replica,
-- managed-console export) was a working login for every signed-in account.
--
-- The rewrite is lossless: sha256 is computed FROM the stored value, so every
-- live session keeps working and nobody is signed out. The raw token exists
-- only in the client's storage from here on.
ALTER TABLE sessions RENAME COLUMN token TO token_hash;
UPDATE sessions SET token_hash = encode(sha256(convert_to(token_hash, 'UTF8')), 'hex');
