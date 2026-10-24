-- Curated media-origin feeds (docs/media.md, "Curated origin feeds").
--
-- A guild origin rule may name a feed instead of a domain. Until now that was a
-- stored subscription and nothing more; these tables are what it resolves to.

-- The curator key a feed rule pins. A feed is only ever verified against the
-- key its subscriber chose, never one the document names for itself. NULL on
-- rules saved before this migration, which stay unresolved until re-pinned.
ALTER TABLE guild_origin_rules ADD COLUMN feed_key TEXT;

-- One row per (feed URL, pinned key): the last good copy's facts and the last
-- attempt's outcome. Keyed by both because two guilds pinning different keys
-- for one URL are trusting two different curators, and a new key is a new
-- trust root with its own serial history.
CREATE TABLE media_feeds (
    url          TEXT NOT NULL,
    public_b64   TEXT NOT NULL,
    curator      TEXT,
    serial       INTEGER,       -- of the last good copy; only ever increases
    digest       TEXT,          -- BLAKE3 of that copy's body, for equal serials
    issued_at    INTEGER,
    expires_at   INTEGER,
    fetched_at   INTEGER,       -- when the last good copy was verified
    attempted_at INTEGER,       -- the last fetch, good or not
    error        TEXT,          -- why the last fetch was not adopted, if it was not
    allows       INTEGER NOT NULL DEFAULT 0,
    blocks       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (url, public_b64)
);

-- The hosts on each feed's last good copy.
CREATE TABLE media_feed_hosts (
    url        TEXT NOT NULL,
    public_b64 TEXT NOT NULL,
    origin     TEXT NOT NULL,
    action     TEXT NOT NULL,   -- allow | block
    PRIMARY KEY (url, public_b64, origin)
);
CREATE INDEX media_feed_hosts_origin ON media_feed_hosts (origin);

-- The key this server signs its own published registry feed with. Separate
-- from the federation key on purpose: subscribers pin it, and the federation
-- key rotates on a schedule that would break every pin.
CREATE TABLE media_curator_key (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    secret_b64 TEXT NOT NULL,
    public_b64 TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
