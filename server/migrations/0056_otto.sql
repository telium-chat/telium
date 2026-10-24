-- Otto: the homeserver's own moderation and automation application.
--
-- Every hosted moderation bot people actually use is insecure in the same way,
-- and it is not a coding mistake: it is an architecture. The bot runs as a
-- privileged process the guild cannot inspect, it is granted Administrator
-- because that is the only setting that makes all of its features work, and
-- from then on "what can this bot do" and "what did the guild agree to" are two
-- different questions with no mechanism connecting them. Otto exists to make
-- those the same question, so the shape of this migration is chosen around one
-- constraint: **Otto must be an ordinary bot member, with an ordinary managed
-- role, and therefore an ordinary permission ceiling.**
--
-- That is why there is no `otto_permissions` table here, and why there must
-- never be one. Otto's authority in a guild lives in exactly the rows a
-- third-party bot's authority lives in -- `members.bot_application_id`,
-- `members.bot_role_id`, and the `roles` row that the second of those names --
-- so `guildstore::bot_permission_ceiling` caps Otto without knowing Otto
-- exists, `perms::apply_ceiling` intersects every check against that cap, the
-- BOT badge renders, the audit log attributes, and a guild migration bundle
-- carries Otto's membership because it carries every membership. Running
-- in-process buys Otto latency and zero setup. It buys it no authority.
--
-- What this migration adds, then, is only *configuration*: what an admin has
-- asked Otto to watch for and what to do about it. None of it grants anything.
-- Every row here is an instruction that is re-checked against the ceiling at
-- the moment it fires, and checked a second time -- against the configuring
-- admin's own permissions -- at the moment it is saved, so that an admin cannot
-- use Otto as a ladder to authority they do not personally hold.

-- ---------------------------------------------------------------------------
-- The local application flag
-- ---------------------------------------------------------------------------

-- A local application runs inside this process instead of behind a federated
-- bot connection. It is otherwise an ordinary `bot_applications` row, and that
-- is deliberate: the alternative -- a parallel `local_applications` table --
-- would mean every join that resolves a bot identity, every permission path,
-- every audit attribution and every migration bundle growing a second case to
-- handle, and a second case is exactly where the exemption people are worried
-- about would eventually be written.
--
-- Two things genuinely differ, and both are absences rather than additions.
-- A local application has no owner account: it belongs to the homeserver, so
-- `owner_user_id` is the empty string and the owner-integrity triggers below
-- learn to skip it. And a local application has no row in `bot_credentials`:
-- there is no long-lived token because there is no socket to present one on,
-- which removes the single most valuable thing an attacker could steal from a
-- hosted moderation bot. Otto cannot be phished, because Otto has no secret.
--
-- The `local` column itself is added by 0054, which owns the interactivity
-- contract and needs the same flag to decide whether an interaction is
-- dispatched in-process or over a socket. It is deliberately not re-added here:
-- one flag, one definition, one meaning. What 0054 did not do -- because it had
-- no local application to insert yet -- is teach the owner-integrity triggers
-- that a local row has no owner, and that is what follows.

-- The owner-integrity triggers from 0049 assume every application has a human
-- behind it: one refuses an application whose owner is deleted or missing, and
-- one refuses an application created while its owner's account is migrating
-- away. Both are right for a developer's bot and both are meaningless for a
-- local one, which has no owner to delete and no account to migrate. They are
-- recreated rather than dropped because a local application must not become a
-- hole in a rule that still protects every other row in the table.
DROP TRIGGER bot_application_requires_undeleted_owner;
CREATE TRIGGER bot_application_requires_undeleted_owner
BEFORE INSERT ON bot_applications
WHEN NEW.local = 0
 AND NOT EXISTS (
    SELECT 1 FROM accounts
     WHERE user_id = NEW.owner_user_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'bot application owner is deleted or missing');
END;

