-- Re-anchoring as a signed handoff (docs/federation.md, "Re-anchoring").
--
-- Moving a conversation's sequencer used to be one server telling another
-- "you order this now", with nothing to say where the old order stopped:
-- member homes kept the old sequencer, refused the new one's deliveries, and
-- the two could hand out the same sequence number. A handoff is now a
-- document the old sequencer signs, naming the conversation, both servers,
-- the last sequence number it ordered and the epoch it was at. It freezes
-- before it signs, so nothing is ordered after `last_seq` anywhere but the
-- new sequencer, and every member home that moves keeps the document it
-- moved on, so it can show it to a home that has not heard yet.
--
-- `n` counts the handoffs of one conversation: each is the previous one's
-- plus one, and a home refuses a handoff no newer than the newest it holds,
-- which is what stops an old one being replayed to move the order back.
CREATE TABLE dm_handoffs (
    conversation_id TEXT NOT NULL,
    n               INTEGER NOT NULL,
    from_server     TEXT NOT NULL,
    to_server       TEXT NOT NULL,
    last_seq        INTEGER NOT NULL,
    epoch           INTEGER NOT NULL,
    document        TEXT NOT NULL,       -- the signed handoff, as signed
    received_at     INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, n)
);
