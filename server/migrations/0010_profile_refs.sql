-- avatar_ref used to be stored as `media://origin/hash`, which Avatar.jsx cannot
-- turn into a fetchable URL (it became /_telium/v1/media/media://origin/hash).
-- Rewrite refs that point at local media to the fetchable `hash?cap=capability`
-- form, using the capability the media row already holds, so existing profiles
-- repair themselves instead of needing a re-pick.
UPDATE profiles
SET avatar_ref = (
    SELECT m.hash || '?cap=' || m.capability
    FROM media m
    WHERE profiles.avatar_ref LIKE '%/' || m.hash
    LIMIT 1
)
WHERE avatar_ref LIKE 'media://%';