DROP TRIGGER bot_application_blocks_account_migration;
CREATE TRIGGER bot_application_blocks_account_migration
BEFORE INSERT ON bot_applications
WHEN NEW.local = 0
 AND EXISTS (
    SELECT 1 FROM migrations
     WHERE subject_type = 'user'
       AND subject_id = NEW.owner_user_id
       AND state IN ('pending', 'ready')
)
BEGIN
    SELECT RAISE(ABORT, 'account migration is already in flight');
END;

-- The mirror image: a person retiring or moving their account is blocked by the
-- applications they own. A local application is owned by nobody, so it must not
-- be counted against any account -- otherwise the first guild to install Otto
-- would freeze account deletion for whichever user id happened to match.
DROP TRIGGER account_migration_blocks_active_bot_applications;
CREATE TRIGGER account_migration_blocks_active_bot_applications
BEFORE INSERT ON migrations
WHEN NEW.subject_type = 'user'
 AND EXISTS (
    SELECT 1
      FROM bot_applications a
      JOIN bot_identities b ON b.application_id = a.id
     WHERE a.owner_user_id = NEW.subject_id
       AND a.local = 0
       AND b.disabled = 0
 )
BEGIN
    SELECT RAISE(ABORT, 'retire active bot applications before migrating the account');
END;

DROP TRIGGER account_delete_blocks_active_bot_applications;
CREATE TRIGGER account_delete_blocks_active_bot_applications
BEFORE UPDATE OF deleted_at ON accounts
WHEN NEW.deleted_at IS NOT NULL
 AND OLD.deleted_at IS NULL
 AND EXISTS (
    SELECT 1
      FROM bot_applications a
      JOIN bot_identities b ON b.application_id = a.id
     WHERE a.owner_user_id = OLD.user_id
       AND a.local = 0
       AND b.disabled = 0
 )
BEGIN
    SELECT RAISE(ABORT, 'retire active bot applications before deleting the account');
END;

-- ---------------------------------------------------------------------------
-- Per-guild module configuration
-- ---------------------------------------------------------------------------

-- One row per (guild, module). Every module is off until somebody with
-- MANAGE_GUILD turns it on, including in a guild that has had AutoMod rules for
-- a year -- see the automod backfill at the bottom, which turns that one module
-- on for exactly the guilds that were already using it and nobody else.
--
-- `config` is JSON rather than columns, and that is a considered trade rather
-- than laziness. Nine modules with unrelated settings would otherwise be nine
-- tables with one row each, nine migrations every time a module grows a knob,
-- and nine more entries in the guild migration bundle. The cost of JSON is that
-- SQLite will not validate it; the answer to that is that nothing reads this
-- column except a typed deserializer that supplies a default for every field,
-- so a config written by a newer server and read by an older one degrades to
-- defaults instead of failing.
--
-- `updated_by` is not decoration. It is half of the answer to "why did Otto do
-- this to me": the audit entry Otto writes names the rule, and the rule's row
-- names the admin who saved it.
CREATE TABLE otto_config (
    guild_id   TEXT NOT NULL,
    module     TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 0,
    config     TEXT NOT NULL DEFAULT '{}',
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, module)
);

-- ---------------------------------------------------------------------------
-- AutoMod, absorbed
-- ---------------------------------------------------------------------------

