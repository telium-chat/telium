-- `ExpectingABundle` asks this table on every federation request that wants the
-- larger body ceiling, and it asks before the signature has been checked. A
-- question an unverified caller can make this server answer is a question worth
-- answering from an index rather than from a scan of the whole table.
CREATE INDEX IF NOT EXISTS idx_import_claims_source ON import_claims(source);
