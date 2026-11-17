-- Phase 4 of the key-custody design: the legacy custody modes are refused and their key material is withdrawn.
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
-- still needs it can `DROP TABLE key_vault_legacy_archive` in a later migration. To put one account back:
--
--   UPDATE key_vault SET
--     escrow_key = (SELECT escrow_key FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id),
--     independent_ciphertext = COALESCE(
--       (SELECT independent_ciphertext FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id),
--       independent_ciphertext)
--   WHERE user_id = '<the account>' AND EXISTS (SELECT 1 FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id);
--
-- (that restores the withdrawn columns only; if the vault itself was rewritten since, restore `mode` and `ciphertext`
-- from the archive row too). The vault `mode` is left as it was: a vault still in a retired mode is read as locked by
-- the client, and is converted to `opaque_custody` only by a device that still holds its keys.
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
WHERE escrow_key IS NOT NULL
   OR (independent_ciphertext IS NOT NULL AND independent_ciphertext NOT LIKE 'k1.%');

UPDATE key_vault SET escrow_key = NULL WHERE escrow_key IS NOT NULL;

UPDATE key_vault SET independent_ciphertext = NULL
WHERE independent_ciphertext IS NOT NULL AND independent_ciphertext NOT LIKE 'k1.%';
