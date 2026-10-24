-- The deployment counter's identity for this server (src/usage.rs).
--
-- One row, minted on first report and never rotated: a random id sent to the
-- deployment collector with the daily "this server exists, it has N enabled
-- accounts" report. Random, not derived, so the collector cannot connect the
-- id to this server's name or its federation signing key; durable, so one
-- deployment is counted once no matter how often it restarts. A server with
-- usage.report = false never reads this table and the row is never written.
CREATE TABLE usage_identity (
    id TEXT NOT NULL
);
