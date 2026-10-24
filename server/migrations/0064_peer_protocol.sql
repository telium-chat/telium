-- What each federation peer said about the protocol version it speaks.
--
-- Until now a peer's compatibility was not a fact anybody held. It was
-- rediscovered on every request, by the request failing, and the failure looked
-- exactly like a peer being slow or down -- which is why the symptom an operator
-- actually reports is "messages from example.org stopped arriving" and the cause
-- is invisible from every screen this server has. A version skew and an outage
-- want opposite responses (wait, versus tell the other operator to upgrade), and
-- a system that cannot tell them apart gives the wrong advice half the time.
--
-- So the window each peer advertises is written down where it is discovered, on
-- the row this server already keeps for that peer, and the operator surfaces
-- read it from here rather than probing. That also means the answer survives the
-- peer going away: a server that has become unreachable *because* it is on an
-- abandoned protocol version can still be reported as incompatible rather than
-- merely silent, which is the case where knowing the difference matters most.
--
-- Every column is nullable and every existing row gets NULL, which must be read
-- as "not yet observed" and never as "incompatible". That distinction is load
-- bearing in both directions: a peer this server has never spoken to must not be
-- shown as broken, and a peer whose absence of an advertisement means it
-- predates the advertisement must be treated as old-but-fine -- see
-- `PeerCompat::legacy` in `telium-protocol/src/compat.rs`, which is the single
-- definition of what silence means.
ALTER TABLE remote_servers ADD COLUMN protocol_version INTEGER;

-- The oldest version the peer still accepts. Stored beside the newest because
-- one number cannot express a window, and a receiver that only learns the peer's
-- maximum cannot tell "older than me but still fine" from "older than me and
-- about to misread everything I say".
ALTER TABLE remote_servers ADD COLUMN protocol_min_supported INTEGER;

-- The peer's capability tokens, comma separated, exactly as advertised --
-- including tokens this build has never heard of. Kept verbatim rather than
-- filtered through this build's own list because this build's list is not the
-- universe of capabilities, and a newer peer's unknown tokens are precisely what
-- an operator staring at a compatibility screen wants to see. Bounded on the way
-- in (`compat::parse_capabilities`), since it arrives from a peer.
ALTER TABLE remote_servers ADD COLUMN capabilities TEXT;

-- The negotiation result, as one of `compat::Incompatibility::code()`'s stable
-- strings or 'ok'. Denormalised on purpose: it is recomputed from the two
-- version columns every time they are written, and storing it means an operator
-- listing five hundred peers does not re-run the negotiation five hundred times
-- in the request that renders the table.
ALTER TABLE remote_servers ADD COLUMN compat_status TEXT;

-- When the four columns above were last written, which is to say when this
-- server last learned something it did not already know about this peer -- not
-- when it last heard from it. The recording path reads before it writes and
-- writes only on a change, because SQLite has one writer and a statement that
-- runs on every inbound federation request would put every inbound federation
-- request behind whatever is writing at the time, which during an import is a
-- whole guild's worth of rows. A peer's protocol window changes when somebody
-- upgrades a server, so news is rare and this timestamp is close to still.
--
-- That is also the more useful of the two possible meanings. "Seven months ago"
-- answers "when did this peer become incompatible"; a timestamp refreshed by
-- every heartbeat would answer only "is the network up", which this server has
-- better ways to ask.
ALTER TABLE remote_servers ADD COLUMN compat_checked_at INTEGER;
