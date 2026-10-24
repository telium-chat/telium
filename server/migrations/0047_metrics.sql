-- Operator metrics: the history behind the control plane's charts.
--
-- One row per rollup interval, written by the worker in `metrics.rs` from
-- counters that live in memory as atomics for the rest of the time. There is
-- deliberately no row per request, per message or per peer: an instrumentation
-- layer that writes as often as the thing it instruments is not measuring the
-- load, it is the load.
--
-- Every column is an aggregate over events. None of them has a user id, a
-- conversation id, a channel id or a peer account in it, and nothing here is
-- derived from a message body. A homeserver could answer far more interesting
-- questions than these and a dashboard is exactly where somebody talks
-- themselves into asking one, so the restraint is written into the schema
-- rather than left to the good judgement of whoever adds the next column.
--
-- The counter columns are NOT NULL because a counter that exists has a delta
-- even when that delta is zero: zero requests in a minute is a fact about a
-- quiet server. The gauge columns are nullable because they are *samples*, and
-- a sample that was not taken is not a zero. `media_bytes` is NULL in every
-- bucket between two storage samples, and the client draws a gap there rather
-- than a flat line through time nobody measured.
CREATE TABLE metrics_rollup (
    -- Start of the window, epoch ms, aligned down to the interval.
    bucket_start                INTEGER PRIMARY KEY,
    window_ms                   INTEGER NOT NULL,
    -- How much of the window this process was actually up for. A server that
    -- started forty seconds into a sixty-second bucket contributes a real
    -- measurement of forty seconds, and a rate computed against the full window
    -- would under-report it by a third. The first bucket after every restart is
    -- partial, which is also the first bucket after every crash -- the one an
    -- operator is most likely to be staring at.
    covered_ms                  INTEGER NOT NULL,

    -- ------------------------------------------------------------- counters
    requests                    INTEGER NOT NULL DEFAULT 0,
    -- Split by who is calling rather than by what they asked for: a peer's
    -- signed request and a browser's session request fail differently and are
    -- worth telling apart during an incident.
    requests_federation         INTEGER NOT NULL DEFAULT 0,
    responses_4xx               INTEGER NOT NULL DEFAULT 0,
    responses_5xx               INTEGER NOT NULL DEFAULT 0,
    -- Bytes the server declared, not bytes the socket moved. A response with no
    -- Content-Length -- a stream, a proxied playback -- is counted in
    -- `bytes_out_unmeasured` as one response rather than guessed at, so the
    -- bandwidth figure is a floor with a stated number of omissions instead of
    -- an estimate with none.
    bytes_in                    INTEGER NOT NULL DEFAULT 0,
    bytes_out                   INTEGER NOT NULL DEFAULT 0,
    bytes_out_unmeasured        INTEGER NOT NULL DEFAULT 0,
    -- The latency histogram for the window, as a JSON array of bucket counts
    -- against the bounds in `metrics.rs`. The histogram is stored rather than
    -- three percentiles because percentiles do not add up: a p99 of a day
    -- cannot be recovered from the p99s of its minutes, and a chart that
    -- averages them is drawing a number that was never true. Fifteen small
    -- integers per row buys an exact percentile over any range the reader asks
    -- for.
    latency_hist                TEXT NOT NULL DEFAULT '[]',
    gateway_events_out          INTEGER NOT NULL DEFAULT 0,
    gateway_frames_in           INTEGER NOT NULL DEFAULT 0,
    -- Messages accepted, by transport. Counts only: no author, no destination,
    -- no size distribution that could stand in for one.
    messages_guild              INTEGER NOT NULL DEFAULT 0,
    messages_dm                 INTEGER NOT NULL DEFAULT 0,
    media_uploads               INTEGER NOT NULL DEFAULT 0,
    media_upload_bytes          INTEGER NOT NULL DEFAULT 0,
    federation_deliveries       INTEGER NOT NULL DEFAULT 0,
    federation_delivery_failures INTEGER NOT NULL DEFAULT 0,

    -- --------------------------------------------------------------- gauges
    gateway_connections         INTEGER,
    -- Distinct accounts with at least one live connection. A count, never a
    -- list: "how many people are on" is an operational fact and "who" is not
    -- this table's business.
    accounts_connected          INTEGER,
    db_bytes                    INTEGER,
    media_objects               INTEGER,
    media_bytes                 INTEGER,
    media_cache_bytes           INTEGER,
    cold_bytes                  INTEGER,
    -- Outbound federation that has not landed yet, and how long the oldest
    -- piece of it has been waiting. Depth alone cannot tell a busy minute from
    -- a peer that stopped answering an hour ago; the age can.
    federation_backlog          INTEGER,
    federation_backlog_oldest_ms INTEGER,
    federation_peers            INTEGER,
    federation_peers_failing    INTEGER,
    reports_open                INTEGER,
    pool_connections            INTEGER,
    pool_idle                   INTEGER
);

-- The only two access patterns are "the last N hours" and "delete everything
-- older than the retention window", and the primary key serves both.

-- What a resolved report cost in wall-clock time, which is the one moderation
-- number that says whether the queue is being worked or merely accumulating.
-- Held on the report rather than in a counter because it is answerable by
-- arithmetic on rows that already exist -- `handled_at - created_at` -- and a
-- second copy of a derivable fact is a second thing to get wrong.
CREATE INDEX idx_reports_handled ON reports (status, handled_at);

-- The outcome, in the moderator's own words.
--
-- `status` already says what was decided and `handled_by` says who decided it,
-- and between them they cannot say why. A queue where every closed item reads
-- "rejected" and nothing else teaches the next person on the rota nothing, and
-- the same reporter filing the same thing next month gets the same fresh look.
-- Optional, because forcing a sentence out of somebody clearing a duplicate is
-- how you get a column full of "dupe".
ALTER TABLE reports ADD COLUMN resolution_note TEXT;
