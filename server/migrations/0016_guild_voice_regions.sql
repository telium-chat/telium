-- Section 7. Per-guild custom SFU regions. A guild owner (or a Manage Server
-- admin) can register SFU endpoints their guild — or specific voice channels —
-- may use, on top of the server's global voice pool. The SFU itself still
-- verifies the guild's signed join tokens, so adding a URL here is only half the
-- trust: a private SFU must also be told to accept this guild (a public SFU
-- discovers it by domain automatically).

CREATE TABLE guild_voice_regions (
    guild_id     TEXT NOT NULL,
    name         TEXT NOT NULL,
    sfu          TEXT NOT NULL,
    turn         TEXT,
    pubkey_hint  TEXT,
    is_default   INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (guild_id, name)
);
