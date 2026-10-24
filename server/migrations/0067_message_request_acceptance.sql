-- `accepted` joins the states a request may be in.
--
-- The CHECK constraint in 0066 lists three states and SQLite cannot alter a
-- CHECK in place, so widening it means building the table again -- which is
-- why this is a second file at all and not an edit to the first one. Editing
-- 0066 would be the smaller diff and the worse change: sqlx records a checksum
-- per applied migration and refuses to start against a file that has changed
-- since it ran, so any database that has already taken 0066 -- every developer
-- box this branch has been run on, and every staging server it is deployed to
-- between now and release -- would come up dead with a checksum mismatch and
-- no automatic way back. An applied migration is immutable; that is the whole
-- contract, and it is worth one table rebuild on a table that is empty on
-- every server that has not been running this branch.
--
-- Why `accepted` has to be stored at all, rather than inferred from the row
-- being gone: a deleted row is indistinguishable from a request that never
-- arrived, and the two need different answers. A stranger whose request was
-- accepted may message freely from then on; a stranger who has never written
-- before may not. See `request_policy` in routes/dm.rs, and `message_requests`
-- in migration.rs, which carries these decisions to the account's new home --
-- the reason they are durable rather than a UI affordance.

ALTER TABLE dm_message_requests RENAME TO dm_message_requests_v1;

CREATE TABLE dm_message_requests (
    conversation_id TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    sender_id       TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'declined', 'blocked')),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
);

INSERT INTO dm_message_requests
    (conversation_id, user_id, sender_id, state, created_at, updated_at)
SELECT conversation_id, user_id, sender_id, state, created_at, updated_at
FROM dm_message_requests_v1;

DROP TABLE dm_message_requests_v1;

CREATE INDEX dm_message_requests_user_state
    ON dm_message_requests (user_id, state, updated_at);

CREATE INDEX dm_message_requests_sender_state
    ON dm_message_requests (user_id, sender_id, state);
