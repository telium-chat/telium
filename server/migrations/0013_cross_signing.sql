-- Cross-signing and device verification (plan Sections 8 and 15).
--
-- The signed device list of Section 3 makes the homeserver the root of device
-- trust, which is exactly the dependency Section 15 wants a way out of. An
-- account holds one cross-signing key; it signs its own devices, and it signs
-- other people once they have compared emoji. Every signature below is made by
-- a key this server never sees in the clear, so the rows are evidence a client
-- checks rather than a claim a client takes on trust.

-- The MLS leaf signature key is what the cross-signature covers: it is the key
-- that actually appears in a conversation's ratchet tree, so a client can check
-- a signature against the group it is in rather than against this table.
ALTER TABLE devices ADD COLUMN mls_key TEXT;
ALTER TABLE devices ADD COLUMN cross_sig TEXT;

-- One key per account. The secret half arrives sealed under the account
-- recovery key (the same vault key as Section 8's message history), so an
-- escrowed account inherits escrow's weaker promise and a self-custody account
-- keeps the homeserver out of it entirely.
CREATE TABLE cross_signing (
    user_id       TEXT PRIMARY KEY,
    identity_key  TEXT NOT NULL,          -- Ed25519 public, base64
    sealed_secret TEXT NOT NULL,          -- vault-sealed secret half
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- Who I have verified. Never served to anyone but the signer: who trusts whom
-- is social graph, and publishing it would hand every homeserver a map of it.
CREATE TABLE user_signatures (
    signer      TEXT NOT NULL,
    subject     TEXT NOT NULL,
    subject_key TEXT NOT NULL,            -- their identity key at signing time
    signature   TEXT NOT NULL,
    signed_at   INTEGER NOT NULL,
    PRIMARY KEY (signer, subject)
);
