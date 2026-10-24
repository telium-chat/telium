-- Native federated bot applications and runtime identities.
--
-- Bot identities are deliberately NOT rows in `accounts`. They therefore can
-- never enter password, OPAQUE, MFA, recovery, device or human session flows.
-- A long-lived bot credential is accepted only by the bot identity's home
-- server. Guild servers see short-lived, audience-bound assertions and mint a
-- local bot guild session exactly as they do for people.

-- One namespace for human and bot localparts. Existing code keeps writing the
-- `accounts` table; triggers make those writes participate without teaching
-- every registration/import path about bots.
CREATE TABLE identity_localparts (
    localpart    TEXT NOT NULL,
    domain       TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user', 'bot')),
    subject_id   TEXT NOT NULL,
    PRIMARY KEY (localpart, domain),
    UNIQUE (subject_kind, subject_id)
);
INSERT INTO identity_localparts (localpart, domain, subject_kind, subject_id)
SELECT localpart, domain, 'user', user_id FROM accounts;

CREATE TRIGGER accounts_identity_localpart_insert
AFTER INSERT ON accounts
BEGIN
    INSERT INTO identity_localparts (localpart, domain, subject_kind, subject_id)
    VALUES (NEW.localpart, NEW.domain, 'user', NEW.user_id);
END;
CREATE TRIGGER accounts_identity_localpart_update
AFTER UPDATE OF user_id, localpart, domain ON accounts
BEGIN
    UPDATE identity_localparts
       SET localpart = NEW.localpart, domain = NEW.domain, subject_id = NEW.user_id
     WHERE subject_kind = 'user' AND subject_id = OLD.user_id;
END;
CREATE TRIGGER accounts_identity_localpart_delete
AFTER DELETE ON accounts
BEGIN
    DELETE FROM identity_localparts
     WHERE subject_kind = 'user' AND subject_id = OLD.user_id;
END;

