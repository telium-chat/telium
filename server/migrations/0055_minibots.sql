-- Minibots: guild automations that run on the homeserver instead of behind a
-- socket.
--
-- The thing a guild admin actually wants is almost never a program. It is
-- "when somebody posts a link in #general and they do not have the Trusted
-- role, delete it and warn them once". Today that costs an admin a VPS, a bot
-- token, a process to keep alive, and a round trip across the internet for
-- every message in the guild -- for a rule that could have been decided in the
-- same transaction that wrote the message. A minibot is that rule, expressed as
-- data, evaluated in process.
--
-- The obvious way to build this is to let an admin write a script and run it
-- here. That is not what this is, and the difference is the entire security
-- position. A guild admin is not a trusted operator of this homeserver: they
-- are a customer of it, and on a server hosting ten thousand guilds they are
-- ten thousand customers, any one of whom may be hostile to the other 9,999.
-- Handing that population an interpreter is handing them the process. So there
-- is no script column here and there never will be. `graph` holds a closed,
-- versioned set of typed nodes that a bounded interpreter walks, and the set of
-- node types in `src/minibots/graph.rs` IS the security boundary -- every node
-- type is a capability granted to everyone who can edit a flow.
--
-- Why this reuses the bot identity model rather than inventing a parallel one:
-- a minibot is a row in `bot_applications` with `local = 1`, installed into its
-- guild as an ordinary member with an ordinary managed role, exactly as a
-- third-party bot is. That is not tidiness. It means the permission ceiling in
-- `guildstore::bot_permission_ceiling`, the role hierarchy, the BOT badge, the
-- audit log, the member list and guild migration all keep working with no
-- special case -- and, much more importantly, it means nobody can later add a
-- special case by accident. A minibot that ran outside the member model would
-- be a principal every permission check in this crate has never heard of.
-- Running in process buys a minibot lower latency and no setup. It must never
-- buy it authority, and the way you guarantee that is to give it no separate
-- path to authority at all.

-- On the `local` flag: it is added by 0054, not here.
--
-- A minibot is a `bot_applications` row with `local = 1`, exactly as the
-- interactivity contract specifies, but the column itself belongs to 0054,
-- which owns that contract and needs the same flag to decide whether an
-- interaction is dispatched in process or over a socket. SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so declaring it twice is not a redundancy, it is
-- a hard migration failure on every existing deployment. One flag, one
-- definition; this migration reads it and never re-declares it.
--
-- 0056 relaxes the owner-integrity triggers from 0049 so that a `local = 1`
-- application may carry an empty `owner_user_id` -- a minibot belongs to the
-- homeserver rather than to a developer account. That ordering matters and it
-- holds: 0054 adds the column, 0055 (this file) stores flows against it, 0056
-- teaches the triggers about it, and nothing inserts a local application until
-- the process is running, by which time all three have applied.

-- One flow: a trigger, a graph, and the identity of the person it acts for.
--
-- `author_user_id` is the load-bearing column and the reason this table is not
-- just "a config blob on the guild". A flow must never be able to do something
-- its author could not do, and "could not do" is present tense: roles change
-- after a flow is written, and an admin who is later demoted must not leave
-- behind a flow that still bans people. So the author is recorded, their
-- permissions are checked when the flow is saved, and they are resolved AGAIN,
-- from live rows, before each individual node executes. A flow whose author
-- leaves the guild stops being able to act; it is not deleted, because an
-- admin should be able to see why it went quiet and re-adopt it.
--
-- `required_permissions` is the union of the permission bits every action node
-- in the graph needs, computed once at save time from the graph itself. It is
-- cached rather than recomputed because it is the cheap pre-flight check: a run
-- whose author no longer holds the union can be abandoned before the
-- interpreter starts, and a flow can be listed as "will not run" in the UI
-- without walking every node. It is never the authority -- the per-node check
-- at execution time is -- it is the fast path that usually says no first.
--
-- What a flow does NOT hold is the id of the application it acts as. There is
-- exactly one local application per guild, so the flow's identity is a function
-- of its guild and storing it again would only create a second place for the
-- answer to live -- and a column an id could be edited in. Resolving it through
-- `minibot_applications.guild_id` instead makes "a flow acting as another
-- guild's minibot" unrepresentable rather than merely checked for. It also
-- matters for migration: a guild that moves takes its flows with it but not its
-- identity, because `@mb.<guild>:<server>` and the `bot_applications` row
-- behind it are the destination server's to issue, and a flow that named the
-- old server's application would arrive pointing at a row that is not there.
--
-- `failure_streak` and `disabled_reason` are the circuit breaker. A flow that
-- keeps failing is either broken or being used to hammer something, and
-- retrying it forever is how one bad flow becomes the guild's whole CPU
-- budget. Consecutive failures trip it; any success clears it; an admin
-- re-enables it explicitly, which is deliberate -- a breaker that reset itself
-- on a timer would just be a slower loop.
CREATE TABLE minibot_flows (
    id                   TEXT PRIMARY KEY,
    guild_id             TEXT NOT NULL,
    name                 TEXT NOT NULL,
    enabled              INTEGER NOT NULL DEFAULT 1,
    author_user_id       TEXT NOT NULL,
    -- The trigger kind is denormalised out of the graph so that dispatching an
    -- event does not mean parsing every flow in the guild. On a busy guild this
    -- is the difference between one indexed lookup per message and a JSON parse
    -- per flow per message.
    trigger_kind         TEXT NOT NULL,
    graph                TEXT NOT NULL,
    -- The editor's own picture of the same flow: node positions, and whatever
    -- else a builder needs to redraw what somebody arranged by hand. Opaque
    -- here on purpose -- nothing in this crate reads it, `graph` is the only
    -- thing the interpreter walks -- so a client may change its layout format
    -- without a migration. It is size-capped on write like everything else a
    -- guild can store, and the ids inside it are rewritten on an id-reissuing
    -- import by the same pass that rewrites the graph, because a layout that
    -- still names the old guild's channels would quietly re-introduce them the
    -- next time somebody pressed save.
    layout               TEXT,
    required_permissions INTEGER NOT NULL DEFAULT 0,
    failure_streak       INTEGER NOT NULL DEFAULT 0,
    disabled_reason      TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);
