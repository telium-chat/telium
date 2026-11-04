-- Whether a frame may announce itself. The client's own word on its payload --
-- `notify` is true only for a MESSAGE; receipts, typing, reactions, edits,
-- deletes and pins ride the same `application` kind, so the sequencer cannot
-- tell them apart and the sender says so instead (derived from the payload's
-- leading byte, the same word the gateway dispatch and the push path already
-- read). The unread badge counts only frames worth interrupting somebody for,
-- so its count reads this flag. Existing rows default to speaking: 0092
-- started every member's cursor at their conversation's last_seq, so no
-- historical frame can badge regardless.
ALTER TABLE dm_messages ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;
