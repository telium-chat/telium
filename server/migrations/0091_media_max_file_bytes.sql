-- Per-guild and per-channel attachment size caps.
--
-- The global `[media_policy] max_file_bytes` is one number for the whole
-- server. These columns let a guild — and a channel within it — narrow what
-- they will accept, mirroring `media_expiry_limit_secs`: an upload destined
-- for the channel takes the narrowest cap in its path. NULL leaves the
-- decision to the next level out; the server's own limit always applies.
ALTER TABLE guilds ADD COLUMN media_max_file_bytes INTEGER;
ALTER TABLE channels ADD COLUMN media_max_file_bytes INTEGER;
