-- A voice channel's custom status: a short line set by people in the call
-- ("Lobby 2 — ranked grind"), shown under the channel name.
--
-- This is not the channel topic. The topic is the room's standing description
-- and takes MANAGE_CHANNELS to change; the status is what the room is doing
-- *right now* and anyone connected to the voice channel (or holding CONNECT)
-- may set or clear it. Three columns rather than one so the client can say
-- who set it and when without a second query.
ALTER TABLE channels ADD COLUMN voice_status TEXT;
ALTER TABLE channels ADD COLUMN voice_status_at INTEGER;
ALTER TABLE channels ADD COLUMN voice_status_author TEXT;
