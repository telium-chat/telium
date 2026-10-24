-- A migration whose destination is merely unreachable is not a failed one: `run`
-- records the reason and leaves the row `ready`, still due, because nothing has
-- been sent. Ten of those are permanently the ten oldest, so a sweep that takes
-- the ten oldest hands them every tick forever and never reaches anything opened
-- afterwards. One account with ten guilds and an unreachable destination was
-- enough to wedge the sweep for the whole server.
--
-- `deferred_until` is when this row is next worth attempting, and `defer_count`
-- is how many times running it has asked to wait -- which is what makes the wait
-- grow. Only the sweep reads them; `POST /migrate/{id}/execute` is a person
-- asking now and is not held back by either.
ALTER TABLE migrations ADD COLUMN deferred_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migrations ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0;

-- The sweep's own query, which until now was a full scan and a temp B-tree sort
-- on every tick. `executes_at` before `deferred_until` because the query wants
-- the ten oldest and `executes_at` is what orders them: leading with the
-- back-off would trade the sort back in. `deferred_until` rides along last so
-- the rows that asked to wait are recognised and skipped from the index alone,
-- without reading each one to find out.
CREATE INDEX migrations_due ON migrations (state, executes_at, deferred_until);
