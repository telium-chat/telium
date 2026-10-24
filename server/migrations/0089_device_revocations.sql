-- Device revocation as a statement the account root signs
-- (docs/account-security.md, "Revoking a device").
--
-- Deactivating a `devices` row is the server's word that a device is gone,
-- and a client has no reason to believe the server about that, nor any way to
-- tell the next server it asks. A revocation here is a statement signed by
-- the account's cross-signing root over the device's MLS signature key, so
-- every client can check it for itself and refuse the key wherever it shows
-- up: its frames, its commits, its KeyPackages, its leaf in a group.
--
-- Keyed by the MLS key, not the session: one browser profile keeps one MLS
-- key across sign-ins, and the key is what a peer sees.
CREATE TABLE device_revocations (
    user_id TEXT NOT NULL,
    mls_key TEXT NOT NULL,
    device_id TEXT NOT NULL,
    immutable_id TEXT NOT NULL,
    signer_key TEXT NOT NULL,
    signature TEXT NOT NULL,
    revoked_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, mls_key)
);

-- A root rotation signed by the new root as well as by whatever authorized it,
-- so nobody can name a key as an account's next root without holding it.
ALTER TABLE identity_transitions ADD COLUMN new_key_signature TEXT;
