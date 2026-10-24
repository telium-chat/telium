-- Forum channels: the parts a post list needs that a thread list did not.
--
-- A forum is a channel whose contents are posts rather than messages, and a
-- post is the thread this schema already has. What was missing is everything
-- around the post: the tags a guild defines for its forum and a post picks
-- from, the two orders a forum can be read in, and the handful of posts that
-- are held at the top regardless of either.
--
-- The tags live on the channel rather than in a table of their own because
-- they are a property of the forum in the way a topic is: there are at most a
-- few dozen, they are read on every open, and nothing ever queries across the
-- tags of two forums.
ALTER TABLE channels ADD COLUMN available_tags TEXT NOT NULL DEFAULT '[]';

-- How the forum opens. Both are defaults for the reader's first look, not
-- rules: the post list is sorted and laid out client-side after that, because
-- which order somebody wants to read in is theirs to change, per visit.
ALTER TABLE channels ADD COLUMN default_sort TEXT NOT NULL DEFAULT 'activity';
ALTER TABLE channels ADD COLUMN default_layout TEXT NOT NULL DEFAULT 'list';

-- Pinned posts sit above the sort. This is the forum's answer to a stickied
-- rules post, and it is deliberately a moderator's flag rather than the
-- author's: pinning is a claim on everybody else's screen.
ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
