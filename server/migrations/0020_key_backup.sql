-- History that survives losing the device (issue: two honest custody modes).
--
-- MLS forward secrecy means a device admitted today cannot be handed what was
-- said yesterday: that is the guarantee, not a shortfall. But it made every
-- sign-in look like data loss, because every sign-in is a new device here.
--
-- So the client mirrors what it has opened into this table, each row sealed
-- client-side under the account's recovery key -- the same key `key_vault`
-- carries, and the same key that seals the GroupInfo a new device lets itself
-- in with. Nothing about who can read it is decided here. It is decided by
-- whether `key_vault.escrow_key` is present:
--
--   escrowed      this server holds the key that opens the vault, so it holds
--                 the key that opens every row below. The account's messages
--                 are readable by this server, and the interface says so in
--                 those words rather than drawing a padlock over it.
--   self_custody  the vault is sealed under a passphrase this server never
--                 sees, so these rows are bytes it cannot open. The account
--                 recovers its own history and nobody else can.
--
-- Switching modes re-seals the recovery key under a new wrapper and leaves the
-- key itself alone, so nothing in this table is re-encrypted by a switch -- only
-- who is able to open it changes.
CREATE TABLE key_backup (
    user_id    TEXT NOT NULL,
    -- The conversation the item belongs to. Opaque to this server, which is
    -- already true of the conversation id everywhere else it appears.
    scope      TEXT NOT NULL,
    -- Which item within the scope: a frame id for a message body, or one of the
    -- fixed names the client uses for a conversation's folded state.
    item       TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, scope, item)
) WITHOUT ROWID;

-- Restore reads one conversation at a time and pages by the cursor it was last
-- given, so the useful order is (owner, conversation, arrival).
CREATE INDEX key_backup_scan ON key_backup (user_id, scope, updated_at);
