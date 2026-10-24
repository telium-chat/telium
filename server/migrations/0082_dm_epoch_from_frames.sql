-- Re-derive each conversation's epoch from the frames it has ordered.
--
-- The sequencer now accepts a commit only if it claims exactly one epoch past
-- the stored one, and a Welcome at epoch 1 -- a group beginning -- sets the
-- stored epoch to 1. Under the old rule (any higher epoch) two kinds of
-- conversation were left with a stored epoch that does not match the group:
--
-- - One that has had no commit since it was created. The founding commit
--   lives inside the Welcome, which never moved the stored epoch, so the
--   server still holds 0 while the group is at 1, and its first commit would
--   claim 2.
-- - One that was started over. The new group is at epoch 1 or a little past
--   it, but the server still holds whatever the replaced group had reached,
--   and refused every commit the new group made.
--
-- The right value in both cases is the epoch of the newest commit or Welcome
-- the conversation has ordered: a refused commit was rolled back with its
-- frame, so every commit here was accepted, and a Welcome carries the epoch
-- of the group it lets somebody into. A conversation with no such frame keeps
-- what it has.
UPDATE conversations
SET epoch = (
    SELECT m.epoch FROM dm_messages m
    WHERE m.conversation_id = conversations.id AND m.kind IN ('commit', 'welcome')
    ORDER BY m.seq DESC LIMIT 1
)
WHERE EXISTS (
    SELECT 1 FROM dm_messages m
    WHERE m.conversation_id = conversations.id AND m.kind IN ('commit', 'welcome')
);
