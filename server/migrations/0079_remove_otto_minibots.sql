-- Remove Otto and minibots.
--
-- Both features are gone from the server and the client. Otto was a built-in
-- moderation bot modelled on Dyno; minibots were guild automations drawn as
-- flows. This migration drops everything 0055 and 0056 created for them and
-- takes their in-process bot members out of every guild. Ordinary bots --
-- `bot_applications`, `bot_identities`, `bot_credentials`, installs, receipts,
-- the managed-role ceiling, the interaction contract of 0054 -- are untouched.
--
-- 0055 and 0056 are left as they are: a migration that has shipped is never
-- edited. What 0056 did to shared tables stays too, deliberately:
--
-- - The owner-integrity triggers it recreated on `bot_applications` differ
--   from 0049's only in skipping `local = 1` rows, and `local` is 0054's
--   column, part of the interaction contract rather than of Otto.
-- - The columns it added to `automod_rules` all have defaults and are ignored
--   by the AutoMod engine in `routes::moderation`. Dropping a column in SQLite
--   rebuilds the table, which is a lot of risk for no behaviour.

-- Triggers first: these fire on every message write and insert into a table
-- that is about to stop existing.
DROP TRIGGER IF EXISTS otto_message_cache_insert;
DROP TRIGGER IF EXISTS otto_message_cache_update;

DROP TABLE IF EXISTS otto_config;
DROP TABLE IF EXISTS otto_infractions;
DROP TABLE IF EXISTS otto_autoreply_cooldowns;
DROP TABLE IF EXISTS otto_ticket_panels;
DROP TABLE IF EXISTS otto_tickets;
DROP TABLE IF EXISTS otto_self_roles;
DROP TABLE IF EXISTS otto_announce_state;
DROP TABLE IF EXISTS otto_raid_state;
DROP TABLE IF EXISTS otto_message_cache;
DROP TABLE IF EXISTS otto_pending_components;

DROP TABLE IF EXISTS minibot_flows;
DROP TABLE IF EXISTS minibot_runs;
DROP TABLE IF EXISTS minibot_store;
DROP TABLE IF EXISTS minibot_applications;

-- The in-process bot members. Only Otto and the minibot runtime ever created a
-- `local = 1` application, so these are exactly their memberships. Each is
-- taken out the way `routes::bots::uninstall_bot` takes out an ordinary bot:
-- the member, its role assignments, its managed role, and the channel
-- overwrites naming either.
CREATE TEMP TABLE doomed_bot_members AS
SELECT m.guild_id, m.user_id, m.bot_role_id AS role_id,
       (SELECT r.position FROM roles r
         WHERE r.id = m.bot_role_id AND r.guild_id = m.guild_id) AS position
  FROM members m
  JOIN bot_applications a ON a.id = m.bot_application_id
 WHERE a.local = 1;

DELETE FROM channel_overwrites
 WHERE (target_type = 'role'
        AND target_id IN (SELECT role_id FROM doomed_bot_members WHERE role_id IS NOT NULL))
    OR (target_type = 'member'
        AND target_id IN (SELECT user_id FROM doomed_bot_members));

DELETE FROM member_roles
 WHERE role_id IN (SELECT role_id FROM doomed_bot_members WHERE role_id IS NOT NULL);

DELETE FROM member_roles
 WHERE EXISTS (SELECT 1 FROM doomed_bot_members d
                WHERE d.guild_id = member_roles.guild_id
                  AND d.user_id = member_roles.user_id);

DELETE FROM members
 WHERE EXISTS (SELECT 1 FROM doomed_bot_members d
                WHERE d.guild_id = members.guild_id
                  AND d.user_id = members.user_id);

DELETE FROM roles
 WHERE EXISTS (SELECT 1 FROM doomed_bot_members d
                WHERE d.guild_id = roles.guild_id
                  AND d.role_id = roles.id);

-- Close the gaps the managed roles leave in each guild's role order.
UPDATE roles
   SET position = position - (
        SELECT COUNT(*) FROM doomed_bot_members d
         WHERE d.guild_id = roles.guild_id
           AND d.position IS NOT NULL
           AND d.position < roles.position)
 WHERE guild_id IN (SELECT guild_id FROM doomed_bot_members);

DROP TABLE doomed_bot_members;

-- Deleting those members queued an "uninstalled" receipt for each one. The
-- application is this server's own and there is nobody to deliver it to.
DELETE FROM bot_receipt_outbox
 WHERE application_id IN (SELECT id FROM bot_applications WHERE local = 1);

DELETE FROM bot_guild_sessions
 WHERE application_id IN (SELECT id FROM bot_applications WHERE local = 1);

-- The applications and identities themselves are kept, disabled, so that the
-- messages Otto and the minibots already posted keep rendering with a name and
-- a BOT badge instead of as an unknown author.
UPDATE bot_identities
   SET disabled = 1
 WHERE application_id IN (SELECT id FROM bot_applications WHERE local = 1);
