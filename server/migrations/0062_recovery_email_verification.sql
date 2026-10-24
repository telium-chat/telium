-- Recovery addresses that have proved they are reachable, and the machinery
-- that keeps the proof honest.
--
-- Before this migration the account's recovery address was one nullable column
-- on `accounts`, written from a settings field and read straight back out as a
-- destination for security mail. That is the shape of the bug: nothing in the
-- schema, the types or the queries distinguished "a string somebody typed"
-- from "a mailbox that answered and said it wanted this account's mail". The
-- distinction only existed as a convention in the head of whoever last read
-- the code, and a convention is not a boundary. Two attacks live in that gap.
-- The first is a typo: mail meant to warn an account that it is being stolen
-- goes to a stranger, who now holds a one-use link that cancels the move --
-- or, worse, does not use it, and the real owner is never warned at all. The
-- second is deliberate: an attacker with a five-minute hold on a session types
-- their own address, and every future warning about the account goes to them.
--
-- So the address is split in two here, and the split is the whole point.
-- `verified_email` is the only thing any security-mail path is allowed to send
-- to; `pending_email` is a claim that has not been proved yet and is a
-- destination for exactly one kind of message, the challenge that would prove
-- it. Code that wants a destination asks for the verified one, and the Rust
-- side wraps it in a type (`mail::VerifiedAddress`) that has no constructor
-- except the query below, so a future caller cannot reach a destination by
-- remembering to be careful.
CREATE TABLE recovery_addresses (
    user_id        TEXT PRIMARY KEY,

    -- The address that answered a challenge for this account. NULL means this
    -- account has no recovery path, whatever else is in this row.
    verified_email TEXT,
    verified_at    INTEGER,

    -- A claim awaiting proof. Deliberately a separate column and not a state
    -- flag on one address: while a new address is pending, the old verified
    -- one is still the account's recovery path and still receives every
    -- security notice, including the notice that a replacement was requested.
    --
    -- Silently switching on `PUT` is how a five-minute session hijack becomes
    -- permanent: the attacker sets their address, the real owner's mailbox
    -- goes quiet, and nothing that happens afterwards -- the move request, the
    -- password change, the warning about either -- reaches the person who owns
    -- the account. Holding the old address until the new one proves itself
    -- means the takeover has to survive a message landing in the victim's
    -- inbox saying exactly what is being attempted, with a link to stop it.
    pending_email  TEXT,
    pending_since  INTEGER,

    -- A hard bounce on a verified address is not a delivery hiccup; it is the
    -- recovery path ceasing to exist. The address is cleared from
    -- `verified_email` when this is set, and these two columns are what the
    -- client reads to say so, because the account holder has to learn about it
    -- through a channel that still works -- the gateway and push, not the
    -- mailbox that just refused the message.
    bounced_at     INTEGER,
    bounce_reason  TEXT
);

-- Existing addresses are carried across as *pending*, not as verified.
--
-- Not a conservatism: none of them was ever proved. Importing them as verified
-- would mean this migration asserts something no mailbox ever said, and would
-- preserve exactly the state the split exists to abolish -- with the schema
-- now claiming the opposite. Accounts that had an address keep it visible in
-- settings and are asked to confirm it; until they do, the server behaves as
-- if they have no recovery address, which is the truth.
INSERT INTO recovery_addresses (user_id, pending_email, pending_since)
SELECT user_id, recovery_email, 0 FROM accounts
WHERE recovery_email IS NOT NULL AND recovery_email <> '';

-- And the old column goes, rather than being left as a second place the answer
-- might be. A column that still exists is a column a future query will read.
ALTER TABLE accounts DROP COLUMN recovery_email;