-- `automod_rules` is extended in place rather than replaced by an `otto_rules`
-- table, and this is the single most important decision in the migration.
--
-- A copy-then-drop would have been tidier to read and worse in every way that
-- matters. The rule ids are referenced by `automod_hits.rule_id`, so new ids
-- would orphan every hit a guild has ever recorded -- the evidence trail a
-- moderator uses to justify a ban. The table is carried by the guild migration
-- bundle (`src/migration.rs`), so a rename would mean a bundle written by this
-- server and a bundle written by yesterday's disagreeing about where a guild's
-- rules live, for no gain. And a guild that had AutoMod configured before the
-- upgrade would have had a window -- however short -- in which its rules were
-- in the old table and the engine was reading the new one, which is to say a
-- window with no moderation at all.
--
-- Extending in place means the upgrade is invisible: the same rows, the same
-- ids, the same hits, evaluated by a strictly more capable engine. There is
-- exactly one automod system afterwards, which was the requirement; it is just
-- that the surviving one kept the old table's name because the name was never
-- the problem.
--
-- The old engine hard-coded a ten-second window for `flood` and a five-minute
-- timeout for the `timeout` action. Both become columns with those values as
-- their defaults, so every existing rule keeps behaving exactly as it did while
-- new rules can say something else.
ALTER TABLE automod_rules ADD COLUMN window_secs INTEGER NOT NULL DEFAULT 10;
ALTER TABLE automod_rules ADD COLUMN timeout_secs INTEGER NOT NULL DEFAULT 300;
-- Channels a rule ignores, and channels a rule is limited to. Both JSON arrays
-- of channel ids; an empty `scope_channels` means "everywhere", which is what
-- every rule written before today meant.
ALTER TABLE automod_rules ADD COLUMN exempt_channels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE automod_rules ADD COLUMN scope_channels TEXT NOT NULL DEFAULT '[]';
-- Escalation: a JSON array of `{ "hits": n, "action": "..." }` steps evaluated
-- against how many times this rule has caught this member inside
-- `escalate_window_secs`. Empty means the rule's flat `action` always applies,
-- which is what the old engine did and therefore what every existing rule
-- continues to do.
ALTER TABLE automod_rules ADD COLUMN escalate TEXT NOT NULL DEFAULT '[]';
ALTER TABLE automod_rules ADD COLUMN escalate_window_secs INTEGER NOT NULL DEFAULT 3600;
-- Who saved this rule. Backfilled below from the audit log where the guild
-- still has the entry, because attribution that starts empty for existing rules
-- is attribution a moderator cannot rely on.
ALTER TABLE automod_rules ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE automod_rules ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

-- The audit log recorded `automod.create` with the rule id as its target from
-- the day the feature shipped, so for most existing rules the author is already
-- written down somewhere in this database and only needs moving to where the
-- engine can see it. A rule whose audit entry has aged out keeps the empty
-- string, which the API renders as "unknown" rather than inventing somebody.
UPDATE automod_rules
   SET created_by = COALESCE((
           SELECT a.actor FROM audit_log a
            WHERE a.guild_id = automod_rules.guild_id
              AND a.action = 'automod.create'
              AND a.target = automod_rules.id
            ORDER BY a.created_at LIMIT 1
       ), ''),
       updated_at = created_at;

-- Every guild that already had a rule gets the automod module switched on, and
-- no other guild does. This is the whole of "a guild that had automod
-- configured before the upgrade comes out the other side with the same rules
-- working": the rows never moved, and the one new thing that could have
-- silenced them -- a module toggle defaulting to off -- is pre-answered here.
INSERT INTO otto_config (guild_id, module, enabled, config, updated_by, updated_at)
SELECT DISTINCT guild_id, 'automod', 1, '{}', '', CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM automod_rules
 -- The trailing WHERE is not a filter. SQLite's parser cannot tell
 -- whether `ON` after a SELECT source begins a join constraint or an
 -- upsert clause, and resolves the ambiguity by refusing to parse; a
 -- terminated WHERE clause disambiguates it. Removing this line makes
 -- the whole migration a syntax error.
 WHERE true
ON CONFLICT (guild_id, module) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Infractions
-- ---------------------------------------------------------------------------

