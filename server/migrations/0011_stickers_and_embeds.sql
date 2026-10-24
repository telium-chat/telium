-- A sticker is not an attachment. It has no capability, no size, and nothing
-- to download: it is a reference to one of some guild's expression assets, and
-- a message carries at most one, so it gets its own column rather than being
-- smuggled through the attachments array.
ALTER TABLE messages ADD COLUMN sticker TEXT;

-- The guild-side half of the tier-3 choke point (Section 6). Embeds are fetched
-- by the guild server on the member's behalf; a channel that does not want link
-- previews at all says so here, once, for every client.
ALTER TABLE channels ADD COLUMN strip_embeds INTEGER NOT NULL DEFAULT 0;
