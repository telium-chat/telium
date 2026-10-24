-- One direct message per pair of people, decided by the database instead of by
-- hope.
--
-- On the number: this was written as 0057 and is applied as 0075. It was built
-- on a branch while `0057_dm_notification_hints.sql` was being built on main,
-- both claimed the same version, and only one of them had already run against
-- released servers. The one that had keeps its number, because a version that
-- is already recorded in somebody's `_sqlx_migrations` cannot be reassigned
-- without every server that applied it refusing to start. Nothing here depends
-- on running early: it reads `conversations`, `conversation_members` and
-- `dm_messages`, all of which predate 0057, and nothing between 0058 and 0074
-- touches `dm_pairs` or rewrites what the backfill below reads.
--
-- What was wrong: `create_conversation` sorted the member list, deduped it,
-- checked that a `dm` had exactly two people in it, and then inserted a fresh
-- ULID unconditionally. Nothing anywhere said that a pair of people may only
-- have one DM. So two taps on "Message" -- a double click, two tabs, a phone
-- and a laptop open on the same profile, a retry after a slow network -- made
-- two conversations with identical membership, and from that moment on there
-- was no such thing as "the DM with Ana": messages split across the two at
-- random and which one a client landed in was whichever row its sidebar
-- happened to sort first. The client had a lookup that tried to prevent this,
-- and a lookup cannot: two requests both read "no DM yet" before either of
-- them writes one. That is true of a lookup on the client, and it is equally
-- true of a lookup in the handler. The only place the question can be settled
-- is inside a transaction, against a constraint, where the second writer is
-- told it lost.
--
-- Why a table and not a column. The obvious alternative is `conversations.
-- dm_key`, populated only for `kind = 'dm'`, with a partial unique index over
-- the rows where it is not null. It would work. It was rejected for three
-- reasons, in increasing order of importance:
--
--   1. The column would be null on every group chat, which is most of the
--      table on a busy server, and null-means-exempt is exactly the kind of
--      rule a future reader has to reconstruct from the index definition.
--   2. `conversations` is written by four different paths -- the create route,
--      the federated `upsert_conversation`, replication, and whatever arrives
--      next -- and a column obliges every one of them to remember what to put
--      in it. The honest failure mode of that design is a path that forgets
--      and silently stops deduplicating; the failure mode of this one is an
--      absent row, which the create path notices immediately.
--   3. A unique constraint that lives on `conversations` is a constraint every
--      writer of `conversations` must satisfy, and one of those writers is
--      federated delivery. A remote sequencer is perfectly entitled to hand us
--      a second DM between the same two people -- it may be running an older
--      build, its users may have hit this very bug before it was fixed, or the
--      pair may genuinely have one conversation sequenced at each end. If the
--      constraint sat on the row, accepting that delivery would mean a failed
--      INSERT, which means a 500 back to the sequencer, which means the
--      message is retried forever and eventually dropped. Trading a duplicate
--      sidebar row for lost messages is not a trade this project makes. With
--      the claim in its own table, a mirror stores and delivers exactly as it
--      always did; it simply does not get the slot.
--
-- So: `dm_pairs` holds one row per pair of people for whom this server knows a
-- live two-person conversation, and `pair` is the primary key. That primary
-- key is the whole fix. The create path inserts the claim inside the same
-- transaction as the conversation itself, and SQLite -- which admits one
-- writer at a time -- tells the second caller that the row is taken. The
-- loser then returns the winner's conversation with a 200, because "open a DM
-- with this person" is an idempotent request: the caller asked to be in a
-- conversation with somebody, there is one, and handing it to them is the
-- answer to the question they asked.
--
-- `pair` is the two user ids, sorted, joined with '|'. Sorted because the
-- identity of a DM must not depend on who pressed the button, and '|' because
-- it cannot occur in a user id this server will accept (`valid_localpart` is
-- [a-z0-9._-] and a domain is a hostname); `dm_pair_key` in routes/dm.rs
-- refuses to build a key from an id containing one rather than let a
-- hand-crafted federated id forge a collision with somebody else's pair.
--
-- `conversation_id` is unique as well, so the claim is a bijection: one pair,
-- one conversation, and "release this pair" is a delete by conversation id
-- with an index behind it. There is deliberately no foreign key, matching
-- `conversation_members`, which has none either -- the mirrored-database pool
-- runs with foreign keys off by design (see db.rs), so a key here would be
-- enforced in one deployment shape and not the other. The claim and the
-- conversation are written in one transaction; that, not a key, is what keeps
-- them together.
CREATE TABLE dm_pairs (
    pair            TEXT PRIMARY KEY,   -- '@ana:a.example|@ben:b.example', sorted
    conversation_id TEXT NOT NULL UNIQUE,
    claimed_at      INTEGER NOT NULL
);

