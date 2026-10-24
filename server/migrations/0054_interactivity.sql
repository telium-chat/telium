-- App-authored components and cards, and the interactions they produce.
--
-- Until now every message in a channel was a person talking. This migration
-- adds the other kind: a message an application composed, carrying controls a
-- reader can press, which produce a round trip back to the application that
-- wrote them. That is a new attack surface reachable by third-party code, and
-- most of what follows is shaped by that rather than by the feature.
--
-- `components` and `cards` hang off `messages` rather than living in a side
-- table because they are part of the message and share its whole lifetime: a
-- deleted message's buttons must be gone the instant its text is, an archived
-- segment has to carry them or scrollback shows a message that has lost half of
-- itself, and guild migration has to move them without knowing they exist. A
-- side table would have to be taught about deletion, cold storage, crossposting
-- and export separately, and would eventually be forgotten by one of them. Both
-- default to '[]' so that every row written before this migration, and every
-- INSERT in the tree that does not name these columns, reads back as a message
-- with no components rather than as NULL that each reader handles its own way.
--
-- They are deliberately NOT the `embeds` table. An embed is derived: somebody
-- pasted a link and the server fetched and summarised it. A card is an
-- assertion an application made, rendered with that application's name against
-- it. Sharing a table would mean a bot could write a row that a client draws as
-- a site unfurl for a domain the bot has nothing to do with.
--
-- What breaks without this: nothing today, which is the point at which it is
-- cheap to get the storage shape right. Once a thousand guilds hold component
-- trees, moving them out of `messages` costs a rewrite of the archive format.
ALTER TABLE messages ADD COLUMN components TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN cards      TEXT NOT NULL DEFAULT '[]';

-- The `local` flag the contract names: an application whose code runs inside
-- this homeserver process rather than behind a federated socket.
--
-- It is one column on the existing table, and that is the entire design. A
-- local application is a `bot_applications` row like any other, so the
-- permission ceiling, the managed role, the BOT badge, the audit entries, the
-- installation receipts and guild migration all keep working with no special
-- case anywhere. The flag says how interactions reach it -- in-process dispatch
-- instead of a gateway socket -- and nothing else. In particular it must never
-- come to mean "exempt": the day a check reads this column to decide whether a
-- permission applies is the day the homeserver's own applications become the
-- one actor in the system that is above the ceiling, which is exactly the
-- property a guild admin installs a bot expecting not to exist.
ALTER TABLE bot_applications ADD COLUMN local INTEGER NOT NULL DEFAULT 0;

