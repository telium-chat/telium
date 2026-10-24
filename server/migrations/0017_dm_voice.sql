-- Calls in DMs and group chats, on Section 7's machinery rather than a parallel
-- copy of it. A call is a call: the only thing that differs is who is entitled
-- to hear about it, and where the roster lives.
--
-- For a conversation the room *is* the conversation, so `guild_id` and
-- `channel_id` both hold its id, and this column is what tells the exit paths
-- -- leaving, being removed, closing the tab -- which audience to announce to
-- and whether there is an SFU to command. Existing rows are guild calls, which
-- is what the default says.
ALTER TABLE voice_states ADD COLUMN room_kind TEXT NOT NULL DEFAULT 'guild';
