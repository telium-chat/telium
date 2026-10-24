-- Phase 2: federation, media origins beyond our own, moderation reach, and the
-- migration machinery (plan Sections 5, 6, 9, 10).

-- Cached discovery + key material for peers. The published validity windows are
-- honoured, so a signature made shortly before a rotation still verifies.
CREATE TABLE remote_servers (
    origin     TEXT PRIMARY KEY,
    api_base   TEXT NOT NULL,
    gateway    TEXT,
    fetched_at INTEGER NOT NULL,
    failures   INTEGER NOT NULL DEFAULT 0,
    moved_to   TEXT                       -- domain-level tombstone (Section 10)
);

CREATE TABLE remote_keys (
    origin      TEXT NOT NULL,
    key_id      TEXT NOT NULL,
    public_b64  TEXT NOT NULL,
    valid_from  INTEGER NOT NULL,
    valid_until INTEGER NOT NULL,
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (origin, key_id)
);

-- Read-through cache of foreign media. Explicitly non-canonical: it honours the
-- origin's TTL and its purge webhook, and never outlives a deletion (Section 6).
CREATE TABLE media_cache (
    origin     TEXT NOT NULL,
    hash       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    hits       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (origin, hash)
);
CREATE INDEX media_cache_expiry ON media_cache (expires_at);

-- Vouchers we have issued as a guild host, kept only so they can be revoked and
-- audited; the origin verifies the signature, not this row.
CREATE TABLE media_vouchers (
    id         TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    origin     TEXT NOT NULL,
    hash       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Tier 3: the camo/embed proxy. Members' clients only ever talk to us.
CREATE TABLE embeds (
    url_hash    TEXT PRIMARY KEY,          -- blake3 of the normalised URL
    url         TEXT NOT NULL,
    status      TEXT NOT NULL,             -- ok | blocked | error
    kind        TEXT,                      -- link | image | video
    title       TEXT,
    description TEXT,
    site        TEXT,
    image_hash  TEXT,                      -- cached thumbnail in the media table
    error       TEXT,
    fetched_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);

-- Federated abuse reports, in both directions.
CREATE TABLE reports (
    id          TEXT PRIMARY KEY,
    direction   TEXT NOT NULL,             -- inbound | outbound
    origin      TEXT NOT NULL,             -- reporting server
    destination TEXT NOT NULL,
    reporter    TEXT,
    target_type TEXT NOT NULL,             -- message | media | account | guild
    target_id   TEXT NOT NULL,
    category    TEXT NOT NULL,
    detail      TEXT,
    evidence    TEXT NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  INTEGER NOT NULL,
    handled_by  TEXT,
    handled_at  INTEGER
);
CREATE INDEX reports_status ON reports (status, created_at DESC);

-- Server-level defederation, plus the signed feeds communities pool.
CREATE TABLE defederation (
    domain     TEXT PRIMARY KEY,
    scope      TEXT NOT NULL DEFAULT 'all', -- all | identity | dm | media
    reason     TEXT,
    source     TEXT NOT NULL DEFAULT 'local',
    created_at INTEGER NOT NULL
);

CREATE TABLE blocklist_feeds (
    url         TEXT PRIMARY KEY,
    public_b64  TEXT,
    label       TEXT,
    fetched_at  INTEGER,
    entries     INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1
);

-- Guilds decide which origins they accept references from, because accepting a
-- reference means trusting that origin's moderation (Section 6).
ALTER TABLE guilds ADD COLUMN origin_policy TEXT NOT NULL DEFAULT 'open';   -- open | allowlist | blocklist
ALTER TABLE guilds ADD COLUMN require_voucher INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN external_emoji INTEGER NOT NULL DEFAULT 1;
ALTER TABLE guilds ADD COLUMN fallback_domain TEXT;

CREATE TABLE guild_origin_rules (
    guild_id TEXT NOT NULL,
    domain   TEXT NOT NULL,
    action   TEXT NOT NULL DEFAULT 'allow', -- allow | block
    feed_url TEXT,                          -- "accept any host on feed X"
    PRIMARY KEY (guild_id, domain)
);

-- ------------------------------------------------------------------ migration

-- Signed redirect records. ~300 bytes, retained indefinitely by intent: a
-- resolvable old id is what stops server-hopping from laundering a reputation.
CREATE TABLE tombstones (
    subject_type TEXT NOT NULL,             -- user | guild | domain
    subject_id   TEXT NOT NULL,
    kind         TEXT NOT NULL,             -- moved | gone
    new_id       TEXT,
    record       TEXT NOT NULL,             -- the co-signed JSON
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (subject_type, subject_id)
);

-- Remote tombstones we have learned about, so history can resolve old ids and
-- membership can be remapped without asking again.
CREATE TABLE remote_tombstones (
    subject_type TEXT NOT NULL,
    subject_id   TEXT NOT NULL,
    kind         TEXT NOT NULL,
    new_id       TEXT,
    record       TEXT NOT NULL,
    learned_at   INTEGER NOT NULL,
    PRIMARY KEY (subject_type, subject_id)
);

-- A migration in flight. Nothing on this server is modified until the
-- destination acknowledges a whole bundle, and the cooling-off window gives the
-- account's real devices time to cancel (Section 10).
CREATE TABLE migrations (
    id            TEXT PRIMARY KEY,
    subject_type  TEXT NOT NULL,           -- user | guild
    subject_id    TEXT NOT NULL,
    destination   TEXT NOT NULL,
    grant_token   TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    device_sig    TEXT NOT NULL,
    state         TEXT NOT NULL,           -- pending | ready | completed | cancelled | failed
    detail        TEXT,
    created_at    INTEGER NOT NULL,
    executes_at   INTEGER NOT NULL,
    completed_at  INTEGER
);
CREATE INDEX migrations_subject ON migrations (subject_id, state);

-- Accounts and guilds imported from elsewhere keep their signed provenance: the
-- original creation date rides along so account-age gates survive a move.
CREATE TABLE imported_identities (
    user_id       TEXT PRIMARY KEY,
    previous_id   TEXT NOT NULL,
    original_created_at INTEGER NOT NULL,
    chain         TEXT NOT NULL,
    imported_at   INTEGER NOT NULL
);

-- Warm standby: a co-signed authorisation created when the pairing is set up,
-- and the monotonic promotion chain that fences split brain.
CREATE TABLE failover (
    subject_type  TEXT NOT NULL,
    subject_id    TEXT NOT NULL,
    standby       TEXT NOT NULL,
    authorization TEXT NOT NULL,
    sequence      INTEGER NOT NULL DEFAULT 0,
    promoted      INTEGER NOT NULL DEFAULT 0,
    record        TEXT,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (subject_type, subject_id)
);

-- Small operator key/value: sunset state, domain relocation, backup nag state.
CREATE TABLE server_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
