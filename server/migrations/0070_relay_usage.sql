-- Persisted bandwidth accounting for the protected guild transport
-- (docs/network-privacy.md).
--
-- The relay's real limit is not how many tunnels an account may hold at once --
-- that is bounded in memory and is cheap to get right -- but how many bytes it
-- may move through this server in a day. That number is the operator's bill,
-- and it is the one limit that must not reset when the process does.
--
-- In-memory would have been half a screen of code and wrong for a specific,
-- predictable reason: a byte budget that lives in a process resets on every
-- deploy, every crash and every restart, and those are not rare events
-- distributed evenly through the week. They cluster exactly where an operator
-- is least able to watch. An account that has spent its day's allowance gets it
-- back the moment somebody ships a patch, and "the limit holds unless you
-- restart" is not a limit an operator can plan capacity against.
--
-- # Why a bucket table and not a ledger
--
-- The obvious shape is one row per tunnel with its byte count, summed over the
-- last 24 hours at every open. That is a ledger, and a ledger of every tunnel
-- every account ever opened is exactly the minute-by-minute map of who talks to
-- which server that `relay.log_destinations = false` exists to avoid keeping.
-- Writing it into the database by default would mean the privacy default was a
-- log setting while the durable copy was kept regardless, which is worse than
-- not claiming the default at all.
--
-- So this stores buckets, not events: one row per account per UTC hour, holding
-- a byte total and a tunnel count. Twenty-four rows per active account, no
-- destination, no timing finer than an hour, no way to reconstruct a session.
-- It answers the only question the limiter asks -- "how much has this account
-- moved since this time yesterday" -- with `SUM(bytes) WHERE user_id = ? AND
-- hour > ?`, and it answers nothing else.
--
-- `hour` is an integer count of whole hours since the epoch rather than a
-- timestamp string, because the rolling window is arithmetic on it (`now/3600 -
-- 24`) and because it makes the primary key a pair of integers, which is the
-- cheapest thing SQLite can index.
--
-- # Why the counters are updated as the tunnel runs, not when it ends
--
-- A tunnel that is open for six hours moving data the whole time would, if it
-- only reported at close, spend six hours invisible to the budget -- and a
-- client wanting to evade the limit would simply never close one. The relay
-- therefore flushes into the current hour's bucket periodically while the
-- tunnel is alive, which is why `bytes` is added to rather than set, and why
-- the upsert below is the only write shape this table has.
--
-- `tunnels` counts opens, not concurrency: it is there so an operator reading
-- the table can see whether a big number came from one large transfer or ten
-- thousand small ones, which is the difference between a person watching a
-- video and something going wrong.

CREATE TABLE relay_usage (
    user_id TEXT NOT NULL,
    -- Whole hours since the Unix epoch, UTC. See the header for why this is not
    -- a timestamp.
    hour    INTEGER NOT NULL,
    -- Bytes carried in both directions, summed. Both directions together
    -- because both directions cost the operator the same money.
    bytes   INTEGER NOT NULL DEFAULT 0,
    -- Tunnels opened in this hour. Opens, not concurrent holders.
    tunnels INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, hour)
) WITHOUT ROWID;

-- The sweep that discards buckets older than the rolling window asks only about
-- `hour`, across every account, and would otherwise scan the whole table. It
-- runs on a timer rather than on the request path, but it runs on a table whose
-- size is (active accounts x 24) and there is no reason to make it quadratic.
CREATE INDEX relay_usage_hour ON relay_usage (hour);
