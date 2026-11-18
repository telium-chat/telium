-- An invite minted from inside a voice call lives only as long as the call: the server deletes it when the
-- channel empties. `expires_at` is the backstop for a call that never ends cleanly.
ALTER TABLE invites ADD COLUMN call_channel INTEGER NOT NULL DEFAULT 0;
