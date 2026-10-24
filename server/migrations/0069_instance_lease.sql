-- One row naming the process that is currently the authority for this database.
--
-- Telium's server is a single-writer design in more places than the database:
-- the rate limiter counts in process memory, the gateway's subscriber map is a
-- HashMap, and `routes::voice::mark_unclaimed` runs at boot on the stated
-- assumption that every voice state in the table was left by a process that is
-- gone. A second process against the same file does not fail loudly; it
-- silently doubles every quota, delivers events to half the clients, and --
-- the worst of them -- hangs up on the first process's live calls as it starts.
--
-- So there is a lease, and it is one row. `id` is pinned to 1 by the CHECK so
-- the table can never hold two.
CREATE TABLE IF NOT EXISTS instance_lease (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id    TEXT    NOT NULL,
    hostname       TEXT    NOT NULL,
    pid            INTEGER NOT NULL,
    -- Wall-clock milliseconds, refreshed on a timer. Staleness is how a lease
    -- left behind by a process that was killed with SIGKILL is reclaimed.
    heartbeat_ms   INTEGER NOT NULL,
    started_at_ms  INTEGER NOT NULL,
    -- The build that holds it, so the refusal message can tell an operator
    -- whether the other process is the one they thought they were replacing.
    version        TEXT    NOT NULL
);