-- One row per press.
--
-- The row exists before the application hears about the press, and it is what
-- makes the response contract enforceable: it is where "this token has already
-- been used" and "this token belongs to that application" are recorded, and
-- neither question can be answered from the token alone.
--
-- `token_hash`, not `token`. Bearer credentials in this database are stored
-- hashed without exception (see `util::hash_token`) so that a database leak is
-- not a credential leak, and an interaction token is a bearer credential: it is
-- the sole proof that a response belongs to one particular press. Fifteen
-- minutes of validity does not change that -- a leaked dump is read in minutes,
-- and a token that authorises posting into a channel as an installed bot is
-- worth reading. The clear token exists only in the dispatch that carries it.
--
-- `application_id` and `application_origin` together, never `application_id`
-- alone: application ids are minted by their home servers, so two federated
-- homes can and eventually will issue the same id. A check that compares only
-- the id would let an application on a friendly-looking home answer
-- interactions minted for an application on another one.
--
-- `responded_at` is what makes the token single-use. It is set by the first
-- successful callback, and a second callback is refused by conflict rather than
-- silently overwriting the first response, because two responses to one press
-- means either a retry (which must not double-post) or a race (which must not
-- be resolved by whoever was slower).
--
-- `modal_custom_id` / `modal_components` are set only by a `{"type":"modal"}`
-- response, and they are the server's memory of what it told the client to
-- draw. Without them a modal submission would be a bag of custom_ids and values
-- that the server has to take the client's word for; with them, a submission is
-- checked against the form that was actually opened, for this user, from this
-- interaction.
CREATE TABLE interactions (
    id                  TEXT PRIMARY KEY,
    token_hash          TEXT NOT NULL UNIQUE,
    kind                TEXT NOT NULL CHECK (kind IN ('component', 'modal_submit')),
    application_id      TEXT NOT NULL,
    application_origin  TEXT NOT NULL,
    guild_id            TEXT NOT NULL,
    channel_id          TEXT NOT NULL,
    -- The message whose component was pressed. NULL when the press came from an
    -- ephemeral message, which by construction has no `messages` row.
    message_id          TEXT,
    ephemeral_id        TEXT,
    user_id             TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    expires_at          INTEGER NOT NULL,
    responded_at        INTEGER,
    response_kind       TEXT,
    -- Set by a deferred response so the follow-up PATCH knows whether the
    -- message it is about to create is ephemeral. The application states this
    -- when it defers, not when it follows up, because the client has already
    -- been told which kind of pending state to draw.
    deferred_ephemeral  INTEGER NOT NULL DEFAULT 0,
    -- The message the response created, so a follow-up edits rather than posts
    -- a second one.
    response_message_id TEXT,
    modal_custom_id     TEXT,
    modal_components    TEXT,
    -- The interaction this one answers, for a modal submission. It is how a
    -- submitted form is tied back to the press that opened it.
    parent_id           TEXT
);

-- Expiry sweeps read this; nothing else scans the table by time.
CREATE INDEX interactions_expiry ON interactions (expires_at);
-- "Has this application been handed a flood of presses" and the per-application
-- audit view both read (application, time).
CREATE INDEX interactions_application
    ON interactions (application_origin, application_id, created_at);
-- A modal submission looks up its parent by id, which the primary key serves,
-- but the reverse -- "was a modal already submitted for this press" -- does not.
CREATE INDEX interactions_parent ON interactions (parent_id);

-- Ephemeral messages: delivered to one person over the gateway, never written
-- to `messages`.
--
-- The contract fixes the visible behaviour -- an ephemeral response reaches the
-- acting user alone and does not become part of the channel -- and leaves the
-- storage story to this track. This table is that story, and the reason it is
-- not simply "store nothing" is components.
--
-- An ephemeral message is allowed to carry buttons, because the flows that need
-- ephemerality are exactly the multi-step ones: pick a thing, confirm it, cancel
-- it. A press has to be resolvable server-side -- which component, authored by
-- which application, on a message the presser can actually still see -- and none
-- of that can be taken from the client, because a client that could assert "this
-- message had a button called X belonging to application Y" could mint presses
-- for any application it liked. So the small amount of state a press needs is
-- kept here, and nothing else is: no content, no cards, no author, nothing that
-- would make this row a copy of the message.
--
-- What that buys, precisely: an ephemeral message is not in channel history, not
-- in the search index, not in a mention or notification row, not crosspostable,
-- not federated, not in a cold archive segment, and not in a guild export. It is
-- not visible to a moderator, which is the honest consequence of the contract's
-- promise and the reason applications must not use it to say anything that the
-- channel would need a record of. The row here expires and is swept; the message
-- was never anywhere else.
CREATE TABLE ephemeral_messages (
    id                 TEXT PRIMARY KEY,
    interaction_id     TEXT NOT NULL,
    application_id     TEXT NOT NULL,
    application_origin TEXT NOT NULL,
    guild_id           TEXT NOT NULL,
    channel_id         TEXT NOT NULL,
    -- The only person this message was ever delivered to, and therefore the
    -- only person whose press against it can be genuine.
    user_id            TEXT NOT NULL,
    components         TEXT NOT NULL DEFAULT '[]',
    created_at         INTEGER NOT NULL,
    expires_at         INTEGER NOT NULL
);
CREATE INDEX ephemeral_messages_expiry ON ephemeral_messages (expires_at);
