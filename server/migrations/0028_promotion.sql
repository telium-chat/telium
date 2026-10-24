-- Warm standby, the promotion half (Section 10).
--
-- 0022 gave a standby somewhere to put what it is told. This is what happens
-- when the server telling it stops: the copy becomes the original, and the
-- original -- whenever it wakes up -- has to be able to find that out and
-- agree.
--
-- The record is kept beside the copy rather than inside it. A promotion is a
-- statement this server made about somebody else's data, and it has to survive
-- the copy being re-bootstrapped from a snapshot.

-- The signed promotion record this standby published for the origin, chained
-- onto the authorisation the primary co-signed while it was healthy. Null until
-- an operator promotes; `replica_state.promoted` and `.sequence` were already
-- there waiting for it.
ALTER TABLE replica_state ADD COLUMN record TEXT;
ALTER TABLE replica_state ADD COLUMN promoted_at INTEGER;