-- Warn, mute, kick, ban and unban, whoever performed them and whatever caused
-- them, in one ledger. A moderator asking "what has this person done here"
-- should not have to read the audit log, which is a record of *everything* and
-- is scoped to people who may view it; this is the narrower, member-shaped view
-- that the moderation UI shows on a profile.
--
-- `source` and `rule_id` are how an infraction answers "why". A human action
-- has source 'moderator' and names the actor; an automod action has source
-- 'automod' and names the rule, and the rule names the admin who wrote it. There
-- is no path by which Otto records a punishment with no explanation, because
-- `source` is NOT NULL and the only writer sets it from the call site.
--
-- `expires_at` is what makes a mute a mute rather than a permanent silencing:
-- the sweeper lifts it, and `active` goes to 0 so the history still shows it
-- happened. A revoked infraction keeps its row for the same reason -- a
-- moderator undoing a colleague's warning is itself a thing worth knowing.
CREATE TABLE otto_infractions (
    id          TEXT PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- warn | mute | kick | ban | unban | note
    reason      TEXT NOT NULL DEFAULT '',
    actor       TEXT NOT NULL,          -- the moderator, or Otto's own user id
    source      TEXT NOT NULL,          -- moderator | automod | raid
    rule_id     TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,
    active      INTEGER NOT NULL DEFAULT 1,
    revoked_at  INTEGER,
    revoked_by  TEXT
);
CREATE INDEX otto_infractions_member ON otto_infractions (guild_id, user_id, created_at);
-- The sweeper's index: it asks only for rows that are still active and already
-- due, which without this is a scan of every punishment the server has ever
-- recorded, every tick, forever.
CREATE INDEX otto_infractions_due ON otto_infractions (active, expires_at);

-- ---------------------------------------------------------------------------
-- Auto-reply
-- ---------------------------------------------------------------------------

-- A trigger and a response. The dangerous part of this feature is not the
-- matching, it is the sending: a rule on a common word in a busy guild is a
-- self-inflicted flood, and one that echoes the message back is a self-inflicted
-- amplifier. `cooldown_secs` is the per-scope answer and Otto's global send
-- budget (in process, not in this schema) is the backstop.
--
-- `response` is a template, and templates are the other dangerous part: the
-- variables it can interpolate carry display names and message text written by
-- whoever triggered the rule. Nothing in this table constrains that; the
-- substitution code does, and it does it by neutralising mention syntax in
-- every interpolated value rather than by trying to spot a bad one.
-- There is deliberately no `otto_autoreplies` table. The reply list is an
-- ordinary field of the `autoreply` module's configuration document
-- (`otto_config.config -> 'replies'`), saved by the same `PUT /otto/config/
-- autoreply` that saves the rest of the module, because that is what the
-- settings screen does: it edits one JSON object per module and PUTs the whole
-- thing.
--
-- The alternative -- a table, with its own create/patch/delete routes, projected
-- into the configuration document for reading -- was written and thrown away. It
-- gives two sources of truth for the same list, and the failure it produces is
-- the quiet one: a reply that exists in the table, is absent from the document
-- the admin is looking at, and fires anyway. AutoMod rules ARE a table, and the
-- asymmetry is deliberate: those have a foreign key pointing at them from
-- `automod_hits` and a decade of existing rows to preserve. Auto-replies have
-- neither, and inventing a table for symmetry's sake would buy nothing.
--
-- What does need a row is the clock, below, because a cooldown is state the
-- admin does not edit and must not reset by saving an unrelated field.

-- Cooldown bookkeeping, keyed by rule and by whatever scope the rule cools down
-- on (a channel, a member). Deliberately not carried by a guild migration
-- bundle: it is a clock, and a guild arriving on a new server should start with
-- its cooldowns expired rather than inherit a stale "already replied" that
-- silences a rule nobody can see is silenced.
CREATE TABLE otto_autoreply_cooldowns (
    guild_id      TEXT NOT NULL,
    rule_id       TEXT NOT NULL,
    scope_key     TEXT NOT NULL,
    last_fired_at INTEGER NOT NULL,
    PRIMARY KEY (rule_id, scope_key)
);

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------

