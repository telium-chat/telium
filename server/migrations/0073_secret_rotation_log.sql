-- When a long-lived secret was replaced, and on whose word (docs/secrets.md).
--
-- `server_audit_log` already records what administrators do through the
-- console, and it is the right table for that. It is the wrong table for this,
-- for two reasons that only became visible once somebody tried.
--
-- The first is that a rotation is frequently not a request. `telium-server
-- keys rotate` is a process somebody started on a box; a backup-key rotation
-- is three lines of TOML and a restart. Neither has a session, an account, or
-- anything the `actor` column of an audit log is defined to hold -- that
-- column means "the administrator's user_id", and writing a Unix username into
-- it would make every reader of that table believe somebody authenticated when
-- nobody did. A column that looks like an identity and is not one is worse
-- than no column, because it is trusted at exactly the moment it should not
-- be: during the incident where the question is who did this.
--
-- The second is that the two tables answer different questions over different
-- spans. The audit log is a stream an operator scrolls during the week
-- something happened. This is a small, permanent, one-row-per-event record
-- that has to still be here in four years, because "when did we last rotate
-- the backup key" is a question asked once a year by somebody who was not
-- there the last time. Retention that is right for one is wrong for the other.
--
-- So: its own table, with the strength of the actor claim stored *beside* the
-- actor rather than implied by it.

CREATE TABLE secret_rotations (
    id              TEXT    PRIMARY KEY,  -- ulid(); sorts by time
    -- Which entry in `secrets::INVENTORY` this was, by its heading. A name
    -- from a list the tests hold to the tree, not free text: "the backup key"
    -- and "backup encryption key" and "backup.key_file" are the same rotation
    -- written three ways, and a log you cannot group by is a log you cannot
    -- answer "when did we last" from. `rotations::record` takes a
    -- `&'static SecretEntry`, so an entry that is not in the inventory cannot
    -- be written here at all.
    inventory_entry TEXT    NOT NULL,
    -- Who, as a sentence: '67plays (uid 1000)', 'tape@bastion', '@ops:x.test',
    -- 'nobody -- noticed at startup'. Rendered rather than structured because
    -- every structure that fitted one basis was wrong for another, and the
    -- next column is the part a reader must not skip.
    actor           TEXT    NOT NULL,
    -- How much the line above is worth. One of a closed set -- see
    -- `rotations::Basis` -- ordered from weakest to strongest:
    --
    --   'asserted'      somebody typed --operator on a command line. It is a
    --                   label, not a claim anything checked, and anyone who
    --                   can run the command can type any name they like.
    --   'local-process' the uid, login name and SUDO_USER the kernel reported
    --                   for the process. Not forgeable by somebody who is not
    --                   that uid -- and bounding nothing, because a uid that
    --                   can rotate a key can also write this table.
    --   'authenticated' an account that presented a credential to this server
    --                   and passed the administrator check for the route.
    --   'observed'      nobody claimed anything. The server noticed the change
    --                   itself and is recording that it happened, not who did
    --                   it.
    --
    -- Stored, not derived, because it has to survive the day somebody adds a
    -- fifth basis: a reader in 2029 must be able to see that a row written in
    -- 2026 was only ever as good as a command-line flag.
    actor_basis     TEXT    NOT NULL,
    -- Facts about the process or session that wrote the row, as JSON: uid,
    -- login name, SUDO_USER, hostname, pid. Evidence, kept separately from
    -- `actor` so that the rendered sentence stays readable and the raw
    -- material stays checkable against `last`, `auth.log` and the shell
    -- history this table exists to replace.
    actor_evidence  TEXT    NOT NULL DEFAULT '{}',
    -- What happened, as JSON, built field by field from a fixed set of keys --
    -- never by serialising whatever the caller had to hand.
    --
    -- **Nothing in here may be derived from the value of any key**: not the
    -- key, not a hash of it, not a prefix, not a length that pins down a
    -- format, not a key id that a holder of a candidate key could recompute.
    -- This table is in the database, the database is in every backup, and a
    -- database that confirms guesses about the contents of a key file has
    -- handed an attacker the file. Public key ids -- the ones already
    -- published to every peer at /_telium/v1/server/keys -- are the one
    -- exception and are marked as such where they are written.
    detail          TEXT    NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL
);

-- The two reads there are: the whole log newest-first, and one secret's
-- history. Both are (filter, id DESC) so neither sorts.
CREATE INDEX secret_rotations_recent ON secret_rotations (id DESC);
CREATE INDEX secret_rotations_entry ON secret_rotations (inventory_entry, id DESC);

-- ---------------------------------------------------------------- the witness

-- What the key files looked like the last time this server started.
--
-- A backup-key rotation is not a command. The runbook's procedure is: mint a
-- file, edit two lines of `telium.toml`, restart. Nothing in that sequence
-- reaches any code that could write a row, which is why a rotation log that
-- covered only `telium-server keys rotate` would quietly claim coverage it did
-- not have -- and the secret it would be silent about is the one whose loss is
-- permanent.
--
-- The server can notice, but only if it remembers. This is the somewhere to
-- remember: one row per key file it used, written at every start, compared at
-- the next one. A path that has appeared, a path that has gone, or a file at
-- the same path whose size or mtime has moved is a rotation, and it is
-- recorded with basis 'observed' because nobody told us anything.
--
-- # Why size and mtime, and deliberately not a digest
--
-- A digest of the key would make the detection exact: any change to the bytes,
-- whatever the operator did to the metadata. It would also put, in the
-- database, a value against which a holder of the database can test candidate
-- backup keys offline -- and the backup key is precisely the secret that is
-- *not* in the database, the one whose whole security argument is that an
-- attacker with the archive set and the database still has nothing. Storing a
-- digest here would spend that argument to improve a convenience.
--
-- So: metadata only. What that buys is the rotation the runbook describes,
-- which changes the path, and the overwrite-in-place, which changes the mtime.
-- What it misses is an operator who replaces a key file and then restores its
-- timestamps and length -- `touch -r`, or a restore from an archive. That is a
-- real hole and it is written down rather than papered over, here and in
-- docs/secrets.md, because a coverage claim an operator over-reads is how a
-- gap becomes a surprise.
CREATE TABLE secret_file_witness (
    path        TEXT    PRIMARY KEY,   -- absolute where it could be resolved
    -- Which inventory entry's file this is, so a change can be recorded
    -- against the right secret without re-deriving it from the path.
    role        TEXT    NOT NULL,
    -- 'current' or 'retired': a file moving between the two is the shape of a
    -- backup-key rotation and is worth saying out loud in the record.
    standing    TEXT    NOT NULL,
    bytes       INTEGER NOT NULL,
    modified_at INTEGER,               -- ms; NULL where the platform had none
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
);
