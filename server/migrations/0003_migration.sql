-- Claims created at a *destination* server: "I am expecting an import for this
-- account". They are what stops anyone with a signature from pushing a bundle
-- at a server that never agreed to receive it (Section 10).
CREATE TABLE import_claims (
    token_hash   TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,             -- user | guild
    source       TEXT NOT NULL,             -- the server we expect it from
    source_id    TEXT NOT NULL,             -- the id being moved
    target_id    TEXT NOT NULL,             -- the local account receiving it
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    used_at      INTEGER
);
CREATE INDEX import_claims_target ON import_claims (target_id);

-- Import receipts, so a repeated push is idempotent rather than a duplicate.
CREATE TABLE import_log (
    id          TEXT PRIMARY KEY,           -- the source's migration id
    subject_type TEXT NOT NULL,
    source      TEXT NOT NULL,
    source_id   TEXT NOT NULL,
    new_id      TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    ack         TEXT NOT NULL
);
