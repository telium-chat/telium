-- A claim was consumed only by an import that succeeded, so an import that
-- failed left it standing and the push could be repeated without limit. Each
-- attempt is real work on an unauthenticated-to-us bundle's behalf, so the
-- claim counts them and stops answering once a sender has clearly stopped
-- making progress.
ALTER TABLE import_claims ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