-- The backfill, and the part an operator should read before applying this.
--
-- Any server that has been running the broken code may already hold two or
-- more DMs between the same two people, and a migration that assumed otherwise
-- would fail to apply on precisely the servers that need it. So the backfill
-- picks exactly one conversation per pair to hold the claim, and does nothing
-- whatsoever to the others.
--
-- It does not merge them. Merging is not "too much work", it is impossible
-- here and it is important to say why: every frame in a conversation is
-- ciphertext addressed to one MLS group. Two duplicate DMs are two different
-- groups with two different key schedules, and this server holds keys to
-- neither. Moving frames between them would produce a history that no member's
-- client can decrypt -- silently, and only discovered later, by someone
-- scrolling back to a wall of "unable to decrypt". A merge could only be done
-- by a client that holds both groups' keys, which makes it a client feature
-- and not a migration.
--
-- It does not delete them either. The loser is somebody's conversation: it has
-- their words in it, it is the only copy some of its members have, and a
-- migration is the worst possible place to destroy that -- it runs on startup,
-- unattended, with no undo and nobody watching.
--
-- Which one wins: the conversation that was most recently *used*, by the
-- timestamp of its newest frame; ties broken by the older `created_at`, and
-- then by id so the result is deterministic. "Newest activity" rather than
-- "oldest conversation" because the two rows are not equivalent to the people
-- in them -- one of them is where they have been talking, and after this
-- migration "message Ana" lands in whichever row holds the claim. Sending
-- someone to the empty twin of the conversation they were mid-sentence in
-- would be a strictly worse bug than the one being fixed. A pair whose
-- duplicates are both empty falls through to the oldest, which is the one any
-- client that sorted by creation was already showing.
--
-- What the operator loses, stated plainly: nothing is deleted, but the losing
-- conversations remain in the sidebar of every member who was in them, because
-- they are still real conversations with real membership rows and the DM list
-- is built from membership. This migration stops new duplicates; it does not
-- retroactively tidy the ones already made. The members can leave the stale
-- twin, which -- see `sync_dm_pair` -- is also how a pair is released for a
-- fresh conversation later.
--
-- Only conversations with exactly two members, both active, are claimed. A DM
-- somebody has already left is not a live conversation: its MLS group has
-- removed them and they cannot be let back in without a new group, so it must
-- not hold the pair hostage against a future "message Ana" that would then be
-- answered with a conversation nobody can read.
INSERT INTO dm_pairs (pair, conversation_id, claimed_at)
SELECT pair, id, created_at FROM (
    SELECT
        c.id AS id,
        c.created_at AS created_at,
        (SELECT MIN(m.user_id) || '|' || MAX(m.user_id)
           FROM conversation_members m WHERE m.conversation_id = c.id) AS pair,
        ROW_NUMBER() OVER (
            PARTITION BY (SELECT MIN(m.user_id) || '|' || MAX(m.user_id)
                            FROM conversation_members m WHERE m.conversation_id = c.id)
            ORDER BY (SELECT COALESCE(MAX(d.created_at), 0)
                        FROM dm_messages d WHERE d.conversation_id = c.id) DESC,
                     c.created_at ASC,
                     c.id ASC
        ) AS pick
    FROM conversations c
    WHERE c.kind = 'dm'
      AND (SELECT COUNT(*) FROM conversation_members m
             WHERE m.conversation_id = c.id) = 2
      AND (SELECT COUNT(*) FROM conversation_members m
             WHERE m.conversation_id = c.id AND m.state = 'active') = 2
)
WHERE pick = 1;
