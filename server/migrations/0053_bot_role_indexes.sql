-- Index the two bot columns that are read by something other than their own
-- table's key.
--
-- 0049 gave `members` five bot columns and one index, `members_bot_application`,
-- which leads with `guild_id`. That is the right shape for every question asked
-- about one guild's bots, and the wrong shape for the two questions that are
-- not asked about a guild at all.
--
-- The first is `bot_role_id`. Both receipt triggers on `roles` find the member
-- whose managed role has just changed with `WHERE m.bot_role_id = NEW.id`, and
-- they fire on every role insert and on every permissions update anywhere on
-- the server -- so editing one role in one guild scanned every membership row
-- in the database, once per statement, on a table that grows with the product.
-- The same lookup runs as a correlated subquery inside `guildstore::roles_json`
-- (the `managed` flag on each role), which is on the path that builds every
-- client's READY payload: without an index that is one guild-wide member scan
-- per role, per connect. Indexed on `(bot_role_id, guild_id)` because the
-- triggers have only the role id to go on, while `roles_json` and the guild
-- routes have the guild as well and can use the second column to finish the
-- lookup inside the index.
--
-- The second is a bot's membership found by user rather than by guild: the
-- gateway's identify check, the install/uninstall bookkeeping and the
-- session-teardown count all ask `WHERE user_id = ? AND bot_application_id = ?`,
-- and `members` has no index leading with `user_id` at all, so each of those
-- was a full scan too.
--
-- Both are partial. Nearly every row in `members` is a person, whose bot
-- columns are null, and an index over all of them would charge every ordinary
-- join, leave and profile edit for entries no bot query can ever match. Every
-- query above constrains the column with `=`, which implies `IS NOT NULL`, so
-- SQLite can still use these; what it cannot do is put a person in them.

CREATE INDEX members_bot_role
    ON members (bot_role_id, guild_id)
 WHERE bot_role_id IS NOT NULL;

CREATE INDEX members_bot_by_user
    ON members (user_id, bot_application_id)
 WHERE bot_application_id IS NOT NULL;
