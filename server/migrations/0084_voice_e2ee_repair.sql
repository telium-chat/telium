-- Repair for a guild call's encryption group (docs/guild-calls.md).
--
-- The relay that carries a call's commits does not replay: a gateway that
-- dropped for a second used to cost a member the commit it missed, and with
-- it the call. The server keeps the commits it accepted for the call's
-- current group so a member that missed one can read it back, and a joiner
-- whose Welcome went astray can read that too. Ciphertext and public
-- handshake only; it holds no key. Cleared when the group starts over, and
-- capped (voice.rs, E2EE_LOG_KEEP), so it never outgrows one call.
CREATE TABLE voice_e2ee_log (
    channel_id   TEXT NOT NULL,
    group_id     TEXT NOT NULL,
    epoch        INTEGER NOT NULL,     -- the epoch the commit moved the group to
    commit_msg   TEXT NOT NULL,
    welcome      TEXT,
    added        TEXT NOT NULL DEFAULT '[]',  -- JSON array of user ids
    committed_by TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (channel_id, group_id, epoch)
);

-- The member the server names as the one who writes the next commit, and
-- since when. Every client used to work it out from the roster on its own;
-- a committer that was in the roster and not answering stalled every joiner,
-- and nothing could say so.
ALTER TABLE voice_e2ee_groups ADD COLUMN committer TEXT;
ALTER TABLE voice_e2ee_groups ADD COLUMN committer_at INTEGER NOT NULL DEFAULT 0;

-- When this session's package was offered, so a joiner nobody has added can
-- be told apart from one that has only just arrived; and whether the
-- committer refused the package outright (malformed, or not this device's),
-- so the joiner can be told so instead of waiting.
ALTER TABLE voice_states ADD COLUMN e2ee_offered_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE voice_states ADD COLUMN e2ee_refused INTEGER NOT NULL DEFAULT 0;
