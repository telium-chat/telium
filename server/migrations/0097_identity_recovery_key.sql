-- The account recovery key, bound into the immutable identity.
--
-- `accounts.recovery_public_key` is held by the user, but only the server
-- vouches that it belongs to the account. Here the identity root signs it, so
-- a client can check a rotation authorised by that key without trusting the
-- server: a lost root can then be replaced quietly, the chain intact. Versions
-- are an append-only clock, as for guardian policies.
CREATE TABLE identity_recovery_keys (
    user_id            TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    version            INTEGER NOT NULL,
    identity_sequence  INTEGER NOT NULL,
    recovery_key       TEXT NOT NULL,
    signature          TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    PRIMARY KEY (user_id, version)
);

ALTER TABLE identity_roots ADD COLUMN current_recovery_key_version INTEGER NOT NULL DEFAULT 0;

-- One-use challenges for resetting an identity whose root is lost everywhere,
-- signed with the recovery key. A reset starts a new immutable identity, so
-- contacts see it as changed and must verify again: nothing here lets the
-- server, or anyone, continue the old one.
CREATE TABLE identity_reset_attempts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    challenge   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX identity_reset_attempts_expiry
    ON identity_reset_attempts(expires_at);
