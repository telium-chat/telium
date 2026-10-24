-- End-to-end encryption for guild calls on an SFU (docs/guild-calls.md).
--
-- A guild call's media key is exported from an MLS group of the devices in
-- the call. This server is its delivery service and nothing more: it holds
-- each joiner's public KeyPackage until somebody in the group adds it, and
-- orders commits by epoch so two members adding people at once cannot fork
-- the group. Neither column below is a secret, and nothing here opens media.
ALTER TABLE voice_states ADD COLUMN e2ee_package TEXT;
-- Whether a commit this server accepted has put this session's leaf in the
-- group. A liveness fact, not a security one: a server that lies here can
-- stall a call, but cannot give anybody the key.
ALTER TABLE voice_states ADD COLUMN e2ee_member INTEGER NOT NULL DEFAULT 0;

-- One group per live call. A fresh id each time a call starts over, so a
-- commit meant for a call that has since emptied cannot land in the next one.
CREATE TABLE voice_e2ee_groups (
    channel_id TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL,
    epoch      INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
