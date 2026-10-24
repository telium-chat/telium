-- Web Push (RFC 8291/8292). A browser subscription is three values, not one:
-- the endpoint to POST to, the user agent's P-256 public key, and a 16-byte
-- auth secret. The payload is encrypted to that key before it leaves here, so
-- the push service moves a sealed box it cannot open.
ALTER TABLE push_subscriptions ADD COLUMN p256dh TEXT;

-- The VAPID identity. One keypair per server, generated on first use: it is how
-- a push service knows successive requests come from the same sender, and it is
-- the key a browser pins at subscribe time.
CREATE TABLE vapid_key (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    secret_b64 TEXT NOT NULL,
    public_b64 TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
