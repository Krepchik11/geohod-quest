-- Emails are canonical (trimmed + lowercased) at every auth API boundary.
-- Normalize legacy rows and enforce the invariant at the DB so no future code
-- path can reintroduce case-variant duplicate accounts. If two case-variants
-- of one mailbox already exist, the UPDATE violates users.email UNIQUE and the
-- migration fails loudly — that is real data corruption to resolve by hand,
-- not something to merge silently.
UPDATE users SET email = lower(btrim(email));
ALTER TABLE users ADD CONSTRAINT users_email_canonical CHECK (email = lower(btrim(email)));
