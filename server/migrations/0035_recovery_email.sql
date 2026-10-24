-- Where to reach the account off the network: set by the account, used for
-- the migration warning that goes out when a move is requested, and never
-- shown to anyone else. NULL means the account has not given one.
ALTER TABLE accounts ADD COLUMN recovery_email TEXT;

-- One row per migration the account was told about: when the gateway event
-- and push went out, and what became of the email. `email_state` is
-- `pending` while the send is in flight, then `sent`, `no_address` (the
-- account gave none), `no_mailer` (the operator configured none) or `failed`
-- with the reason in `email_error`. The client reads it back so the banner can
-- say whether a message is on its way, rather than the log saying it.
CREATE TABLE migration_alerts (
    migration_id TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    notified_at  INTEGER NOT NULL,
    email_state  TEXT NOT NULL DEFAULT 'pending',
    email_error  TEXT
);
CREATE INDEX migration_alerts_user ON migration_alerts (user_id);

-- The single-use half of the signed cancel link in that email. The link
-- itself is signed by this server's key and names the migration, its subject
-- and the deadline; the nonce inside it is stored here by hash only, and
-- spending it is one conditional UPDATE, so a link works once however many
-- times it is presented. A link issued before a retry names the old deadline
-- and is refused by that alone.
CREATE TABLE migration_cancel_links (
    nonce_hash   TEXT PRIMARY KEY,
    migration_id TEXT NOT NULL,
    expires_at   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    used_at      INTEGER
);
CREATE INDEX migration_cancel_links_migration ON migration_cancel_links (migration_id);
