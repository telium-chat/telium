-- The curated-feed ecosystem: finding curators, following one through a key
-- rotation, and offering what a guild's feeds vouch for as an upload host
-- (docs/media.md, "Finding a curator" and "Rotating a curator key").

-- Curator key rotation, subscriber side.
--
-- `public_b64` stays what it always was: the key the guild's rule pinned, the
-- anchor of this subscription's trust. It is never rewritten, because a
-- subscriber's chosen root is the one thing a curator must not be able to
-- change. What can move is the key currently in force, which is reached from
-- the anchor by a chain of rollovers, each signed by its predecessor.
ALTER TABLE media_feeds ADD COLUMN active_b64 TEXT;      -- NULL means the anchor itself
ALTER TABLE media_feeds ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;
-- A successor announced by the key in force and not yet used to sign anything.
-- Documents under it are accepted alongside the active key; the first one that
-- arrives completes the rotation.
ALTER TABLE media_feeds ADD COLUMN next_b64 TEXT;
ALTER TABLE media_feeds ADD COLUMN next_rotation INTEGER;
ALTER TABLE media_feeds ADD COLUMN next_seen_at INTEGER;

-- Every key this subscription has moved off. Retirement is one-way: a key that
-- was rotated away from cannot be rotated back to, however well a later
-- document is signed, because the reason to rotate is usually that the old key
-- is no longer only the curator's.
CREATE TABLE media_feed_retired_keys (
    url        TEXT NOT NULL,
    public_b64 TEXT NOT NULL,   -- the anchor, as in media_feeds
    retired_b64 TEXT NOT NULL,
    rotation   INTEGER NOT NULL,
    retired_at INTEGER NOT NULL,
    PRIMARY KEY (url, public_b64, retired_b64)
);

-- What a feed says about a host beyond allow/block. Kept so the upload-host
-- picker can offer a feed's hosts with the description the curator wrote,
-- rather than a bare domain. Untrusted text, checked for being showable before
-- it lands here and rendered as text and never as markup after.
ALTER TABLE media_feed_hosts ADD COLUMN name TEXT;
ALTER TABLE media_feed_hosts ADD COLUMN description TEXT;
ALTER TABLE media_feed_hosts ADD COLUMN max_file_bytes INTEGER;
ALTER TABLE media_feed_hosts ADD COLUMN abuse_contact TEXT;

-- Publisher side of a rotation: the successor this server has announced in the
-- feed it signs, and when it starts signing with it. The overlap is what gives
-- subscribers time to fetch a rollover-bearing document under the old key.
ALTER TABLE media_curator_key ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_curator_key ADD COLUMN next_secret_b64 TEXT;
ALTER TABLE media_curator_key ADD COLUMN next_public_b64 TEXT;
ALTER TABLE media_curator_key ADD COLUMN rotate_after INTEGER;

-- Curator directories this server reads, one row per (URL, pinned key) for the
-- same reason feeds are: a different key is a different publisher.
CREATE TABLE curator_directories (
    url          TEXT NOT NULL,
    public_b64   TEXT NOT NULL,
    label        TEXT,          -- the operator's name for it, from config
    publisher    TEXT,          -- what the last good copy calls itself
    serial       INTEGER,
    digest       TEXT,
    issued_at    INTEGER,
    expires_at   INTEGER,
    fetched_at   INTEGER,
    attempted_at INTEGER,
    error        TEXT,
    curators     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (url, public_b64)
);

-- The curators on each directory's last good copy. A directory entry is a
-- suggestion about who to ask, never a decision: nothing here admits an origin
-- until a moderator pins the key beside it.
CREATE TABLE curator_directory_entries (
    url         TEXT NOT NULL,
    public_b64  TEXT NOT NULL,
    feed_url    TEXT NOT NULL,
    feed_key    TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    contact     TEXT,
    PRIMARY KEY (url, public_b64, feed_url, feed_key)
);
