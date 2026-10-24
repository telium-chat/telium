-- Section 7. Voice state lives here; media never does. The SFU is a regional
-- pipe that verifies our signed tokens — it holds no membership, no roles, and
-- no authority of its own.

ALTER TABLE channels ADD COLUMN voice_region TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE channels ADD COLUMN bitrate INTEGER;                  -- null = server ceiling
ALTER TABLE channels ADD COLUMN user_limit INTEGER NOT NULL DEFAULT 0;

-- One row per connected member. Server-side mute/deaf are separate columns from
-- the self- flags because only one of the two is the member's to change.
CREATE TABLE voice_states (
    guild_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    region      TEXT NOT NULL,
    self_mute   INTEGER NOT NULL DEFAULT 0,
    self_deaf   INTEGER NOT NULL DEFAULT 0,
    self_video  INTEGER NOT NULL DEFAULT 0,
    streaming   INTEGER NOT NULL DEFAULT 0,
    stream_preset TEXT,
    server_mute INTEGER NOT NULL DEFAULT 0,
    server_deaf INTEGER NOT NULL DEFAULT 0,
    joined_at   INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX voice_states_channel ON voice_states (channel_id);

-- Watching a stream is an explicit subscription: a stream in a 30-person channel
-- with 4 watchers costs four forwards, not thirty.
CREATE TABLE voice_watchers (
    channel_id TEXT NOT NULL,
    viewer     TEXT NOT NULL,
    streamer   TEXT NOT NULL,
    quality    TEXT NOT NULL DEFAULT 'auto',
    started_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, viewer, streamer)
);

-- Health of each configured region, so "auto" and failover have something real
-- to decide on.
CREATE TABLE sfu_health (
    region     TEXT PRIMARY KEY,
    endpoint   TEXT NOT NULL,
    healthy    INTEGER NOT NULL DEFAULT 1,
    failures   INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    checked_at INTEGER NOT NULL,
    detail     TEXT
);