-- A panel is the message with the button on it; a ticket is the private channel
-- that button opens. They are separate rows because a panel outlives the
-- tickets it opened and a ticket outlives the panel if an admin deletes it.
--
-- `staff_roles` is the access list, and it is the one field in this table that
-- is load-bearing for privacy rather than for behaviour: it becomes the channel
-- overwrites on creation and it is re-read on every transcript request. It is
-- stored on the panel rather than read from a guild-wide setting so that two
-- panels -- "appeals", seen by admins only, and "support", seen by helpers --
-- cannot accidentally share an audience.
CREATE TABLE otto_ticket_panels (
    id                   TEXT PRIMARY KEY,
    guild_id             TEXT NOT NULL,
    channel_id           TEXT NOT NULL,
    message_id           TEXT,
    title                TEXT NOT NULL DEFAULT 'Support',
    body                 TEXT NOT NULL DEFAULT '',
    button_label         TEXT NOT NULL DEFAULT 'Open a ticket',
    staff_roles          TEXT NOT NULL DEFAULT '[]',
    category_id          TEXT,
    per_user_limit       INTEGER NOT NULL DEFAULT 1,
    transcript_channel_id TEXT,
    created_by           TEXT NOT NULL DEFAULT '',
    created_at           INTEGER NOT NULL
);
CREATE INDEX otto_ticket_panels_guild ON otto_ticket_panels (guild_id);

-- `transcript` holds the closed conversation as text. It lives in this row
-- rather than in a channel message because a transcript posted into a channel
-- is a transcript whose audience is whoever can read that channel *now*, and a
-- private conversation must not become readable because somebody later widened
-- a log channel. The API serves it only to the opener and to the panel's staff
-- roles, which is the same audience the ticket channel itself had.
--
-- `staff_roles` is copied onto the ticket at creation for exactly that reason:
-- if the panel is edited or deleted afterwards, the transcript's audience must
-- stay the audience that was in the room.
CREATE TABLE otto_tickets (
    id             TEXT PRIMARY KEY,
    guild_id       TEXT NOT NULL,
    panel_id       TEXT,
    channel_id     TEXT,
    opener_id      TEXT NOT NULL,
    subject        TEXT NOT NULL DEFAULT '',
    state          TEXT NOT NULL DEFAULT 'open',   -- open | claimed | closed
    staff_roles    TEXT NOT NULL DEFAULT '[]',
    claimed_by     TEXT,
    claimed_at     INTEGER,
    closed_by      TEXT,
    closed_at      INTEGER,
    close_reason   TEXT NOT NULL DEFAULT '',
    transcript     TEXT,
    transcript_at  INTEGER,
    created_at     INTEGER NOT NULL
);
CREATE INDEX otto_tickets_guild ON otto_tickets (guild_id, state);
CREATE INDEX otto_tickets_opener ON otto_tickets (guild_id, opener_id, state);

-- ---------------------------------------------------------------------------
-- Self-assignable roles
-- ---------------------------------------------------------------------------

-- Reaction roles and button roles are the same feature with two input devices,
-- so they are one table with a `kind`. What matters in both is the check that
-- happens when the row is *saved*: an admin may only bind a role they could
-- grant by hand, which means a role below their own highest and within their
-- own permissions. Without that, "let members pick a colour" is a privilege
-- escalation primitive, because the member pressing the button is not the one
-- being permission-checked.
CREATE TABLE otto_self_roles (
    id          TEXT PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- reaction | button
    channel_id  TEXT NOT NULL,
    message_id  TEXT NOT NULL,
    emoji       TEXT,
    label       TEXT NOT NULL DEFAULT '',
    role_id     TEXT NOT NULL,
    mode        TEXT NOT NULL DEFAULT 'toggle',   -- toggle | add | remove
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
);
CREATE INDEX otto_self_roles_message ON otto_self_roles (message_id);
CREATE INDEX otto_self_roles_guild ON otto_self_roles (guild_id);

-- ---------------------------------------------------------------------------
-- Scheduled announcements
-- ---------------------------------------------------------------------------

