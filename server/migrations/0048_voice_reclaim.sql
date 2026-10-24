-- A voice state that outlives the process that wrote it.
--
-- The SFU is a separate machine, so a homeserver restart does not interrupt a
-- call: the audio keeps flowing while the roster's owner is away. Until now the
-- roster did not know that, and every boot deleted the lot. `reclaim_until` is
-- the deadline that replaces the deletion -- a state written before this boot
-- is unclaimed rather than dead, and a device that comes back and names the
-- session it still holds clears the deadline. Anything still carrying one when
-- it passes is swept exactly as it was before.
--
-- Null is the ordinary state: a claim held up by a live connection needs no
-- deadline, because the connection going is what ends it.
ALTER TABLE voice_states ADD COLUMN reclaim_until INTEGER;
ALTER TABLE voice_watchers ADD COLUMN reclaim_until INTEGER;
