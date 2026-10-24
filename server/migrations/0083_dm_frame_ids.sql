-- A client-chosen identity for each frame it sends, so that sending is
-- idempotent.
--
-- A client that sent a commit and lost the answer -- a dropped connection, a
-- timeout, a crash -- cannot tell whether the sequencer ordered it. Sending it
-- again used to be a second frame at the next seq, or, for a commit, a refusal
-- that looked exactly like losing the epoch race to somebody else. With an id
-- the sequencer recognises a retry and answers it with the frame it already
-- ordered.
--
-- The id is unique per conversation and only where present, because frames
-- from clients that predate it carry none, and neither do the copies a
-- member's home mirrors from the sequencer.
ALTER TABLE dm_messages ADD COLUMN frame_id TEXT;

CREATE UNIQUE INDEX dm_messages_frame_id
    ON dm_messages (conversation_id, frame_id) WHERE frame_id IS NOT NULL;
