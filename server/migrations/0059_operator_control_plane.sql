-- The operator control plane (docs/operator-guide.md).
--
-- Three pieces: a record of what administrators did, a short elevation window
-- that destructive administrator routes demand before they will act, and the
-- provenance of an operator-imposed suspension.

-- ---------------------------------------------------------------- audit trail

-- Server-administrator actions.
--
-- The interesting decision here is that this is *not* `audit_log`, which
-- already exists and already records moderator actions. Adding a nullable
-- `guild_id` to that table would have been less SQL and would have been wrong,
-- for three reasons, in increasing order of how much they matter.
--
-- The shapes disagree. `audit_log.guild_id` is `NOT NULL` and its only index is
-- `(guild_id, id DESC)`, because every question anyone asks of it starts with
-- "in this guild". A server action has no guild, so it would sit outside every
-- index the table has and be found by a scan.
--
-- The readers disagree. `audit_log` is readable by anyone in the guild holding
-- `VIEW_AUDIT_LOG` -- a permission a guild owner grants to their own
-- moderators, who are not this server's operators and frequently do not know
-- them. Sharing a table would make "server actions are not visible to guild
-- moderators" a property of a `WHERE` clause. One missing predicate anywhere in
-- the codebase would then publish the operator's decisions to every moderator
-- on the box, and a boundary that survives only as long as every query
-- remembers it is not a boundary.
--
-- And the lifetimes disagree, which is the one that settles it. `erase_guild`
-- -- reached from `POST /_telium/v1/admin/guilds/{id}/purge` -- runs
-- `DELETE FROM audit_log WHERE guild_id = ?`. An administrator purging a guild
-- would therefore delete the record of every administrator action ever taken
-- against that guild, including the purge itself, as part of performing it. An
-- audit record that the audited action erases is not an audit record; it is a
-- confession the subject gets to shred. Its own table is how that stops being
-- possible by construction rather than by everyone remembering.
--
-- Not excluded from replication: an audit trail that a failover loses is an
-- audit trail with a gap exactly where the interesting week was.
CREATE TABLE server_audit_log (
    id         TEXT PRIMARY KEY,            -- ulid(); sorts by time, so `id DESC` is `created_at DESC`
    actor      TEXT NOT NULL,               -- the administrator's user_id
    action     TEXT NOT NULL,               -- dotted: account.suspend, federation.defederate, ...
    target     TEXT,                        -- what it was done to, if anything
    data       TEXT NOT NULL DEFAULT '{}',  -- JSON: the arguments, and the outcome
    created_at INTEGER NOT NULL
);

-- `id DESC` alone answers the unfiltered page, which is the common read.
CREATE INDEX server_audit_recent ON server_audit_log (id DESC);
-- The two filters the console offers. Both are (filter, id DESC) so a filtered
-- page is also served from an index rather than from a scan plus a sort.
CREATE INDEX server_audit_action ON server_audit_log (action, id DESC);
CREATE INDEX server_audit_actor ON server_audit_log (actor, id DESC);

-- -------------------------------------------------------------- step-up grant

-- A live re-authentication, valid for minutes.
--
-- Holding a session is proof that somebody signed in as this account at some
-- point. Destructive operator work needs the stronger claim that the person at
-- the keyboard right now is that account, which is what re-authentication
-- establishes and a bearer token cannot. So the grant is a row rather than a
-- claim in a token: revoking it has to be possible from the server's side, and
-- it has to survive nothing -- not a restart, not a promotion, not a copy of
-- the client's local storage.
--
-- One row per administrator rather than one per action, deliberately. An
-- operator defederating a domain usually also removes a feed entry and resolves
-- two reports in the same sitting, and demanding a password four times in two
-- minutes does not buy four times the assurance -- it buys an operator who
-- types their password without reading what it is for, which is strictly worse
-- than the short window. `sudo` reached this conclusion in 1980 and has not had
-- cause to revisit it.
CREATE TABLE admin_step_up (
    user_id    TEXT PRIMARY KEY,
    granted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

-- ------------------------------------------------------------ suspension mark

-- Who suspended this account, when, and why.
--
-- `accounts.deactivated` already existed and was doing two jobs: "the owner
-- turned this account off" and "the operator turned this account off". They
-- look identical in the column and are not remotely the same fact, and the
-- difference is load-bearing in one specific place -- `login_finish` lets a
-- deactivated account sign back in and clear the flag when it passes
-- `reactivate: true`, which is exactly right for an owner undoing their own
-- decision and exactly wrong for a suspended account undoing the operator's.
-- Without these columns, "suspend this account" would be a button the suspended
-- person can press back.
--
-- So `suspended_at` is the operator's half of the flag. `deactivated` stays the
-- single thing every enforcement path reads -- there is no second gate to keep
-- in sync and no route that could forget the new one -- and `suspended_at`
-- says whose decision it was, which is what self-reactivation now checks.
ALTER TABLE accounts ADD COLUMN suspended_at INTEGER;
ALTER TABLE accounts ADD COLUMN suspended_by TEXT;
ALTER TABLE accounts ADD COLUMN suspension_reason TEXT;
