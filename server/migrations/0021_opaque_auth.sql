-- OPAQUE (RFC 9807) password authentication.
--
-- Existing accounts keep their Argon2 password hash until one successful legacy
-- login enrolls an OPAQUE record. New accounts are OPAQUE-only. password_hash is
-- NOT NULL in the original schema, so enrolled accounts carry the sentinel
-- "opaque:v1"; the real password verifier is opaque_record.
ALTER TABLE accounts ADD COLUMN opaque_record TEXT;

-- Optional disaster-recovery wrapper for the DM vault. The normal ciphertext is
-- wrapped by OPAQUE's client-only export key; this second ciphertext may be
-- wrapped by an explicit recovery passphrase without replacing the normal path.
ALTER TABLE key_vault ADD COLUMN independent_ciphertext TEXT;

-- One stable server setup for all OPAQUE records on this homeserver. Rotating
-- this value invalidates every registration record, so it is database state,
-- not an ephemeral process key.
CREATE TABLE opaque_server_state (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    setup       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

-- ServerLogin contains ephemeral handshake secrets and must never be handed to
-- the browser. The client gets only an opaque attempt id; this state expires
-- quickly and is consumed exactly once at finish.
CREATE TABLE opaque_login_attempts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    state       TEXT NOT NULL,
    purpose     TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX opaque_login_attempts_expiry
    ON opaque_login_attempts(expires_at);

-- Successful OPAQUE reauthentication mints a short-lived one-use proof for a
-- sensitive authenticated operation. Only its hash is stored.
CREATE TABLE opaque_reauth_tokens (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    purpose     TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
);
CREATE INDEX opaque_reauth_tokens_expiry
    ON opaque_reauth_tokens(expires_at);
