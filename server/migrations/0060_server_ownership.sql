-- Server-administrator ownership: who holds the server, how that changes
-- hands, and how a server that has lost its only owner gets one back.
-- (docs/server-ownership.md)
--
-- The `admin` column on `accounts` has existed since 0001 and is still the
-- whole of the authority. Nothing here replaces it. What it never had was a
-- history -- who granted it, when, on whose say-so -- and no answer at all to
-- the question that ends a server: the one person holding the column lost
-- their password.

-- ---------------------------------------------------------- the audit trail
--
-- `server_audit_log` is not created here. It is the operator control plane's,
-- created in 0059, and this migration depends on it already existing -- which
-- it does, because 0059 sorts before 0060 and sqlx runs migrations in order.
--
-- Named rather than passed over in silence, because the next person to read
-- this file will look for the table the grant and revoke handlers write to and
-- ought to find out where it is in one line rather than by grepping the
-- migrations directory. 0059 also carries the argument for why the table has
-- to exist at all rather than being a nullable `guild_id` on the guild
-- `audit_log`; the short version, which is the part that settles it, is that
-- purging a guild deletes that guild's audit rows, so an administrator action
-- recorded there would be erased by the very administrator action it records.
--
-- What is this migration's to say about that table: grants and revocations of
-- server-administrator authority are written to it and nowhere else. They are
-- the most consequential rows it will ever hold, because every other operator
-- action in it is something an administrator did, and these are the rows that
-- say who the administrators were. Anything that later prunes this table --
-- and `[retention]` is where somebody will reach for that -- has to treat
-- `ownership.*` actions as the entries it must not drop first.

-- ------------------------------------------------------- provenance of a grant
--
-- When this account became an administrator, and who made it one.
--
-- The honest objection to these two columns is that the audit log already
-- records every grant, so they are derived data and derived data goes stale.
-- Three things answer it.
--
-- The audit log is prunable and these are not. An operator running a server for
-- five years will eventually trim a table that grows without bound, and the
-- entry they are least likely to think of as load-bearing is the six-year-old
-- row that says how the founder became the founder. The roster must not depend
-- on a table anyone is entitled to prune.
--
-- The audit log does not go back far enough by construction. Every server that
-- existed before this migration has administrators and no grant rows for them,
-- because the rows were never written. A roster that reconstructs provenance
-- from the log would show "unknown" for exactly the accounts that matter most
-- on exactly the servers that have been running longest. Backfilling these
-- columns as NULL says "before we started recording", which is true, rather
-- than implying a gap in a log that is otherwise complete.
--
-- And the roster is read on every visit to the ownership screen, where the
-- alternative is a correlated subquery over an unbounded text table per row,
-- parsing JSON, to answer a question two integers already hold.
--
-- NULL `admin_since` means "already an administrator when this migration ran,
-- or made one by the bootstrap rule". NULL `admin_granted_by` with a non-NULL
-- `admin_since` means nobody granted it -- the recovery path, or the first
-- account on a fresh server, both of which name themselves in the audit log.
ALTER TABLE accounts ADD COLUMN admin_since INTEGER;
ALTER TABLE accounts ADD COLUMN admin_granted_by TEXT;

-- -------------------------------------------------------- the recovery claim
--
-- A request, made from a shell on the server's own machine, that a named
-- account be given server-administrator authority.
--
-- This is the dangerous one, and it is worth being precise about what it is and
-- what it deliberately is not.
--
-- It is NOT account recovery. It never resets a password, never mints a
-- session, never touches `opaque_record`, `password_hash`, the account's
-- `recovery_addresses` row or any other credential or route back to one, and
-- it cannot be pointed at an account the claimant does not already control --
-- or rather, it can be, and doing so gains them nothing, because the account
-- still requires its own credential to sign in.
-- The claim grants *authority over the server* to an account; it grants no
-- access at all *to* that account. An operator who has lost their password
-- recovers by registering or using a second account and nominating that one.
-- Their old account stays locked, its messages stay unread, its identity stays
-- theirs. That separation is the entire safety argument: the mechanism that
-- returns a server to its owner is structurally incapable of impersonating
-- anybody, because it never produces a credential.
--
-- It also grants nothing that the claimant did not already have. Creating a row
-- here requires opening this database file for writing, and anyone who can do
-- that can equally run `UPDATE accounts SET admin = 1` in sqlite3 and skip
-- every check below. The trust boundary is the host filesystem, and it was the
-- host filesystem before this table existed; whoever holds the disk holds the
-- server, holds every message on it, and holds the federation signing key in
-- `server_keys`. Nothing in software changes that. What this table buys is that
-- the supported path is *loud*: it announces itself to every administrator, it
-- writes an audit row, it waits, and it shows up on the ownership screen while
-- it waits. The sqlite3 path is silent. Making the legitimate route the
-- convenient one is how the silent route stops being the only route anyone
-- reaches for.
--
-- `effective_at` is where the proportionality lives, and it is the one piece of
-- real judgement in this table. If the server currently has no usable
-- administrator, the claim is effective immediately: there is nobody to harm,
-- nobody who could object, and nobody who could cancel it, so a delay would
-- protect no one and would strand a genuinely ownerless server for another day.
-- If the server *does* have a usable administrator, then this is not a recovery
-- -- a working administrator could have granted the same authority over the API
-- in ten seconds -- and the claim waits out `ownership.recovery_delay_secs`
-- while every administrator is told about it and any of them can cancel it with
-- one call. The cost to the honest operator in that case is zero, because the
-- honest operator had a better route. The cost to someone seizing a running
-- server is a day of warning to the people who can stop them.
--
-- `host_evidence` records what the tool actually checked before believing the
-- claimant had the machine, so the audit entry says more than "somebody
-- asserted they had the disk".
CREATE TABLE admin_recovery_claims (
    id            TEXT PRIMARY KEY,         -- ulid()
    subject       TEXT NOT NULL,            -- the account that would gain the column
    reason        TEXT NOT NULL,            -- typed by the operator; goes into the alert verbatim
    host_evidence TEXT NOT NULL,            -- JSON: what proved filesystem access, and to whom
    requested_at  INTEGER NOT NULL,
    effective_at  INTEGER NOT NULL,         -- == requested_at when the server had no usable admin
    applied_at    INTEGER,                  -- set when the grant actually landed
    cancelled_at  INTEGER,
    cancelled_by  TEXT,                     -- the administrator who stopped it
    announced_at  INTEGER                   -- when the alerts went out; NULL means they have not
);

-- The only query the applier runs: claims that are neither applied nor
-- cancelled, oldest first. Partial, because a server that has been running for
-- years accumulates settled claims and the applier should never look at one.
CREATE INDEX admin_recovery_pending ON admin_recovery_claims (effective_at)
    WHERE applied_at IS NULL AND cancelled_at IS NULL;
-- "Has anyone ever tried this against my account" -- asked after the fact, by a
-- displaced administrator reading the ownership screen.
CREATE INDEX admin_recovery_subject ON admin_recovery_claims (subject, requested_at DESC);
