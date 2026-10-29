-- Message-reference accounting for attachment reclamation.
--
-- Until now an attachment's bytes left this server only through a requested
-- TTL, an explicit delete, account erasure, or the orphan sweep (which only
-- catches files with no row at all). A message deleted by its author or with
-- its channel left the row and the bytes behind forever.
--
-- `refs` counts live references from messages stored on this server: claimed
-- when a message carrying the hash is inserted, released when those rows are
-- deleted or blanked. Cold-archived history keeps its references — archiving
-- never releases, because the segment still serves the attachment.
--
-- `local_dest` marks uploads whose `x-telium-channel-id` / `x-telium-guild-id`
-- resolved to a channel or guild on this server, so messages here are the
-- authoritative reference record. Only such rows are reclaimable: an upload
-- whose destination lives elsewhere (a tier-2 origin, or ciphertext for an
-- end-to-end-encrypted conversation) keeps today's behavior, because this
-- server cannot see who still refers to it.
ALTER TABLE media ADD COLUMN refs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media ADD COLUMN local_dest INTEGER NOT NULL DEFAULT 0;
