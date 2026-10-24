-- Managed guild-hosting marketplace (docs/hosting.md).
--
-- An operator may subscribe to one or more signed hosting catalogues, each of
-- which lists companies that will run a guild for somebody who would rather not
-- run one themselves. These tables hold the last good copy of each, on exactly
-- the terms a curated media-origin feed is held on (0039): keyed by URL and the
-- pinned publisher key, only ever moving forward, and replaced wholesale.
--
-- Nothing here records a purchase, an account or a credential. A person who
-- chooses a provider leaves for that provider's own signup page, and this
-- server never learns whether they went through with it.

-- One row per (catalogue URL, pinned key): the last good copy's facts and the
-- last attempt's outcome. Keyed by both because two operators pinning different
-- keys for one URL are trusting two different publishers, and a new key is a
-- new trust root with its own serial history.
CREATE TABLE hosting_catalogs (
    url          TEXT NOT NULL,
    public_b64   TEXT NOT NULL,
    label        TEXT,           -- what the operator called it when subscribing
    publisher    TEXT,           -- what the last good copy called itself
    serial       INTEGER,        -- of the last good copy; only ever increases
    digest       TEXT,           -- BLAKE3 of that copy's body, for equal serials
    issued_at    INTEGER,
    expires_at   INTEGER,
    fetched_at   INTEGER,        -- when the last good copy was verified
    attempted_at INTEGER,        -- the last fetch, good or not
    error        TEXT,           -- why the last fetch was not adopted, if it was not
    providers    INTEGER NOT NULL DEFAULT 0,
    added_at     INTEGER NOT NULL,
    PRIMARY KEY (url, public_b64)
);

-- The providers on each catalogue's last good copy. Every column here was
-- bounded and checked by `telium_protocol::hosting_catalog` before it was
-- written, and every one of them is display text or a link a person may choose
-- to follow. `regions` and `plans` are JSON arrays this server re-serialised
-- from the parsed, validated structures -- never the publisher's bytes.
CREATE TABLE hosting_providers (
    url         TEXT NOT NULL,
    public_b64  TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    position    INTEGER NOT NULL,   -- the order the catalogue listed them in
    name        TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    signup_url  TEXT NOT NULL,
    terms_url   TEXT NOT NULL,
    privacy_url TEXT,
    contact     TEXT,
    description TEXT,
    regions     TEXT NOT NULL,
    plans       TEXT NOT NULL,
    public_key  TEXT NOT NULL,
    PRIMARY KEY (url, public_b64, provider_id),
    FOREIGN KEY (url, public_b64) REFERENCES hosting_catalogs (url, public_b64) ON DELETE CASCADE
);
CREATE INDEX hosting_providers_catalog ON hosting_providers (url, public_b64, position);

-- The key this server signs its own published catalogue with, so an operator
-- who curates a provider list is a publisher other servers can subscribe to.
-- Separate from the federation key for the reason the media curator key is:
-- subscribers pin it, and the federation key rotates on a schedule that would
-- break every pin.
CREATE TABLE hosting_catalog_key (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    secret_b64 TEXT NOT NULL,
    public_b64 TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
