-- Privacy-preserving killed-app DM notification hints.
--
-- Every MLS application frame may carry a random notification_id. The sender
-- separately sends fixed-shape, per-device encrypted hints through account
-- homes. A recipient home keeps those hints pending until the authoritative
-- conversation sequencer delivers the frame with the same notification_id.
-- The server never learns whether the encrypted hint means "notify" or "quiet".
ALTER TABLE dm_messages ADD COLUMN notification_id TEXT;

CREATE INDEX dm_messages_notification_hint
    ON dm_messages (conversation_id, notification_id, sender)
    WHERE notification_id IS NOT NULL;

CREATE TABLE dm_notification_hints (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    notification_id TEXT NOT NULL,
    sender          TEXT NOT NULL,
    recipient_id    TEXT NOT NULL,
    device_id       TEXT NOT NULL,
    ciphertext      TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    UNIQUE(conversation_id, notification_id, sender, recipient_id, device_id)
);

CREATE INDEX dm_notification_hints_match
    ON dm_notification_hints (conversation_id, notification_id, sender);

CREATE INDEX dm_notification_hints_sender_pending
    ON dm_notification_hints (conversation_id, sender, notification_id);

CREATE INDEX dm_notification_hints_expiry
    ON dm_notification_hints (created_at);


-- Pending hint ciphertext is sealed to the same notification key as an inbox
-- row, so key rotation and device revocation must retire it at the same
-- authority boundary too. Replace the v0051 triggers with the extended form.
DROP TRIGGER notification_inbox_clear_on_key_rotation;
CREATE TRIGGER notification_inbox_clear_on_key_rotation
AFTER UPDATE OF public_key_b64 ON notification_devices
WHEN OLD.public_key_b64 <> NEW.public_key_b64
BEGIN
    DELETE FROM notification_inbox
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id;

    DELETE FROM dm_notification_hints
    WHERE recipient_id = NEW.user_id AND device_id = NEW.device_id;
END;

DROP TRIGGER notification_state_clear_on_device_revoke;
CREATE TRIGGER notification_state_clear_on_device_revoke
AFTER UPDATE OF active ON devices
WHEN OLD.active = 1 AND NEW.active = 0
BEGIN
    DELETE FROM notification_inbox
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id;

    DELETE FROM dm_notification_hints
    WHERE recipient_id = NEW.user_id AND device_id = NEW.device_id;

    DELETE FROM notification_devices
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id;

    DELETE FROM push_subscriptions
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id;
END;
