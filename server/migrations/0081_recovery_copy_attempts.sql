-- One-use challenges for putting a recovery-key copy of the DM vault back.
--
-- An account can hold a recovery public key with no recovery-key copy of its
-- vault beside it: older clients took the copy away before replacing the key,
-- and some sibling-device repairs wiped it. The key still resets the password
-- but opens no history. The copy may be written again by whoever proves they
-- hold that key, by signing one of these challenges together with the copy
-- itself. Kept apart from `password_reset_attempts` so that a challenge issued
-- for one ceremony can never be spent on the other.
CREATE TABLE recovery_copy_attempts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    challenge   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX recovery_copy_attempts_expiry
    ON recovery_copy_attempts(expires_at);
