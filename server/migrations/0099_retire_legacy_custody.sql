-- Phase 4 of the key-custody design: the legacy custody modes are refused and their key material is withdrawn.
--
-- Every row in a retired state is archived, whole, before anything about it changes: a vault whose mode is not
-- `opaque_custody` (its `ciphertext` is the sealed ring, which a client's "start a new vault" later overwrites), a row
-- holding an escrow key, and a row holding a passphrase copy.
--
-- What is withdrawn, per row of `key_vault`:
--   * `escrow_key`, the key the server held for an `escrowed` vault. Nothing reads it any more (the client refuses
--     escrowed vaults), and a server that holds a usable key for a user's history is what the design removes.
--   * a PBKDF2 passphrase copy in `independent_ciphertext` (`p2.` or the unprefixed self-custody form). Only the
--     `k1.` recovery-key copy is kept.
--
-- This is the one step in the phase that removes key material, so it is reversible: every row it touches is copied,
-- whole, into `key_vault_legacy_archive` first, and nothing else is deleted (no `key_vault` row, no column). The
-- archive is read by nothing. It is removed by erasing the account, and an operator who has confirmed no account
-- still needs it can `DROP TABLE key_vault_legacy_archive` in a later migration.
--
-- A vault that lands in a retired mode after this migration (an account import) is archived by the server the first
-- time a write would replace it, so the old row is never overwritten without a copy.
--
-- To put one account back exactly as it was (mode, ciphertext, escrow key and passphrase copy; the version is bumped, so
-- a client that read the vault since re-reads it):
--
--   UPDATE key_vault SET
--     mode = (SELECT mode FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id),
--     ciphertext = (SELECT ciphertext FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id),
--     escrow_key = (SELECT escrow_key FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id),
--     independent_ciphertext = (SELECT independent_ciphertext FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id),
--     version = version + 1
--   WHERE user_id = '<the account>' AND EXISTS (SELECT 1 FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id);
--
-- The vault `mode` is left as it was by this migration: a vault still in a retired mode is read as locked by the client,
-- and is converted to `opaque_custody` only by a device that still holds its keys, or replaced on purpose.
CREATE TABLE key_vault_legacy_archive (
    user_id                TEXT PRIMARY KEY,
    mode                   TEXT NOT NULL,
    ciphertext             TEXT NOT NULL,
    escrow_key             TEXT,
    independent_ciphertext TEXT,
    version                INTEGER NOT NULL,
    archived_at            INTEGER NOT NULL
);

INSERT INTO key_vault_legacy_archive
    (user_id, mode, ciphertext, escrow_key, independent_ciphertext, version, archived_at)
SELECT user_id, mode, ciphertext, escrow_key, independent_ciphertext, version,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM key_vault
WHERE mode <> 'opaque_custody'
   OR escrow_key IS NOT NULL
   OR (independent_ciphertext IS NOT NULL AND independent_ciphertext NOT LIKE 'k1.%');

UPDATE key_vault SET escrow_key = NULL WHERE escrow_key IS NOT NULL;

UPDATE key_vault SET independent_ciphertext = NULL
WHERE independent_ciphertext IS NOT NULL AND independent_ciphertext NOT LIKE 'k1.%';
