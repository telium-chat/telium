-- One-use challenges for resetting an identity whose root is lost everywhere,
-- signed with the account recovery key. A reset starts a new immutable
-- identity, so contacts see it as changed and must verify again: nothing here
-- lets the server, or anyone, continue the old one.
CREATE TABLE identity_reset_attempts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    challenge   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX identity_reset_attempts_expiry
    ON identity_reset_attempts(expires_at);
