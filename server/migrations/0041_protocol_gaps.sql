-- Identity revocation notices and group chat membership policy.
--
-- The home server pushes a signed notice to every guild server that hosts one
-- of an account's memberships when a device is revoked, the account is
-- deactivated or deleted, or a move completes (docs/federation.md, "Identity
-- revocation notices"). Periodic session revalidation is still the guarantee;
-- this is the part that makes it prompt.
--
-- One row per (account, device, kind, guild server). Revoking the same device
-- twice re-arms the row that is already there rather than queueing a second
-- notice, which is what makes the fan-out idempotent. `device_id` is '' for
-- the account-wide kinds, so that the uniqueness constraint holds for them too
-- (SQLite treats every NULL as distinct).
CREATE TABLE identity_notices (
    user_id      TEXT NOT NULL,
    device_id    TEXT NOT NULL DEFAULT '',
    kind         TEXT NOT NULL,
    guild_server TEXT NOT NULL,
    body         TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    next_at      INTEGER NOT NULL,
    delivered_at INTEGER,
    last_error   TEXT,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, kind, guild_server)
);
CREATE INDEX identity_notices_due ON identity_notices (delivered_at, next_at);

-- A group chat's membership policy as the sequencer holds it: who may add,
-- who may remove, who may change the policy, and the admin list. The
-- authoritative copy is the MLS GroupContext extension every member's client
-- enforces (docs/dm-encryption.md, "Group membership policy"); this one is
-- what the sequencer can enforce on the changes it is told about. NULL is a
-- conversation with no policy, which keeps the old behaviour: any member may
-- add or remove anyone.
ALTER TABLE conversations ADD COLUMN policy TEXT;
