-- Message requests are local inbox state around an ordinary encrypted DM.
-- They deliberately do not travel in the conversation descriptor: whether a
-- recipient accepted, declined, or blocked a stranger is their homeserver's
-- private fact, not federation metadata.
CREATE TABLE dm_message_requests (
    conversation_id TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    sender_id       TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('pending', 'declined', 'blocked')),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX dm_message_requests_user_state
    ON dm_message_requests (user_id, state, updated_at);

-- A request inbox should have at most one visible request from one identity.
-- The classifier also checks the conversation membership itself so a second DM
-- stays hidden after the first request was accepted or declined.
CREATE INDEX dm_message_requests_sender_state
    ON dm_message_requests (user_id, sender_id, state);
