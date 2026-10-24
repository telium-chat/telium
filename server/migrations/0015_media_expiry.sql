-- Optional file expiration (issue #73).
--
-- A sender may ask for a lifetime on an attachment; the destination may cap
-- it. The caps are three independent dials — channel, guild, server — and the
-- narrowest one wins. NULL on any of them means "no limit at this level", not
-- zero: an unset dial never expires anything by itself.

-- The one truth about whether an object is still hosted. Milliseconds since
-- the epoch, like every other timestamp here; NULL keeps forever. Indexed
-- because the sweep finds the next victims with this column and nothing else.
ALTER TABLE media ADD COLUMN expires_at INTEGER;
CREATE INDEX media_expires ON media (expires_at) WHERE expires_at IS NOT NULL;

-- Guild-level ceiling, in seconds. Channels can tighten it below; neither can
-- loosen what the server's own media policy caps.
ALTER TABLE guilds ADD COLUMN media_expiry_limit_secs INTEGER;
ALTER TABLE channels ADD COLUMN media_expiry_limit_secs INTEGER;
