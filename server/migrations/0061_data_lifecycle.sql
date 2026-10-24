-- Data lifecycle: making deletion a process rather than a single statement,
-- and making it resumable (docs/data-lifecycle.md).
--
-- The problem this table exists to solve is an ordering one, and it is not
-- obvious until you try to write the deletion as one transaction and find that
-- you cannot.
--
-- Deleting an account has to tell the guild servers the account was a member
-- of that it is gone. The list of those servers *is* `remote_memberships`,
-- which is itself data about the deleted person that must not survive them.
-- So the erasure has to keep that table until the notices are queued and
-- remove it afterwards -- and "afterwards" is a word that means nothing inside
-- a transaction. Worse, the notices are queued after the deletion commits, on
-- purpose: `revocation::announce` documents that a notice about a revocation
-- that then rolled back would sign people out for nothing.
--
-- That leaves a window. Between the deletion committing and the residue being
-- swept, the process can be killed, the box can lose power, or the operator
-- can deploy. Before this table, nothing anywhere recorded that a deletion was
-- half-finished: the account looked deleted, the user was told it was deleted,
-- and a dozen tables quietly kept their rows forever with nothing left that
-- knew to come back for them. That is the worst possible shape for a privacy
-- operation -- it fails silently, and it fails in the direction of keeping
-- data.
--
-- So the deletion writes a row here, in the same transaction that flips the
-- account, and a worker on the maintenance loop drives it the rest of the way.
-- A crash at any point leaves a row saying exactly how far it got; the next
-- tick picks it up. The row is the only thing that is allowed to say a
-- deletion finished.
CREATE TABLE account_erasures (
    user_id      TEXT PRIMARY KEY,
    requested_at INTEGER NOT NULL,
    -- residue -> media -> finished. Stages are ordered and a stage is only
    -- advanced once its own work has committed, so re-running a stage is
    -- always safe and never necessary to reason about: every statement in
    -- every stage is a DELETE by key, which is idempotent by construction.
    stage        TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    next_at      INTEGER NOT NULL,
    last_error   TEXT,
    -- What the erasure actually removed, which is the part an operator will be
    -- asked about later. Counts only: naming the rows would make this journal
    -- a copy of the thing it just deleted.
    rows_erased  INTEGER NOT NULL DEFAULT 0,
    blobs_erased INTEGER NOT NULL DEFAULT 0,
    finished_at  INTEGER
);
CREATE INDEX account_erasures_due ON account_erasures (stage, next_at);
