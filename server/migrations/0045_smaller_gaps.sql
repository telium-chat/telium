-- Guild vanity addressing (roadmap section 1) and the other half of external
-- emoji entitlement (roadmap section 3).

-- Where a vanity address used to point.
--
-- `guilds.alias` has always held the localpart of `#gaming:this.server`, but
-- it only ever held the *current* one: a guild that renamed itself, or that
-- moved to another server, left every posted `#gaming:this.server` pointing at
-- nothing. This table is the forwarding address for the name, exactly as
-- `tombstones` is the forwarding address for the guild.
--
-- A row survives the guild leaving, because that is when it matters most. It
-- also keeps the name out of the pool: the localpart a guild used to answer to
-- cannot be claimed by a different guild here, or a link posted last year would
-- quietly start landing somewhere its author never chose. The guild that
-- retired the name is the one exception -- it may take its own name back --
-- which is why `guild_id` is recorded and not merely the target.
--
-- `to_origin` may be this server (a rename) or another one (a move). Either way
-- it is a *hint*: a resolver follows it and then asks whoever it names to speak
-- for the guild itself. Nothing here lets this server assert anything about a
-- guild it does not hold.
CREATE TABLE guild_alias_redirects (
    alias       TEXT PRIMARY KEY,      -- the retired localpart, case-folded
    guild_id    TEXT NOT NULL,         -- the guild that held it here
    to_origin   TEXT NOT NULL,         -- the server that holds it now
    to_guild_id TEXT NOT NULL,         -- and its id there
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_guild_alias_redirects_guild ON guild_alias_redirects (guild_id);

-- Which of a guild's own members may use its emoji somewhere else.
--
-- `external_emoji` is the receiving guild's half of the bargain: whether a
-- channel here accepts emoji from elsewhere. This is the owning guild's half:
-- whether the member carrying one away was entitled to it. Both have to pass.
--
--   everyone  -- anyone who can see the emoji may use it anywhere (the
--                behaviour before this column existed, and the default)
--   members   -- only the guild's own members
--   role      -- only members holding `emoji_export_role_id`, or a role
--                positioned at or above it
--
-- The third is deliberately a role and not a named tier: "boosters", "staff"
-- and "level 10 and up" are all the same rule once the guild has made a role
-- for them, and a guild that invents a fourth kind of membership next year does
-- not need a schema change to gate emoji on it.
ALTER TABLE guilds ADD COLUMN emoji_export_policy TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE guilds ADD COLUMN emoji_export_role_id TEXT;

-- What another server said about one of its own members' entitlement.
--
-- Only the guild's own server can answer "is @ana entitled to carry this
-- emoji": the roles are its rows. So a guild here that receives a foreign emoji
-- asks, and remembers the answer for a few minutes -- long enough that a burst
-- of reactions is one question, short enough that a revoked role stops working
-- while the person is still looking at the screen.
CREATE TABLE emoji_entitlements (
    origin     TEXT NOT NULL,          -- the server that owns the emoji
    emoji_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    allowed    INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (origin, emoji_id, user_id)
);
CREATE INDEX idx_emoji_entitlements_checked ON emoji_entitlements (checked_at);