-- A body, a channel, and a time to say it. `interval_secs` of 0 is a one-shot;
-- anything else repeats. `next_at` is stored rather than recomputed so that a
-- server which was down over a scheduled time says the thing once when it comes
-- back rather than once per missed interval -- the worker advances `next_at`
-- past now in a single step, which is the behaviour an operator expects from a
-- restart and the opposite of what a naive "while next_at < now" loop gives.
-- Like auto-replies, the schedule itself lives in the module's configuration
-- document (`otto_config.config -> 'announcements'`), because that is the object
-- the settings screen PUTs. What lives here is only the part of an announcement
-- that the admin does not type and must not reset by saving an unrelated field:
-- when it last went out, and when it is next due.
--
-- Keeping `next_at` here rather than recomputing it from `interval_secs` on
-- every tick is what makes a restart behave. A server that was down over a
-- scheduled time says the thing once when it comes back, because the worker
-- advances `next_at` past now in a single step -- not once per missed interval,
-- which is what a naive "while next_at < now" loop gives and what turns a
-- weekend of downtime into ninety-six identical messages.
CREATE TABLE otto_announce_state (
    guild_id        TEXT NOT NULL,
    announcement_id TEXT NOT NULL,
    last_sent_at    INTEGER,
    next_at         INTEGER NOT NULL,
    PRIMARY KEY (guild_id, announcement_id)
);
CREATE INDEX otto_announce_state_due ON otto_announce_state (next_at);

-- ---------------------------------------------------------------------------
-- Raid protection state
-- ---------------------------------------------------------------------------

-- Live state, not configuration: whether this guild is locked down right now and
-- what put it there. It is separate from `otto_config` because it is written by
-- the detector at three in the morning and read on every join, and because it is
-- the one piece of Otto's state that should NOT survive a guild moving servers
-- -- arriving on a new homeserver already locked down, with nobody having
-- decided that, is a guild that looks broken on its first day.
--
-- `previous_permissions` is the part that has to be right. A lockdown takes
-- SEND_MESSAGES away from `@everyone`, and lifting it has to put back exactly
-- what was there -- not "the default", which would silently grant a permission
-- the guild had deliberately removed, and not a recomputed guess. So the whole
-- permission word is copied here before it is changed, and the restore writes
-- that word back verbatim. NULL means no lockdown has been applied, which is
-- distinguishable from a lockdown that found `@everyone` holding zero.
CREATE TABLE otto_raid_state (
    guild_id             TEXT PRIMARY KEY,
    lockdown_until       INTEGER,
    lockdown_reason      TEXT NOT NULL DEFAULT '',
    lockdown_by          TEXT NOT NULL DEFAULT '',
    previous_permissions INTEGER,
    triggered_at         INTEGER
);

-- ---------------------------------------------------------------------------
-- The pre-deletion message cache
-- ---------------------------------------------------------------------------

-- "Log deleted messages" is the one logging category that cannot be implemented
-- by listening for the event, because by the time `MESSAGE_DELETE` is dispatched
-- the row it names has already had its content blanked -- which is correct
-- behaviour for deletion and fatal for logging it.
--
-- So the content is captured on the way in, by a trigger, and read back when the
-- delete arrives. A trigger rather than a call in the send path for two reasons:
-- the send path lives in a file this work does not own, and more importantly a
-- trigger cannot be bypassed by a *second* writer. Every path that blanks a
-- message -- the ordinary delete, the moderator purge, a future bulk delete --
-- goes through `UPDATE messages SET content = ...`, and all of them are covered
-- without any of them knowing this table exists.
--
-- `previous_content` is what makes one table serve both deletions and edits:
-- the update trigger moves OLD.content there before writing the new one, so a
-- MESSAGE_UPDATE can be logged as a before/after pair and a MESSAGE_DELETE can
-- be logged with the text that was removed.
--
-- The cost is a copy of recent message content, so the copy is made only for
-- guilds that have turned message logging on -- an operator who has not asked
-- for this stores nothing extra -- and it is pruned on a retention window by the
-- Otto worker. It is deliberately not carried by a guild migration bundle: it is
-- a few days of buffer, the messages themselves travel, and shipping a second
-- copy of recent content to a new server is a privacy cost with no benefit.
CREATE TABLE otto_message_cache (
    message_id       TEXT PRIMARY KEY,
    guild_id         TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    author_id        TEXT NOT NULL,
    content          TEXT NOT NULL DEFAULT '',
    previous_content TEXT,
    attachments      TEXT NOT NULL DEFAULT '[]',
    created_at       INTEGER NOT NULL,
    cached_at        INTEGER NOT NULL
);
CREATE INDEX otto_message_cache_prune ON otto_message_cache (cached_at);

