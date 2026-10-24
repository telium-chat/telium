-- The client sync store holds sealed values (docs/sync-encryption.md). The
-- first sealed write stamps the account; from then on the store refuses
-- plaintext, so a client from before sealing cannot put a readable value back.
ALTER TABLE accounts ADD COLUMN sync_sealed_at INTEGER;