CREATE INDEX minibot_flows_guild ON minibot_flows (guild_id, trigger_kind, enabled);
CREATE INDEX minibot_flows_author ON minibot_flows (author_user_id);

-- Every run, with enough of its insides to answer the only two questions
-- anybody ever asks about an automation: "why did that happen" and "why did
-- that not happen".
--
-- Both questions need the same row, and the second one is the reason this
-- table records refusals as loudly as successes. A run that was denied by the
-- permission ceiling, throttled by the rate limiter, cut off by the step
-- budget or refused by the recursion guard writes a row saying so. Without
-- that, a flow that silently does nothing is indistinguishable from a flow
-- that was never triggered, and the admin's only recourse is to guess.
--
-- `trace` is the ordered list of node ids the interpreter visited, capped by
-- the step budget, so it is bounded by construction. A moderator looking at a
-- ban in the audit log can follow the run id here and see the exact path that
-- reached the ban node.
--
-- Retention is capped per guild and trimmed on write rather than by a sweeper.
-- A flow on a busy guild can produce runs faster than any periodic job would
-- clear them, and an unbounded debug log on a shared homeserver is a disk
-- exhaustion primitive handed to whoever writes the noisiest flow.
CREATE TABLE minibot_runs (
    id            TEXT PRIMARY KEY,
    guild_id      TEXT NOT NULL,
    flow_id       TEXT NOT NULL,
    trigger_kind  TEXT NOT NULL,
    -- What set it off: a message id, a member id, a custom_id. Free text
    -- because the shape differs per trigger and nothing joins on it.
    trigger_ref   TEXT,
    -- The member whose action triggered the run, when there was one. Null for
    -- a scheduled run, which nobody performed.
    actor_user_id TEXT,
    -- Trigger depth: 0 for a run caused by a person, 1 for a run caused by a
    -- minibot's own output, and so on up to the recursion cap.
    depth         INTEGER NOT NULL DEFAULT 0,
    -- ok | error | denied | budget | timeout | throttled | recursion | breaker
    outcome       TEXT NOT NULL,
    steps         INTEGER NOT NULL DEFAULT 0,
    trace         TEXT NOT NULL DEFAULT '[]',
    error         TEXT,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER
);
CREATE INDEX minibot_runs_guild ON minibot_runs (guild_id, started_at DESC);
CREATE INDEX minibot_runs_flow ON minibot_runs (flow_id, started_at DESC);

-- The key/value store flows use to hold counters and small state.
--
-- Scoped to the guild rather than to the flow on purpose: the useful cases are
-- shared ones -- a warn count one flow increments and another reads, a
-- "welcome sent" marker set by the join flow and checked by the message flow --
-- and every flow in a guild is authored by somebody with MANAGE_GUILD there,
-- so there is no privilege boundary between two flows in the same guild to
-- protect. There very much is one between two guilds, which is why the guild
-- id is half the primary key and every cap below is counted per guild.
--
-- The caps are small and they are deliberately small. This is state that lives
-- on somebody else's homeserver, written by a rule rather than by a person, and
-- the failure mode of a generous limit is not "a flow stores a lot" but "a
-- flow with an increment node in a loop stores everything". Enforced on write
-- in `src/minibots/store.rs`, not by a constraint here, because the useful
-- error is "this guild is at its minibot storage limit" and not a constraint
-- violation -- but the column widths below are the second line of defence if
-- somebody ever writes a path that forgets to ask.
CREATE TABLE minibot_store (
    guild_id   TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, key)
) WITHOUT ROWID;

-- The per-guild local application, pinned to its guild.
--
-- `bot_applications` is global and owned by a developer account; this row says
-- which guild a local application belongs to, so that a flow can never be
-- pointed at an application belonging to somebody else's guild by editing an
-- id in a request body. The guild id is unique: one local application per
-- guild, created lazily on the first flow and reused thereafter.
CREATE TABLE minibot_applications (
    application_id TEXT PRIMARY KEY,
    guild_id       TEXT NOT NULL UNIQUE,
    created_at     INTEGER NOT NULL
);
