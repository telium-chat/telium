-- Remember that somebody asked to verify somebody else, so that asking twice
-- is a thing the server can refuse and a thing the client can draw.
--
-- The verification handshake in `routes/dm.rs` is a relay and nothing else:
-- it reads the routing, forwards the frame and stores not one byte of it.
-- That is the right shape for the steps *inside* a handshake, whose whole
-- security argument is that neither server can usefully touch them. It is the
-- wrong shape for the first step, because the first step is not part of a
-- conversation two people are already having -- it *starts* one, by opening a
-- modal dialog on a stranger's screen. A frame that interrupts somebody is a
-- frame somebody can be interrupted with repeatedly, and a stateless relay has
-- no way to know it is being used that way.
--
-- So exactly one fact is kept, and it is the smallest one that makes the rule
-- enforceable: who asked whom, and when. Not the payload, not the public key
-- in it, not the transaction id -- none of those are needed to answer "has
-- this person already asked, and how long ago", and each of them would be a
-- piece of a handshake sitting in a table on a server that has no business
-- holding it.
--
-- The row lives on the *requester's* home server, which is the one place both
-- ends of the answer arrive: the outgoing `start` passes through it, and so
-- does the peer's eventual `accept` on its way back, whether the peer is local
-- or federated. Putting it on the subject's side instead would have made a
-- request to a remote account unenforceable -- their server would have had to
-- take our word for who had asked, which is exactly the claim a spammer
-- controls.
--
-- `(requester, subject)` is the key rather than a log of attempts, because the
-- question asked of this table is always about the latest one. A history of
-- refused attempts would be a record of a thing that did not happen, kept
-- about a person, growing without bound, and answering no question the product
-- has. The upsert in `relay_verification` moves the timestamp forward on a
-- successful ask and on nothing else.
--
-- Rows are deleted rather than expired in place: `deliver_verification` drops
-- one when the peer actually answers, and a stale row -- asked, never
-- answered, window elapsed -- is swept the next time its requester asks
-- anything. There is no background job, because a table whose only reader
-- filters by `requested_at` anyway cannot be embarrassed by a leftover row; it
-- can only be made very slightly larger by one.

CREATE TABLE verification_requests (
    requester    TEXT    NOT NULL,
    subject      TEXT    NOT NULL,
    requested_at INTEGER NOT NULL,
    PRIMARY KEY (requester, subject)
);

-- The sweep and the client's "what am I still waiting on" both ask for one
-- requester's rows in time order, and the primary key orders by subject.
CREATE INDEX verification_requests_by_age
    ON verification_requests (requester, requested_at);
