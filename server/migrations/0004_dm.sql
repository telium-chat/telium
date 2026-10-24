-- Phase 3: direct messages, group chats, and the key vault (plan Section 8).
--
-- Every server in this file is a Delivery Service and nothing more: it stores
-- ciphertext, assigns an order to it, and hands it on. No column here holds
-- anything a homeserver could read without the vault key.

-- MLS KeyPackages, published per device so anyone can start a session with a
-- device that is currently offline. One package is consumed per session.
CREATE TABLE key_packages (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    package    TEXT NOT NULL,             -- opaque, base64 MLS KeyPackage
    created_at INTEGER NOT NULL,
    claimed_by TEXT,
    claimed_at INTEGER
);
CREATE INDEX key_packages_unclaimed ON key_packages (user_id, claimed_at);

-- The key vault. In escrowed mode `escrow_key` is present and the operator can
-- open the blob; in self-custody mode it is NULL and the server holds ciphertext
-- it cannot read. The mode is stated in the UI in exactly those terms.
CREATE TABLE key_vault (
    user_id    TEXT PRIMARY KEY,
    mode       TEXT NOT NULL DEFAULT 'escrowed',   -- escrowed | self_custody
    ciphertext TEXT NOT NULL,
    escrow_key TEXT,
    version    INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);

-- A DM or group chat. `sequencer` is the homeserver that assigns the total order
-- MLS commits require; it is not an authority over the conversation, and any
-- member may re-anchor it elsewhere.
CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,            -- dm | gc
    sequencer   TEXT NOT NULL,            -- domain
    creator     TEXT NOT NULL,
    epoch       INTEGER NOT NULL DEFAULT 0,
    last_seq    INTEGER NOT NULL DEFAULT 0,
    -- Group name/icon/topic live inside the MLS state, so this column is
    -- deliberately opaque: the sequencer never learns what the group is called.
    metadata    TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- The routing list, which is the one thing a sequencer genuinely must know.
CREATE TABLE conversation_members (
    conversation_id TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    home_domain     TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'active',  -- active | left | removed
    added_at        INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON conversation_members (user_id, state);

-- Ciphertext, ordered. `kind` is the MLS frame class, which the server needs for
-- ordering rules and nothing else; receipts and typing are `application` frames
-- and therefore indistinguishable from messages here, by design.
CREATE TABLE dm_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    epoch           INTEGER NOT NULL DEFAULT 0,
    kind            TEXT NOT NULL,        -- application | commit | proposal | welcome
    sender          TEXT NOT NULL,
    sender_device   TEXT,
    ciphertext      TEXT NOT NULL,
    created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX dm_messages_order ON dm_messages (conversation_id, seq);
CREATE INDEX dm_messages_recent ON dm_messages (conversation_id, created_at);

-- Store-and-forward. A homeserver that is down is a delay, not a lost message.
CREATE TABLE dm_outbox (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    destination     TEXT NOT NULL,
    path            TEXT NOT NULL,
    payload         TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    created_at      INTEGER NOT NULL
);
CREATE INDEX dm_outbox_due ON dm_outbox (next_attempt_at);
