-- KeyPackages are spent by deletion, and each device may hold one last-resort
-- package (docs/dm-encryption.md, "KeyPackages").
--
-- A claimed package used to stay in the table with `claimed_at` set, which
-- kept every init key a device had ever handed out sitting on the server long
-- after it was used. A claim now deletes the row it serves. The rows already
-- marked claimed are deleted here for the same reason.
--
-- `last_resort` marks the one package per device that is served when the
-- device's one-time packages have run out, so a device that has been offline
-- for a while is still reachable. It is never deleted by a claim; it is
-- replaced when the device publishes a new one and deleted when the device is
-- revoked or withdraws it.
DELETE FROM key_packages WHERE claimed_at IS NOT NULL;
ALTER TABLE key_packages ADD COLUMN last_resort INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX key_packages_last_resort ON key_packages (user_id, device_id) WHERE last_resort = 1;
