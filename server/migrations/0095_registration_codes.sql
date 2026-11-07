-- Store only one-way hashes of admission codes. Never store the plaintext
-- secret: listing the table or backing up the database must not leak codes.
CREATE TABLE registration_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'admin',
    max_uses INTEGER NOT NULL CHECK (max_uses >= 1 AND max_uses <= 10000),
    uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER
);
-- Bootstrap is minted once even if the installer runs twice.
CREATE UNIQUE INDEX registration_codes_one_setup
    ON registration_codes(kind) WHERE kind = 'setup';
CREATE INDEX registration_codes_expires ON registration_codes(expires_at);
