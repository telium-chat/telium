-- Client-held account recovery keys.
--
-- The private recovery seed never reaches the homeserver. Only the Ed25519
-- public key is stored here; possession is proved by signing a one-use
-- challenge plus the exact replacement OPAQUE registration record.
ALTER TABLE accounts ADD COLUMN recovery_public_key TEXT;

CREATE TABLE password_reset_attempts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    challenge   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX password_reset_attempts_expiry
    ON password_reset_attempts(expires_at);
