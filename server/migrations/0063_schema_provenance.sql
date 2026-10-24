-- Who wrote this database, and how new was it when they did.
--
-- SQLite will open anything. That is normally its best quality and here it is
-- the whole problem: an operator who rolls a release back starts a binary that
-- knows migrations up to 0062 against a file whose rows were written by one
-- that knew 0064, and nothing anywhere says no. The old code then reads columns
-- that have changed meaning, writes rows that violate constraints it cannot see,
-- and -- the part that actually ruins a weekend -- does all of that
-- *successfully*, for hours, until somebody notices the damage and discovers it
-- is spread across every table touched since the rollback. Refusing to start is
-- recoverable. Partially operating is not.
--
-- sqlx already keeps `_sqlx_migrations`, and its `validate_applied_migrations`
-- already aborts when the database holds a migration version the binary does
-- not carry. That check is a genuine backstop and it stays. It is not enough on
-- its own for two reasons:
--
--   1. It can only say "version 57 was previously applied and I do not have
--      it". It cannot say which release wrote the database, when, or what the
--      operator should do next, because it does not know any of those things.
--      An operator reading that sentence at 3am learns that something is wrong
--      and nothing about what.
--
--   2. Not every incompatible release adds a migration. A release that changes
--      how a durable value is encoded, what a column's units are, or what a
--      default means can be perfectly schema-compatible and still be a database
--      an older binary must not touch. `_sqlx_migrations` cannot see that
--      difference; a recorded `state_format_version` can.
--
-- `state_format_version` is deliberately a number a release declares about
-- itself rather than a comparison of release strings. Comparing versions like
-- "0.4.2" and "0.4.10" to decide whether to refuse to boot would mean shipping a
-- semver policy nobody agreed to, and would refuse two builds of the same
-- release that differ only in a build tag. A release that has changed a durable
-- encoding *says so*, once, by bumping a constant; every release that has not
-- says nothing and rolls back freely. The number that appears in the refusal is
-- then a fact somebody wrote down on purpose, not an inference.
--
-- So this table is a high-water mark, deliberately separate from the migration
-- log and deliberately holding facts the migration log has no room for. One row,
-- forced by the CHECK, because "the newest thing that ever ran against this
-- file" is a single fact and a table that could hold two of them would need a
-- rule about which one wins -- a rule that would be read wrong exactly once, on
-- the night it mattered.
--
-- `migration_version` is a high-water mark rather than a current value: it is
-- raised on every forward run and never lowered. A binary that lowered it would
-- be erasing the evidence that a newer one had been here, which is precisely the
-- evidence the next start needs.
CREATE TABLE schema_provenance (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    -- The newest sqlx migration version that has ever been applied to this
    -- database by any binary.
    migration_version INTEGER NOT NULL,
    -- The durable-state format the newest binary here declared
    -- (`db::STATE_FORMAT_VERSION`). Raised by a release that changes what a
    -- durable value *means* without changing the schema that holds it. Also a
    -- high-water mark, for the same reason as the one above.
    state_format_version INTEGER NOT NULL,
    -- The `CARGO_PKG_VERSION` of the newest binary that has run migrations
    -- here. Informational, and important: it is the string the refusal message
    -- quotes back at the operator, and "this file was written by 0.7.1, you are
    -- running 0.6.4" is the sentence that ends the diagnosis. Nothing branches
    -- on it -- see the note about comparing release strings above.
    release_version   TEXT    NOT NULL,
    -- The wire protocol version that binary spoke
    -- (`telium_protocol::compat::PROTOCOL_VERSION`). Recorded here rather than
    -- inferred from the release string because the two move independently by
    -- design, and an operator diagnosing a federation problem after a rollback
    -- wants to know which one changed.
    protocol_version  INTEGER NOT NULL,
    applied_at        INTEGER NOT NULL
);

-- Seeded with a deliberately impossible release so that the first start after
-- this migration is the one that stamps the truth. Doing it here rather than
-- leaving the table empty means the row's existence is never itself a signal:
-- code that reads it handles "absent" only for databases older than this
-- migration, and every database this migration has touched has exactly one row.
INSERT INTO schema_provenance
    (id, migration_version, state_format_version, release_version, protocol_version, applied_at)
VALUES (1, 0, 0, 'unrecorded', 0, 0);
