-- The guided move for guilds (docs/migration.md, "The guided flow").
--
-- A handoff used to be for the account that opened it. A guild's owner opens
-- one for the guild, so the row now says what it moves as well as who opened
-- it: `user_id` stays the owner whose session opened the handoff and whose
-- `POST /migrate` has to spend it, and the subject is the account or the guild
-- the destination's claim has to name. Rows written before this are account
-- moves, whose subject is the account that opened them.
ALTER TABLE migration_handoffs ADD COLUMN subject_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE migration_handoffs ADD COLUMN subject_id TEXT NOT NULL DEFAULT '';
UPDATE migration_handoffs SET subject_id = user_id WHERE subject_id = '';
CREATE INDEX idx_migration_handoffs_subject ON migration_handoffs (subject_type, subject_id);
