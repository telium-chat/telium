-- The per-member delivery cursor behind DM unread badges.
--
-- A badge is "frames past the cursor", and the cursor lives here so it
-- survives every client: a brand-new install counts the account's real
-- backlog, a re-login does not erase what arrived while the device was off,
-- and reading on one device settles it everywhere. It is the DM counterpart
-- of the guild read cursor (`read_state.last_read_id`), with one deliberate
-- difference in how it starts: there is no per-device queue to seed it from,
-- so a member begins delivered up to the moment they became a member --
-- history from before that is not theirs to read (docs/dm-encryption.md) and
-- must not badge. The report path only moves it forward (MAX), so a device
-- that lagged behind another can never unread what was already seen.
--
-- Existing members start at their conversation's current last_seq: the badge
-- era begins with this migration, not with a flood of retroactive counts.
ALTER TABLE conversation_members ADD COLUMN delivered_seq INTEGER NOT NULL DEFAULT 0;
UPDATE conversation_members SET delivered_seq = COALESCE(
    (SELECT last_seq FROM conversations c WHERE c.id = conversation_members.conversation_id), 0);
