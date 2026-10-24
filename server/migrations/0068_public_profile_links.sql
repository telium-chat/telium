-- Public profile-link privacy belongs to the account home because the
-- anonymous page must be enforceable before any client session exists.
--
-- The three defaults are deliberately not the same value.
--
-- `public_page_enabled` defaults on because it publishes nothing that was not
-- already anonymously readable: `/_telium/v1/users/{id}/profile` has always
-- served display name, avatar, bio and pronouns to anyone who asks, because
-- federation needs it to. The link is a nicer door onto the same room.
--
-- Status and activity default *off* because they are genuinely new exposure.
-- Before this migration nothing published an account's live presence to an
-- unauthenticated caller; presence went to friends and to guilds the account
-- had joined. Turning it on for every existing row of an upgraded server would
-- hand strangers a presence feed nobody opted into, and "we shipped a switch
-- they can find in settings" is not consent. A person who wants their status
-- on their public page turns it on.
ALTER TABLE profiles ADD COLUMN public_page_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE profiles ADD COLUMN public_status_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN public_activity_enabled INTEGER NOT NULL DEFAULT 0;
