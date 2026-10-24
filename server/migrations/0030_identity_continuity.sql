-- Immutable account identity and threshold recovery.
--
-- The human account address is server-routed. These rows are deliberately not
-- another homeserver trust root: clients verify the signatures and derive the
-- immutable id from the genesis public key. A malicious operator can rewrite
-- SQLite, but a compliant client with a pinned immutable id rejects a fork.

CREATE TABLE identity_roots (
    user_id                 TEXT PRIMARY KEY REFERENCES accounts(user_id) ON DELETE CASCADE,
    immutable_id            TEXT NOT NULL,
    genesis_key             TEXT NOT NULL,
    anchor_signature        TEXT NOT NULL,
    current_key             TEXT NOT NULL,
    sequence                INTEGER NOT NULL DEFAULT 0,
    current_policy_version  INTEGER NOT NULL DEFAULT 0,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL
);


CREATE TABLE identity_transitions (
    user_id             TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    sequence            INTEGER NOT NULL,
    previous_key        TEXT NOT NULL,
    new_key             TEXT NOT NULL,
    authorization_kind  TEXT NOT NULL,
    authorization_json  TEXT NOT NULL,
    policy_version      INTEGER,
    created_at          INTEGER NOT NULL,
    PRIMARY KEY (user_id, sequence)
);

CREATE TABLE identity_recovery_policies (
    user_id            TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    version            INTEGER NOT NULL,
    identity_sequence  INTEGER NOT NULL,
    threshold          INTEGER NOT NULL,
    guardians_json     TEXT NOT NULL,
    signature          TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    PRIMARY KEY (user_id, version)
);

-- New verification rows bind trust to the immutable identity rather than only
-- the root key that happened to be current when the human compared emoji.
ALTER TABLE user_signatures ADD COLUMN subject_identity_id TEXT;
ALTER TABLE user_signatures ADD COLUMN signer_key TEXT;
