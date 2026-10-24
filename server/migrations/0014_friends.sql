-- The friends list (plan Sections 3 and 8).
--
-- A friendship is two rows on two servers, not one row anywhere. Each home
-- server holds its own account's half and is the only authority over it, which
-- is the same shape `conversation_members` has and for the same reason: there
-- is no cross-server transaction to make a single shared row consistent, and
-- inventing one would make every friendship depend on both servers being up at
-- the same instant.
--
-- Directed rows also give blocking somewhere to live. A block is a statement
-- one account makes about another; the other side is told the friendship ended
-- and nothing more, so `blocked` never appears on the blocked person's server.

CREATE TABLE friends (
    user_id     TEXT NOT NULL,        -- always an account of ours
    peer_id     TEXT NOT NULL,
    peer_domain TEXT NOT NULL,        -- denormalised so routing is not a parse
    -- pending_out is a request we sent, pending_in one we received. Keeping the
    -- direction in the state rather than in a separate column is what makes the
    -- "they already asked me" case a lookup instead of a search.
    state       TEXT NOT NULL,        -- pending_out | pending_in | accepted | blocked
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, peer_id)
);
CREATE INDEX friends_by_state ON friends (user_id, state);
-- Presence fans out to whoever has this account as a friend, which is the
-- reverse direction and the only query that needs it.
CREATE INDEX friends_by_peer ON friends (peer_id, state);

-- Store-and-forward for the signed half, on the same terms as `dm_outbox`: a
-- homeserver that is down delays an accept rather than losing it. Presence is
-- deliberately not queued -- it is a fact with a short shelf life, and a stale
-- one redelivered an hour later is worse than none.
--
-- `pair` is what keeps a slow peer from being told the past. Every relay states
-- the whole new relation rather than a delta, so a newer one for the same pair
-- replaces whatever is still queued for it; without that, a request that failed
-- and a cancel that succeeded could land in the opposite order and leave a
-- phantom request the sender has no row for any more.
CREATE TABLE friend_outbox (
    id              TEXT PRIMARY KEY,
    destination     TEXT NOT NULL,
    pair            TEXT NOT NULL,        -- "<from>|<to>"
    payload         TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    created_at      INTEGER NOT NULL
);
CREATE INDEX friend_outbox_due ON friend_outbox (next_attempt_at);
CREATE INDEX friend_outbox_pair ON friend_outbox (destination, pair);
