-- Call modes in DMs and group chats (docs/calls.md).
--
-- The sequencer decides whether a conversation's call is a mesh or runs through
-- an SFU, and whose SFU. It decides from three bits each participant's home
-- reports on joining, and never from anyone's privacy posture, which stays on
-- the clients:
--
--   wants_sfu   the participant's client asked to be routed through an SFU
--   home_sfu    the participant's home has SFU regions it could host on
--   custom_sfu  the participant's client holds a custom SFU for this
--               conversation (the endpoint itself is only in MLS group state)
--
-- Guild rows leave all three at zero.
ALTER TABLE voice_states ADD COLUMN wants_sfu INTEGER NOT NULL DEFAULT 0;
ALTER TABLE voice_states ADD COLUMN home_sfu INTEGER NOT NULL DEFAULT 0;
ALTER TABLE voice_states ADD COLUMN custom_sfu INTEGER NOT NULL DEFAULT 0;

-- One row per conversation with a call running, held by its sequencer. `host`
-- is the server whose SFU carries the call ('custom' for the conversation's own
-- SFU, whose tokens the sequencer mints), NULL while the call is a mesh.
-- `generation` counts topology changes, so a client can tell a fresh
-- VOICE_SERVER_UPDATE from a stale one. The row goes when the roster empties.
CREATE TABLE conversation_calls (
    conversation_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'mesh',
    host TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
