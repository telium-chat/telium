-- A group chat that outgrew itself points at the guild it became. The chat's
-- history stays where it is and stays encrypted: a guild cannot inherit it,
-- because nobody but the members ever had the keys.
ALTER TABLE conversations ADD COLUMN promoted_to TEXT;
ALTER TABLE conversations ADD COLUMN promoted_at INTEGER;
