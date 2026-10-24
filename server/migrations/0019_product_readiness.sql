-- Product-readiness account security.
ALTER TABLE accounts ADD COLUMN mfa_secret TEXT;
ALTER TABLE accounts ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN deleted_at INTEGER;

CREATE TABLE mfa_recovery_codes (
    user_id    TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at    INTEGER,
    PRIMARY KEY (user_id, code_hash)
);
CREATE INDEX mfa_recovery_user ON mfa_recovery_codes (user_id, used_at);
