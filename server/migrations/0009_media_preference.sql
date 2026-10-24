-- Which media tier an account uploads through (Section 6).
--
-- This is account state rather than client state on purpose: the tier is a
-- decision about where a person's files live, and a device that has never
-- uploaded anything has no way to guess it. It belongs next to the profile,
-- which is why it rides in the migration bundle with everything else the
-- account carries between homeservers.
CREATE TABLE media_preferences (
    user_id    TEXT PRIMARY KEY,
    -- 1 = this homeserver, 2 = a third-party origin, 3 = external links only.
    tier       INTEGER NOT NULL DEFAULT 1,
    -- Tier 2 only, and the origin's domain rather than a URL: it is the same
    -- identity that appears in `media://origin/hash` and in a voucher audience.
    origin     TEXT,
    updated_at INTEGER NOT NULL
);
