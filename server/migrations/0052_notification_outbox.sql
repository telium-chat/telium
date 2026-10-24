-- Durable guild -> account-home notification delivery.
--
-- A notification decision is made by the authoritative guild server while it
-- still has the exact message snapshot. Store that bounded snapshot locally
-- before the first federation attempt so an unavailable account home delays a
-- notification instead of losing it. Retries fetch the recipient's current
-- notification keys and reseal the descriptor; plaintext never enters the
-- account home's queue.
CREATE TABLE notification_outbox (
    id              TEXT PRIMARY KEY,
    recipient_id    TEXT NOT NULL,
    destination     TEXT NOT NULL,
    guild_id        TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    kind            TEXT NOT NULL,
    payload         TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    UNIQUE(recipient_id, destination, guild_id, source_id, kind)
);

CREATE INDEX notification_outbox_due
    ON notification_outbox (next_attempt_at, created_at);
