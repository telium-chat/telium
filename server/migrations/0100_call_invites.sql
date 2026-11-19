-- The invite minted from inside a voice call lives only as long as the call: the server deletes it when the
-- channel empties. This names which invite belongs to which call (one per channel); it is bookkeeping, not
-- guild data, so it sits beside `invites` rather than adding a column that every exported guild would carry.
-- `invites.expires_at` is the backstop for a call that never ends cleanly.
CREATE TABLE call_invites (
    channel_id TEXT PRIMARY KEY,
    code       TEXT NOT NULL
);
