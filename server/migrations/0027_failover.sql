-- Warm standby, the replication half (Section 10).
--
-- `failover` in 0002 recorded who the standby is and fenced promotion with a
-- monotonic sequence. It never carried any data there. These three tables are
-- how it gets some.

-- The primary's change log. Triggers generated at boot append one row per
-- write; a standby reads it in order and applies it. Logical rather than
-- physical on purpose: the pair replicates through the signed S2S transport
-- either side already speaks, so a standby is an ordinary peer rather than
-- something with filesystem access to the primary.
CREATE TABLE repl_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl TEXT NOT NULL,
    op  TEXT NOT NULL,           -- 'u' upsert, 'd' delete
    pk  TEXT NOT NULL,           -- json_array of the primary key's values
    row TEXT,                    -- json_object of the whole row; null on delete
    at  INTEGER NOT NULL
);
CREATE INDEX repl_log_at ON repl_log (at);

-- How far each standby has durably applied. The log is pruned below the
-- slowest one, so retention is a consequence of the standbys keeping up rather
-- than a number someone has to guess.
CREATE TABLE repl_ack (
    standby TEXT PRIMARY KEY,
    seq     INTEGER NOT NULL,
    at      INTEGER NOT NULL
);

-- The standby's own bookkeeping, one row per origin it mirrors. Deliberately
-- in the standby's *own* database rather than in the replica: the replica is a
-- copy of somebody else's server and is replaced wholesale on bootstrap, which
-- would take the cursor with it.
CREATE TABLE replica_state (
    origin      TEXT PRIMARY KEY,
    cursor      INTEGER NOT NULL DEFAULT 0,
    snapshot_at INTEGER,
    applied_at  INTEGER,
    -- Wall-clock of the newest change applied, which is what a client is told
    -- when it asks how far behind the copy it is reading actually is.
    lag_at      INTEGER,
    -- Media is content-addressed and synced by sweeping the replicated table
    -- rather than by trusting a watermark, so this is a rotating position
    -- rather than a high-water mark: it wraps, and finds anything that went
    -- missing on the second pass.
    media_cursor TEXT NOT NULL DEFAULT '',
    last_error  TEXT,
    promoted    INTEGER NOT NULL DEFAULT 0,
    sequence    INTEGER NOT NULL DEFAULT 0
);
