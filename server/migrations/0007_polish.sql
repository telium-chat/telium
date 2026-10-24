-- Phase 5: the surface a chat app is actually judged on — reactions, threads,
-- pins, unread state, search — plus the abuse levers of Section 9 and the cold
-- storage of Section 11.

CREATE TABLE reactions (
    message_id TEXT NOT NULL,
    emoji      TEXT NOT NULL,               -- unicode, or <name:id> for a custom one
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id)
);
CREATE INDEX reactions_message ON reactions (message_id);

CREATE TABLE pins (
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    pinned_by  TEXT NOT NULL,
    pinned_at  INTEGER NOT NULL,
    PRIMARY KEY (channel_id, message_id)
);

-- Threads and forum posts are the same object: a channel with a parent and a
-- starter. Keeping them in `channels` means permissions and overwrites need no
-- second implementation.
CREATE TABLE threads (
    id            TEXT PRIMARY KEY,          -- also a row in channels
    parent_id     TEXT NOT NULL,
    guild_id      TEXT NOT NULL,
    starter_id    TEXT,                      -- message the thread grew from
    owner         TEXT NOT NULL,
    title         TEXT NOT NULL,
    tags          TEXT NOT NULL DEFAULT '[]',
    archived      INTEGER NOT NULL DEFAULT 0,
    locked        INTEGER NOT NULL DEFAULT 0,
    auto_archive  INTEGER NOT NULL DEFAULT 86400,
    message_count INTEGER NOT NULL DEFAULT 0,
    last_active   INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
);
CREATE INDEX threads_parent ON threads (parent_id, last_active DESC);

-- An announcement channel other channels subscribe to; posts are copied on send.
CREATE TABLE channel_follows (
    source_id  TEXT NOT NULL,
    target_id  TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, target_id)
);

-- Unread is a cursor, not a counter: the count is derived, so it cannot drift.
CREATE TABLE read_state (
    user_id      TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    last_read_id TEXT NOT NULL,
    muted        INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);

-- Mentions are recorded at send time so an unread badge is one indexed count
-- rather than a scan of message bodies.
CREATE TABLE message_mentions (
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,               -- '@everyone' and role ids allowed
    kind       TEXT NOT NULL DEFAULT 'user',
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mentions_user ON message_mentions (user_id, channel_id, message_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    message_id UNINDEXED,
    channel_id UNINDEXED,
    guild_id   UNINDEXED,
    author_id  UNINDEXED,
    tokenize = 'unicode61'
);

-- AutoMod: keyword, regex, link, and flood rules, all local (Section 9).
CREATE TABLE automod_rules (
    id         TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL,               -- keyword | regex | link | flood | mention
    pattern    TEXT NOT NULL,
    action     TEXT NOT NULL DEFAULT 'block',-- block | flag | timeout
    threshold  INTEGER NOT NULL DEFAULT 0,
    exempt_roles TEXT NOT NULL DEFAULT '[]',
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE INDEX automod_guild ON automod_rules (guild_id, enabled);

CREATE TABLE automod_hits (
    id         TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    rule_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    action     TEXT NOT NULL,
    excerpt    TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX automod_hits_guild ON automod_hits (guild_id, created_at DESC);

-- Join gates. Federated identity makes throwaway accounts as cheap as the most
-- permissive homeserver in existence, so a guild needs levers (Section 9).
ALTER TABLE guilds ADD COLUMN min_account_age_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN domain_policy TEXT NOT NULL DEFAULT 'open';   -- open | allowlist | blocklist
ALTER TABLE guilds ADD COLUMN screening TEXT NOT NULL DEFAULT '[]';         -- questions
ALTER TABLE guilds ADD COLUMN hold_first_messages INTEGER NOT NULL DEFAULT 0;

CREATE TABLE guild_domain_rules (
    guild_id TEXT NOT NULL,
    domain   TEXT NOT NULL,
    action   TEXT NOT NULL DEFAULT 'allow',
    PRIMARY KEY (guild_id, domain)
);

-- Messages held for review from members who just joined.
CREATE TABLE held_messages (
    id         TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    author_id  TEXT NOT NULL,
    payload    TEXT NOT NULL,
    reason     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    state      TEXT NOT NULL DEFAULT 'pending',
    handled_by TEXT,
    handled_at INTEGER
);
CREATE INDEX held_messages_guild ON held_messages (guild_id, state, created_at);

-- Screening answers, kept so a moderator can read them before approving.
CREATE TABLE screening_answers (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    answers    TEXT NOT NULL,
    state      TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);

-- Push relay: the homeserver forwards a wake-up to whatever gateway the client
-- registered, carrying no message content (Section 3).
CREATE TABLE push_subscriptions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,               -- webpush | relay
    endpoint   TEXT NOT NULL,
    auth       TEXT,
    created_at INTEGER NOT NULL,
    failures   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_user ON push_subscriptions (user_id);

-- Cold storage: history beyond the horizon moves to compressed segments and is
-- paged back in for scrollback and search.
CREATE TABLE cold_segments (
    id         TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    first_id   TEXT NOT NULL,
    last_id    TEXT NOT NULL,
    messages   INTEGER NOT NULL,
    bytes      INTEGER NOT NULL,
    path       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX cold_segments_channel ON cold_segments (channel_id, first_id);
