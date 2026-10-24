-- Private notification federation (docs/notifications.md).
--
-- A device has a notification encryption key that is intentionally separate
-- from its account signing key, MLS state, and Web Push subscription key. The
-- private half never reaches the homeserver. `background_token_hash` authenticates
-- only the tiny native pull/ack API used after Android is woken by a provider.
CREATE TABLE notification_devices (
    user_id               TEXT NOT NULL,
    device_id             TEXT NOT NULL,
    algorithm             TEXT NOT NULL,
    public_key_b64        TEXT NOT NULL,
    background_token_hash TEXT NOT NULL,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id)
);
CREATE UNIQUE INDEX notification_device_token ON notification_devices (background_token_hash);

-- The account home is an opaque mailbox for remote-guild notification previews.
-- `source_id` belongs to the source authority (normally a message id); combining
-- it with origin + device makes signed federation retries exactly-once from the
-- user's point of view without requiring global ids.
CREATE TABLE notification_inbox (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    origin     TEXT NOT NULL,
    source_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    guild_id   TEXT,
    ciphertext TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (origin, source_id, device_id)
);
CREATE INDEX notification_inbox_device
    ON notification_inbox (user_id, device_id, id);
CREATE INDEX notification_inbox_expiry
    ON notification_inbox (expires_at);