-- The scoped one-time challenges that mail carries.
--
-- The token itself is random and lives only in the message; what is kept here
-- is its hash, so a copy of this database is not a pile of live links. Every
-- row names exactly one account, one address and one `purpose`, and spending
-- it is a single conditional UPDATE on `used_at`, so a link works once however
-- many times it is presented and however many copies of the mail exist.
--
-- `purpose` is the scope, and it is narrow on purpose:
--
--   `verify`  proves the address is reachable and binds it to this account as
--             a recovery destination. It is not a session. It returns no
--             token, reveals nothing the mail did not already contain, and
--             cannot change a password, disable MFA, or read a message.
--   `disown`  is the other half, and is for the person who never asked for any
--             of this. It is carried in the same message and detaches the
--             address from the account without the holder needing an account
--             of their own. Without it, anybody who knows a stranger's address
--             can point an account at it and make this homeserver mail them
--             indefinitely.
--
-- A link that signs its holder in would be a bearer credential sitting in a
-- mail provider's logs, in every forwarding rule between here and the mailbox,
-- and in the browser history of whoever clicked it. These two do one named
-- thing each and are gone afterwards.
CREATE TABLE recovery_email_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    email      TEXT NOT NULL,
    purpose    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);
CREATE INDEX recovery_email_challenges_user ON recovery_email_challenges (user_id);
CREATE INDEX recovery_email_challenges_expiry ON recovery_email_challenges (expires_at);

-- Every security message this server tried to send, by destination.
--
-- The destination is stored as a hash rather than as the address. The ledger's
-- only job is to answer "how many have gone to this mailbox lately", which a
-- hash answers exactly as well, and a table of plaintext addresses paired with
-- account ids is a correlation list worth stealing on its own -- including for
-- the addresses of people who never signed up here.
--
-- The counting matters in both directions, and the outward direction matters
-- more. A per-account limit stops one account exhausting the operator's mail
-- budget. A per-destination limit is what stops this homeserver being pointed
-- at somebody who does not have an account here: without it, anyone who can
-- reach the settings route can make a stranger's mailbox receive a message
-- from this domain on demand, which is a harassment tool and a way to burn the
-- operator's sending reputation. The third limit is the whole server's, which
-- is the blunt backstop for the case where the first two are being walked
-- around with many accounts and many destinations at once.
CREATE TABLE mail_sends (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    destination_hash TEXT NOT NULL,
    user_id          TEXT,
    purpose          TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    -- `sent`, `failed` (every retry used up) or `refused` (the mailer answered
    -- with something permanent and retrying would only repeat it).
    state            TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT
);
CREATE INDEX mail_sends_destination ON mail_sends (destination_hash, created_at);
CREATE INDEX mail_sends_user ON mail_sends (user_id, created_at);
CREATE INDEX mail_sends_created ON mail_sends (created_at);

-- Mailboxes this server will not send to, whatever any account asks.
--
-- Two things land here. A hard bounce, because a mailbox that has told us it
-- does not exist will say so again, and continuing to mail it is how a sender
-- loses its reputation with the receiving provider -- which would take every
-- other account's security mail down with it. And a `disown`, because somebody
-- said this address is not theirs to be mailed at; honouring that for a
-- cooling-off period is the difference between an unsubscribe link and a
-- gesture. The suppression is by destination hash, so it holds across accounts
-- -- an attacker cannot walk around it by pointing a second account at the
-- same victim, which is the entire point of suppressing the destination rather
-- than the sender.
--
-- The window is finite, and deliberately so even for a hard bounce. A mailbox
-- can come back: a lapsed domain gets renewed, a provider fixes a
-- misconfiguration, a typo'd address is corrected to the same string that
-- bounced last year for somebody else. An indefinite suppression would also be
-- self-sealing, because the only message that could ever prove the mailbox
-- works again is the verification challenge, and that message would itself be
-- suppressed. So the block expires and a fresh verification may be attempted
-- afterwards -- if it bounces again, it lands back here for another window.
CREATE TABLE mail_suppressions (
    destination_hash TEXT PRIMARY KEY,
    reason           TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL
);
CREATE INDEX mail_suppressions_expiry ON mail_suppressions (expires_at);
