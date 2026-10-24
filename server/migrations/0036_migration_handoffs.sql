-- The guided account move (docs/migration.md, "The guided flow").
--
-- Rows live on the *source*. The account owner opens one by naming a
-- destination, and gets back an id and a secret for the link the client opens
-- on that destination. The destination fills the row in over a signed request
-- once a person signed in there has confirmed, and the owner's `POST /migrate`
-- spends it. The import token is written here rather than handed to the
-- client: it is the destination's word, carried server to server, and the
-- client that later asks to schedule the move only ever names the row.
CREATE TABLE migration_handoffs (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,     -- the account being moved, who opened it
    destination      TEXT NOT NULL,     -- the one server allowed to fill it in
    secret_hash      TEXT NOT NULL,     -- BLAKE3 of the secret in the link
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,  -- to be delivered by, then to be used by
    delivered_at     INTEGER,
    import_token     TEXT,              -- the destination's claim, once delivered
    target_id        TEXT,              -- the account it lands on there
    claim_expires_at INTEGER,
    consumed_at      INTEGER,           -- spent by the migration it started
    migration_id     TEXT
);
CREATE INDEX idx_migration_handoffs_user ON migration_handoffs (user_id);
