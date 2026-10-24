-- A member who is out of a conversation but whose MLS leaves are still in its
-- group (docs/dm-encryption.md, "Leaving and removal").
--
-- Leaving, and an account being closed, move the routing row out of `active`
-- at once, but nobody can commit the leaver's leaves out of the group at that
-- moment: the leaver cannot remove themselves, and the people who stay may be
-- offline. `resync` records that the group still holds leaves for somebody who
-- is no longer a member. It is served on the conversation descriptor so the
-- next member to sync commits the Removes, and is cleared by the commit that
-- declares the removal (or by the person being added back).
--
-- Members who left before this have the same leftover leaves, so they are
-- flagged too.
ALTER TABLE conversation_members ADD COLUMN resync INTEGER NOT NULL DEFAULT 0;
UPDATE conversation_members SET resync = 1 WHERE state = 'left';
