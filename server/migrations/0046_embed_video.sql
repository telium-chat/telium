-- Video unfurls.
--
-- An `og:video` is the difference between a card about a clip and the clip.
-- Several of the sites people actually paste -- the Twitter/X front ends most
-- of all -- describe the post's video in Open Graph and nothing else, so a card
-- that reads only `og:image` shows a still of something it could have played.
--
-- The file is cached under `camo` exactly as the preview image is, and for the
-- same reason: a client that fetched the mp4 itself would hand the channel's
-- IP addresses to the video host, which is the one thing tier 3 exists to
-- prevent. `video_hash` is therefore a camo hash, never an origin URL.
--
-- The dimensions are stored because they are the only way to hold the player's
-- box open at the right shape before a byte of video has arrived; without them
-- the timeline reflows the moment the first frame decodes.
ALTER TABLE embeds ADD COLUMN video_hash   TEXT;
ALTER TABLE embeds ADD COLUMN video_type   TEXT;
ALTER TABLE embeds ADD COLUMN video_width  INTEGER;
ALTER TABLE embeds ADD COLUMN video_height INTEGER;
