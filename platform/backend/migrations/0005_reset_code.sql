-- v2 §6.2 R2: password reset by emailed 6-digit code, alongside the R1 link.
-- The code is low-entropy and online-guessable by design, so the row carries
-- its own guard: a per-token attempt counter (the code stops verifying after
-- a fixed number of attempts) plus the single-use semantics shared with the
-- link. Codes are stored hashed like tokens — a database leak must not yield
-- working codes. Legacy rows get code_hash '' which no sha256 hex can match.
ALTER TABLE auth_tokens ADD COLUMN code_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE auth_tokens ADD COLUMN attempts BIGINT NOT NULL DEFAULT 0;
