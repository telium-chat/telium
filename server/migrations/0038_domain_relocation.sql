-- Domain relocation (docs/relocation.md).
--
-- A server that moves to a new domain keeps its database, its accounts and its
-- credentials; what changes is the name. The signed relocation record is what
-- lets everybody else believe the new name speaks for the old one.

-- Which name a signing key belongs to. NULL is "whatever this server is called
-- now", which is every key that existed before this migration. A successor key
-- minted for an announced relocation carries the new domain until the rename
-- happens; after it, the keys that signed for the old name carry the old one.
ALTER TABLE server_keys ADD COLUMN domain TEXT;

-- OPAQUE mixes the credential identifier into the per-user OPRF key, so an
-- account renamed by a relocation has to keep presenting the identifier it
-- enrolled under or its password stops working. NULL means the user id.
ALTER TABLE accounts ADD COLUMN opaque_identifier TEXT;

-- Every relocation this server knows about: its own (`local` = 1, where
-- `old_domain` is a name this server used to have, or has until the rename)
-- and those it learned from peers.
--
-- `announced`: the record verified against the old domain's key, but the new
-- domain has not yet published the successor key under its own name.
-- `applied`: it has, and every reference here now names the new domain.
CREATE TABLE domain_relocations (
    old_domain   TEXT PRIMARY KEY,
    new_domain   TEXT NOT NULL,
    record       TEXT NOT NULL,
    state        TEXT NOT NULL,
    local        INTEGER NOT NULL DEFAULT 0,
    effective_at INTEGER NOT NULL,
    learned_at   INTEGER NOT NULL,
    checked_at   INTEGER NOT NULL DEFAULT 0,
    applied_at   INTEGER
);

-- Who has been told about this server's own relocation. A peer that was down
-- when it was announced is told when it comes back, on the same terms as a
-- DM that could not be delivered.
CREATE TABLE relocation_deliveries (
    old_domain   TEXT NOT NULL,
    peer         TEXT NOT NULL,
    stage        TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    next_at      INTEGER NOT NULL,
    delivered_at INTEGER,
    last_error   TEXT,
    PRIMARY KEY (old_domain, peer, stage)
);
