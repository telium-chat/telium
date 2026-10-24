-- What became of each of an account's uploads when the account moved.
--
-- Three things the first cut of media migration could not say, all of them
-- bookkeeping the source and the destination have to keep across restarts:
--
-- * which uploads the bundle carried and which the budget left behind, so the
--   source can serve the paged fetch for the latter and forward only the
--   former (`migration_media`, source side);
-- * which of the carried uploads the destination actually landed, so the
--   source forwards a fetch to a server that has the bytes and keeps serving
--   the ones the destination refused (`import_log.media_outcome`, destination
--   side, echoed in the acknowledgement);
-- * how far the destination has got fetching the ones the budget left behind,
--   so a restart resumes rather than starts over (`media_pulls`, destination
--   side).

-- Source side: one row per upload the export considered, keyed by the
-- migration that considered it.
--
-- `carried` and `omitted` are written when the bundle is built. A carried row
-- becomes `landed` or `refused` on the destination's say-so in the
-- acknowledgement; an omitted one when the destination confirms a page it
-- pulled. `moved_to` on the media row is set exactly when a row here becomes
-- `landed`, and never otherwise.
CREATE TABLE migration_media (
    migration_id TEXT NOT NULL,
    hash         TEXT NOT NULL,
    state        TEXT NOT NULL,             -- carried | omitted | landed | refused
    detail       TEXT NOT NULL DEFAULT '',  -- the destination's reason, when refused
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (migration_id, hash)
);

-- Destination side: the uploads the bundle named but did not carry, to be
-- fetched from the source one at a time after the account has landed.
--
-- `pending` rows are due when `next_attempt_at` has passed; every transport
-- failure moves the deadline out and counts an attempt, and the tenth gives
-- up as `failed`. `landed` and `refused` are final and are reported back to
-- the source in pages, after which `confirmed_at` is set; the source marks the
-- object moved only on that confirmation, which is why a landed row is kept
-- until it is confirmed rather than deleted.
CREATE TABLE media_pulls (
    migration_id    TEXT NOT NULL,
    hash            TEXT NOT NULL,
    source          TEXT NOT NULL,
    owner_user_id   TEXT NOT NULL,
    size            INTEGER NOT NULL,
    purpose         TEXT NOT NULL,
    state           TEXT NOT NULL,          -- pending | landed | refused | failed
    detail          TEXT NOT NULL DEFAULT '',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    confirmed_at    INTEGER,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (migration_id, hash)
);
CREATE INDEX media_pulls_due ON media_pulls (state, next_attempt_at);

-- What the import said about each carried upload: `{"landed": [hash, ...],
-- "refused": [{"hash": ..., "reason": ...}, ...]}`. Kept with the log row so an
-- acknowledgement re-issued later says the same thing the first one did.
-- Rows written before this column exists carry the empty string, and an
-- acknowledgement made from one of them says nothing about media -- which the
-- source reads as "everything carried landed", the assumption it made before
-- there was anything to read.
ALTER TABLE import_log ADD COLUMN media_outcome TEXT NOT NULL DEFAULT '';
