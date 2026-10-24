-- The home server's registry of where an account is a member elsewhere.
--
-- A guild's member list is the guild server's; the home keeps this so a move
-- can re-establish every membership from a record it holds, rather than from
-- whatever rows happened to be local. Rows arrive from the guild server's
-- signed notice (reported_by = 'guild', proof = the notice) or from a client
-- reporting what a guild server's READY listed (reported_by = 'client').
CREATE TABLE remote_memberships (
    user_id      TEXT NOT NULL,
    guild_server TEXT NOT NULL,
    guild_id     TEXT NOT NULL,
    joined_at    INTEGER NOT NULL,
    proof        TEXT,
    reported_by  TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_server, guild_id)
);

-- On the destination: one row per guild server the moved account had
-- memberships on, retried with backoff until that server has rewritten them
-- under the new id or the attempts run out.
CREATE TABLE membership_moves (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,           -- the new id, here
    old_id          TEXT NOT NULL,           -- the id the guild server knows
    guild_server    TEXT NOT NULL,
    state           TEXT NOT NULL,           -- pending | done | failed
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    completed_at    INTEGER,
    UNIQUE (user_id, guild_server)
);
CREATE INDEX membership_moves_due ON membership_moves (state, next_attempt_at);