CREATE TRIGGER otto_message_cache_insert
AFTER INSERT ON messages
WHEN NEW.guild_id IS NOT NULL AND NEW.guild_id <> ''
 AND EXISTS (SELECT 1 FROM otto_config
              WHERE guild_id = NEW.guild_id AND module = 'logging' AND enabled = 1)
BEGIN
    INSERT INTO otto_message_cache
        (message_id, guild_id, channel_id, author_id, content, previous_content,
         attachments, created_at, cached_at)
    VALUES (NEW.id, NEW.guild_id, NEW.channel_id, NEW.author_id, NEW.content, NULL,
            COALESCE(NEW.attachments, '[]'), NEW.created_at,
            CAST(strftime('%s','now') AS INTEGER) * 1000)
    ON CONFLICT (message_id) DO UPDATE SET
        content = excluded.content,
        attachments = excluded.attachments,
        cached_at = excluded.cached_at;
END;

-- An upsert rather than a plain UPDATE so that a message written before the
-- module was switched on still gets its pre-edit text captured the first time
-- somebody changes it. Fires for deletion too, since deletion is an update that
-- blanks `content`: OLD.content is the text that is about to stop existing.
CREATE TRIGGER otto_message_cache_update
AFTER UPDATE OF content ON messages
WHEN NEW.guild_id IS NOT NULL AND NEW.guild_id <> ''
 AND EXISTS (SELECT 1 FROM otto_config
              WHERE guild_id = NEW.guild_id AND module = 'logging' AND enabled = 1)
BEGIN
    INSERT INTO otto_message_cache
        (message_id, guild_id, channel_id, author_id, content, previous_content,
         attachments, created_at, cached_at)
    VALUES (NEW.id, NEW.guild_id, NEW.channel_id, NEW.author_id, NEW.content, OLD.content,
            COALESCE(NEW.attachments, '[]'), NEW.created_at,
            CAST(strftime('%s','now') AS INTEGER) * 1000)
    ON CONFLICT (message_id) DO UPDATE SET
        previous_content = OLD.content,
        content = excluded.content,
        attachments = excluded.attachments,
        cached_at = excluded.cached_at;
END;

-- ---------------------------------------------------------------------------
-- The interaction-contract integration point
-- ---------------------------------------------------------------------------

-- docs/INTERACTIVITY-CONTRACT.md gives `messages` two JSON columns, `components`
-- and `cards`, owned by another track. Otto's ticket panels and button roles are
-- consumers of that contract, and they were built before it landed.
--
-- This table is the seam, and it is a staging buffer rather than a second
-- implementation: Otto writes the component tree it wants on a message here,
-- keyed by that message. When the contract's columns exist, `otto::interact`
-- writes through to `messages.components` as well and this row becomes a
-- record of what Otto asked for; until they exist, the row is the only copy and
-- the panel is still fully usable through Otto's REST routes, which are the same
-- code path a button press will call. Nothing here needs deleting when the
-- contract lands -- the rows simply stop being the only copy.
--
-- It is not carried by a guild migration bundle because the messages it
-- annotates are, and the annotation is rebuilt from the panel row on arrival.
CREATE TABLE otto_pending_components (
    message_id TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    components TEXT NOT NULL DEFAULT '[]',
    cards      TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
);
