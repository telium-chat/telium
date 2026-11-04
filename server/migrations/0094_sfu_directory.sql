-- The public SFU directory (SFU_PLAN.md).
--
-- Mesh calls degrade past a handful of participants, and a guild owner cannot
-- fix that alone: somebody must run a relay and the guild must point at one.
-- This table holds this server's copy of the public SFU directory -- one signed
-- document naming volunteer-operated relays, fetched on exactly the terms a
-- hosting catalogue is held on (0043): keyed by URL and the pinned publisher
-- key, only ever moving forward, replaced wholesale.
--
-- An entry here is a suggestion, never an obligation: it becomes call traffic
-- only when a guild's voice mode resolves to it, and it stops being suggested
-- the moment the publisher stops listing it. Nothing in this directory is
-- auto-dialled; a relay nobody chose carries nobody's calls.

-- One row per (directory URL, pinned key): the last good copy's facts and the
-- last attempt's outcome. Keyed by both because two operators pinning
-- different keys for one URL are trusting two different publishers, and a new
-- key is a new trust root with its own serial history.
CREATE TABLE sfu_directory (
    url          TEXT NOT NULL,
    public_b64   TEXT NOT NULL,
    publisher    TEXT,           -- what the last good copy called itself
    serial       INTEGER,        -- of the last good copy; only ever increases
    digest       TEXT,           -- BLAKE3 of that copy's body, for equal serials
    issued_at    INTEGER,
    expires_at   INTEGER,
    fetched_at   INTEGER,        -- when the last good copy was verified
    attempted_at INTEGER,        -- the last fetch, good or not
    error        TEXT,           -- why the last fetch was not adopted, if it was not
    last_error   TEXT,           -- current state vs. history, as in 0071
    failure_kind TEXT,
    failed_at    INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    sfus         INTEGER NOT NULL DEFAULT 0,
    added_at     INTEGER NOT NULL,
    PRIMARY KEY (url, public_b64)
);

-- The relays on the last good copy. Every column here was bounded and checked
-- by `telium_protocol::sfu_directory` before it was written, and every one of
-- them is display text, a base URL or a declared band. The relay's base URL is
-- the entry's identity, as it is in the signed document.
CREATE TABLE sfu_directory_entries (
    url           TEXT NOT NULL,
    public_b64    TEXT NOT NULL,
    position      INTEGER NOT NULL,   -- the order the publisher listed them in
    sfu           TEXT NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT,
    region        TEXT NOT NULL,
    region_label  TEXT NOT NULL,
    operator_name TEXT NOT NULL,
    contact       TEXT NOT NULL,
    capacity_band TEXT NOT NULL,
    weight        INTEGER NOT NULL,
    pubkey_hint   TEXT,
    PRIMARY KEY (url, public_b64, sfu),
    FOREIGN KEY (url, public_b64) REFERENCES sfu_directory (url, public_b64) ON DELETE CASCADE
);
CREATE INDEX sfu_directory_entries_order ON sfu_directory_entries (url, public_b64, position);

-- Whether a guild region was added from the directory. Only these rows earn a
-- "no longer listed" warning when the publisher stops listing their relay; a
-- URL a guild owner typed by hand was never listed to begin with.
ALTER TABLE guild_voice_regions ADD COLUMN from_directory INTEGER NOT NULL DEFAULT 0;
