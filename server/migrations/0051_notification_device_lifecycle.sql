-- A notification inbox row is decryptable only by the public key it was
-- sealed to. If Android has to regenerate that key, retaining older rows would
-- leave an undecryptable row at the head of the monotonic inbox and block every
-- notification encrypted to the replacement key.
CREATE TRIGGER notification_inbox_clear_on_key_rotation
AFTER UPDATE OF public_key_b64 ON notification_devices
WHEN OLD.public_key_b64 <> NEW.public_key_b64
BEGIN
    DELETE FROM notification_inbox
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id;
END;

-- Device revocation is the authority boundary for background notification
-- access. Remove its notification-only credential, opaque inbox, and provider
-- registration at the same moment the normal Telium device becomes inactive.
-- The devices row itself remains for the existing device/audit UX.
CREATE TRIGGER notification_state_clear_on_device_revoke
AFTER UPDATE OF active ON devices
WHEN OLD.active = 1 AND NEW.active = 0
BEGIN
    DELETE FROM notification_inbox
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id;

    DELETE FROM notification_devices
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id;

    DELETE FROM push_subscriptions
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id;
END;
