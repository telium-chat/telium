-- Starting a conversation over as a sequenced operation (docs/dm-encryption.md,
-- "Starting over").
--
-- A start-over replaces a conversation's MLS group with a new one under the
-- same id. It used to be a Welcome at epoch 1 and nothing else: any such
-- Welcome reset the sequencer's epoch, so two members starting over at once
-- each reset it, each adopted the other's Welcome, and a commit built on the
-- replaced group could still be ordered into the new one. A conversation now
-- counts its groups. `generation` is the group the sequencer is ordering for;
-- a start-over names the generation it replaces and the sequencer moves to
-- the next one only if that is still the current one, so the first start-over
-- wins and the second is refused. Every frame records the generation it was
-- ordered in, and a frame that claims a generation other than the current
-- one is refused.
--
-- 0 is every conversation from before this, and a conversation whose group
-- has not been founded yet; a group's founding is its first start-over.
ALTER TABLE conversations ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dm_messages ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