CREATE TABLE bot_applications (
    id            TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    icon_ref      TEXT,
    bot_user_id   TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX bot_applications_owner ON bot_applications (owner_user_id, created_at);

CREATE TABLE bot_identities (
    user_id        TEXT PRIMARY KEY,
    application_id TEXT NOT NULL UNIQUE,
    localpart      TEXT NOT NULL,
    domain         TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    disabled       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (localpart, domain)
);
CREATE TRIGGER bot_identity_localpart_insert
AFTER INSERT ON bot_identities
BEGIN
    INSERT INTO identity_localparts (localpart, domain, subject_kind, subject_id)
    VALUES (NEW.localpart, NEW.domain, 'bot', NEW.user_id);
END;
CREATE TRIGGER bot_identity_localpart_update
AFTER UPDATE OF user_id, localpart, domain ON bot_identities
BEGIN
    UPDATE identity_localparts
       SET localpart = NEW.localpart, domain = NEW.domain, subject_id = NEW.user_id
     WHERE subject_kind = 'bot' AND subject_id = OLD.user_id;
END;
CREATE TRIGGER bot_identity_localpart_delete
AFTER DELETE ON bot_identities
BEGIN
    DELETE FROM identity_localparts
     WHERE subject_kind = 'bot' AND subject_id = OLD.user_id;
END;

CREATE TABLE bot_credentials (
    id             TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    token_hash     TEXT NOT NULL UNIQUE,
    created_at     INTEGER NOT NULL,
    last_used_at   INTEGER,
    revoked_at     INTEGER
);
CREATE INDEX bot_credentials_application
    ON bot_credentials (application_id, revoked_at);

CREATE TABLE bot_settings (
    application_id      TEXT PRIMARY KEY,
    allowed_intents     INTEGER NOT NULL DEFAULT 0,
    default_permissions INTEGER NOT NULL DEFAULT 0,
    install_enabled     INTEGER NOT NULL DEFAULT 1
);

-- Convenience index held by the bot home. A guild server sends a signed
-- receipt after install/remove; membership authority always remains with the
-- guild server itself. `remote_guild_id` is deliberately not named `guild_id`:
-- this row is an identity-home index about a remote guild, not state that belongs
-- in that guild's migration bundle.
CREATE TABLE bot_installations (
    application_id  TEXT NOT NULL,
    bot_user_id      TEXT NOT NULL,
    remote_guild_id  TEXT NOT NULL,
    guild_domain     TEXT NOT NULL,
    allowed_intents  INTEGER NOT NULL DEFAULT 0,
    permissions      INTEGER NOT NULL DEFAULT 0,
    installed_at     INTEGER NOT NULL,
    removed_at       INTEGER,
    PRIMARY KEY (application_id, guild_domain, remote_guild_id)
);
CREATE INDEX bot_installations_bot ON bot_installations (bot_user_id, removed_at);

-- Guild-side bot authority lives on the ordinary member row so guild migration
-- already carries it with every other membership field. The managed role still
-- goes through the normal role/member-role tables and channel overwrites.
ALTER TABLE members ADD COLUMN bot_application_id TEXT;
ALTER TABLE members ADD COLUMN bot_application_origin TEXT;
ALTER TABLE members ADD COLUMN bot_allowed_intents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN bot_role_id TEXT;
ALTER TABLE members ADD COLUMN bot_installed_by TEXT;
CREATE INDEX members_bot_application
    ON members (guild_id, bot_application_origin, bot_application_id);

-- Delivery of installation receipts is durable. This is transport bookkeeping,
-- not guild state, so its guild reference is also named `remote_guild_id` and
-- deliberately stays out of guild migration bundles. One row per local
-- guild/application is enough: a newer grant/removal supersedes an older receipt.
CREATE TABLE bot_receipt_outbox (
    application_origin TEXT NOT NULL,
    application_id     TEXT NOT NULL,
    bot_user_id         TEXT NOT NULL,
    remote_guild_id     TEXT NOT NULL,
    active              INTEGER NOT NULL,
    allowed_intents     INTEGER NOT NULL DEFAULT 0,
    permissions         INTEGER NOT NULL DEFAULT 0,
    queued_at           INTEGER NOT NULL,
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (application_origin, application_id, remote_guild_id)
);
CREATE INDEX bot_receipt_outbox_due ON bot_receipt_outbox (next_attempt_at, queued_at);

-- Every authoritative membership change writes the latest receipt locally in
-- the same transaction. Network delivery happens later, so an unavailable bot
-- home can never make install, grant reduction, uninstall, or guild migration
-- fail. The normal HTTP path may deliver the same receipt immediately; receipt
-- application is idempotent and the outbox flusher removes the durable copy.
CREATE TRIGGER members_bot_receipt_insert
AFTER INSERT ON members
WHEN NEW.bot_application_id IS NOT NULL
BEGIN
    INSERT INTO bot_receipt_outbox
        (application_origin, application_id, bot_user_id, remote_guild_id, active,
         allowed_intents, permissions, queued_at, attempts, next_attempt_at)
    VALUES (
        NEW.bot_application_origin, NEW.bot_application_id, NEW.user_id, NEW.guild_id, 1,
        NEW.bot_allowed_intents,
        COALESCE((SELECT permissions FROM roles
                   WHERE id = NEW.bot_role_id AND guild_id = NEW.guild_id), 0),
        CAST(strftime('%s','now') AS INTEGER) * 1000, 0, 0
    )
    ON CONFLICT(application_origin, application_id, remote_guild_id) DO UPDATE SET
        bot_user_id = excluded.bot_user_id,
        active = 1,
        allowed_intents = excluded.allowed_intents,
        permissions = excluded.permissions,
        queued_at = excluded.queued_at,
        attempts = 0,
        next_attempt_at = 0;
END;

CREATE TRIGGER members_bot_receipt_update
AFTER UPDATE OF user_id, bot_application_id, bot_application_origin, bot_allowed_intents, bot_role_id ON members
WHEN NEW.bot_application_id IS NOT NULL
BEGIN
    INSERT INTO bot_receipt_outbox
        (application_origin, application_id, bot_user_id, remote_guild_id, active,
         allowed_intents, permissions, queued_at, attempts, next_attempt_at)
    VALUES (
        NEW.bot_application_origin, NEW.bot_application_id, NEW.user_id, NEW.guild_id, 1,
        NEW.bot_allowed_intents,
        COALESCE((SELECT permissions FROM roles
                   WHERE id = NEW.bot_role_id AND guild_id = NEW.guild_id), 0),
        CAST(strftime('%s','now') AS INTEGER) * 1000, 0, 0
    )
    ON CONFLICT(application_origin, application_id, remote_guild_id) DO UPDATE SET
        bot_user_id = excluded.bot_user_id,
        active = 1,
        allowed_intents = excluded.allowed_intents,
        permissions = excluded.permissions,
        queued_at = excluded.queued_at,
        attempts = 0,
        next_attempt_at = 0;
END;

CREATE TRIGGER members_bot_receipt_unmark
AFTER UPDATE OF bot_application_id ON members
WHEN OLD.bot_application_id IS NOT NULL AND NEW.bot_application_id IS NULL
BEGIN
    INSERT INTO bot_receipt_outbox
        (application_origin, application_id, bot_user_id, remote_guild_id, active,
         allowed_intents, permissions, queued_at, attempts, next_attempt_at)
    VALUES (
        OLD.bot_application_origin, OLD.bot_application_id, OLD.user_id, OLD.guild_id, 0,
        0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000, 0, 0
    )
    ON CONFLICT(application_origin, application_id, remote_guild_id) DO UPDATE SET
        bot_user_id = excluded.bot_user_id,
        active = 0,
        allowed_intents = 0,
        permissions = 0,
        queued_at = excluded.queued_at,
        attempts = 0,
        next_attempt_at = 0;
END;

CREATE TRIGGER members_bot_receipt_delete
AFTER DELETE ON members
WHEN OLD.bot_application_id IS NOT NULL
BEGIN
    INSERT INTO bot_receipt_outbox
        (application_origin, application_id, bot_user_id, remote_guild_id, active,
         allowed_intents, permissions, queued_at, attempts, next_attempt_at)
    VALUES (
        OLD.bot_application_origin, OLD.bot_application_id, OLD.user_id, OLD.guild_id, 0,
        0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000, 0, 0
    )
    ON CONFLICT(application_origin, application_id, remote_guild_id) DO UPDATE SET
        bot_user_id = excluded.bot_user_id,
        active = 0,
        allowed_intents = 0,
        permissions = 0,
        queued_at = excluded.queued_at,
        attempts = 0,
        next_attempt_at = 0;
END;

-- Roles can be inserted after a member during an imported bundle, and grant
-- edits update the role separately from the member row. Both paths refresh the
-- same outbox entry so the receipt always carries the effective role grant.
CREATE TRIGGER roles_bot_receipt_insert
AFTER INSERT ON roles
BEGIN
    INSERT INTO bot_receipt_outbox
        (application_origin, application_id, bot_user_id, remote_guild_id, active,
         allowed_intents, permissions, queued_at, attempts, next_attempt_at)
    SELECT
        m.bot_application_origin, m.bot_application_id, m.user_id, m.guild_id, 1,
        m.bot_allowed_intents, NEW.permissions,
        CAST(strftime('%s','now') AS INTEGER) * 1000, 0, 0
      FROM members m
     WHERE m.bot_role_id = NEW.id
       AND m.bot_application_id IS NOT NULL
    ON CONFLICT(application_origin, application_id, remote_guild_id) DO UPDATE SET
        bot_user_id = excluded.bot_user_id,
        active = 1,
        allowed_intents = excluded.allowed_intents,
        permissions = excluded.permissions,
        queued_at = excluded.queued_at,
        attempts = 0,
        next_attempt_at = 0;
END;

CREATE TRIGGER roles_bot_receipt_update
AFTER UPDATE OF permissions ON roles
BEGIN
    INSERT INTO bot_receipt_outbox
        (application_origin, application_id, bot_user_id, remote_guild_id, active,
         allowed_intents, permissions, queued_at, attempts, next_attempt_at)
    SELECT
        m.bot_application_origin, m.bot_application_id, m.user_id, m.guild_id, 1,
        m.bot_allowed_intents, NEW.permissions,
        CAST(strftime('%s','now') AS INTEGER) * 1000, 0, 0
      FROM members m
     WHERE m.bot_role_id = NEW.id
       AND m.bot_application_id IS NOT NULL
    ON CONFLICT(application_origin, application_id, remote_guild_id) DO UPDATE SET
        bot_user_id = excluded.bot_user_id,
        active = 1,
        allowed_intents = excluded.allowed_intents,
        permissions = excluded.permissions,
        queued_at = excluded.queued_at,
        attempts = 0,
        next_attempt_at = 0;
END;

-- A moved guild deliberately keeps its rows on the source as a readable archive,
-- so there is no member DELETE to tell bot homes that the old guild authority is
-- gone. The moved tombstone is the authoritative cutover point; queue removals
-- there. The destination independently queues active receipts as it imports the
-- bot member rows, so a bot home eventually learns both halves of the move.
CREATE TRIGGER guild_move_queues_bot_receipt_removal
AFTER INSERT ON tombstones
WHEN NEW.subject_type = 'guild' AND NEW.kind = 'moved'
BEGIN
    INSERT INTO bot_receipt_outbox
        (application_origin, application_id, bot_user_id, remote_guild_id, active,
         allowed_intents, permissions, queued_at, attempts, next_attempt_at)
    SELECT
        m.bot_application_origin, m.bot_application_id, m.user_id, m.guild_id, 0,
        0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000, 0, 0
      FROM members m
     WHERE m.guild_id = NEW.subject_id
       AND m.bot_application_id IS NOT NULL
    ON CONFLICT(application_origin, application_id, remote_guild_id) DO UPDATE SET
        bot_user_id = excluded.bot_user_id,
        active = 0,
        allowed_intents = 0,
        permissions = 0,
        queued_at = excluded.queued_at,
        attempts = 0,
        next_attempt_at = 0;
END;

-- Local, short-lived credentials minted by a guild server after a bot presents
-- an audience-bound assertion from its own home. They are intentionally a
-- separate table from human guild sessions so account/device semantics cannot
-- bleed across the boundary. `allowed_intents` is the application's current
-- global ceiling carried by that assertion; the gateway intersects it with the
-- narrower grant on each member row.
CREATE TABLE bot_guild_sessions (
    token_hash      TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    application_id  TEXT NOT NULL,
    home_domain     TEXT NOT NULL,
    display_name    TEXT NOT NULL DEFAULT '',
    avatar_ref      TEXT,
    allowed_intents INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
);
CREATE INDEX bot_guild_sessions_user ON bot_guild_sessions (user_id, application_id);

-- Account migration cannot safely move an active developer application yet:
-- the bot is a second federated identity with its own installed memberships,
-- and silently leaving it behind would orphan authority on the old home. The
-- HTTP layer gives this rule a useful 409; these triggers are the transactional
-- backstop that closes the race between two simultaneous requests.
CREATE TRIGGER bot_application_blocks_account_migration
BEFORE INSERT ON bot_applications
WHEN EXISTS (
    SELECT 1 FROM migrations
     WHERE subject_type = 'user'
       AND subject_id = NEW.owner_user_id
       AND state IN ('pending', 'ready')
)
BEGIN
    SELECT RAISE(ABORT, 'account migration is already in flight');
END;

CREATE TRIGGER account_migration_blocks_active_bot_applications
BEFORE INSERT ON migrations
WHEN NEW.subject_type = 'user'
 AND EXISTS (
    SELECT 1
      FROM bot_applications a
      JOIN bot_identities b ON b.application_id = a.id
     WHERE a.owner_user_id = NEW.subject_id
       AND b.disabled = 0
 )
BEGIN
    SELECT RAISE(ABORT, 'retire active bot applications before migrating the account');
END;


-- Permanent account deletion is different from reversible deactivation: once
-- deleted, no human session can ever manage an application owned by that row.
-- Guard both race orderings. The HTTP layer performs the same check for a useful
-- 409, while these triggers are the transaction-level backstop.
CREATE TRIGGER bot_application_requires_undeleted_owner
BEFORE INSERT ON bot_applications
WHEN NOT EXISTS (
    SELECT 1 FROM accounts
     WHERE user_id = NEW.owner_user_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'bot application owner is deleted or missing');
END;

CREATE TRIGGER account_delete_blocks_active_bot_applications
BEFORE UPDATE OF deleted_at ON accounts
WHEN NEW.deleted_at IS NOT NULL
 AND OLD.deleted_at IS NULL
 AND EXISTS (
    SELECT 1
      FROM bot_applications a
      JOIN bot_identities b ON b.application_id = a.id
     WHERE a.owner_user_id = OLD.user_id
       AND b.disabled = 0
 )
BEGIN
    SELECT RAISE(ABORT, 'retire active bot applications before deleting the account');
END;
