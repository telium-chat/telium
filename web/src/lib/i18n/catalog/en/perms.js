// Every permission bit, as a person reads it.
//
// This namespace is unusual in two ways and both are worth knowing before
// editing it.
//
// **It is read from two very different places.** The role editor draws all
// fifty-four of these -- a label on each switch and a hint under it -- and the
// error layer reaches for exactly one label at a time, when the server refuses
// something with `code: "missing_permission"` and `permission: "MANAGE_ROLES"`.
// That is the reason the labels are here rather than in `lib/perms.js` where
// they used to be: the error message and the switch have to say the same
// words. "You need the Manage Roles permission", followed by a settings screen
// whose switch is labelled something else, is a worse experience than an
// untranslated error, because it sends somebody looking for a control that
// does not appear to exist.
//
// **The hints are security copy.** Every one of them is read at the moment
// somebody is deciding whether to hand a stranger a piece of their guild, and
// several of them are the only warning that will ever be given -- there is no
// confirmation dialog behind `ADMINISTRATOR`. A vague translation of
// `perms.administrator.hint` is not a cosmetic defect; it is the difference
// between a guild being given away knowingly and being given away by accident.
// Translators should be told that, and the workflow note in
// `docs/translating.md` says so.
//
// The keys are the permission constants, lowercased. That mapping is
// mechanical on purpose: `errors.js` turns `MANAGE_ROLES` into
// `perms.manage_roles.label` without a table, so a permission bit added to the
// server and to `lib/perms.js` needs two lines here and no third place to
// remember.
//
// A bit with no entry falls back to its own constant name -- see
// `permissionInfo` in `lib/perms.js`. "MANAGE_STICKERS" in the middle of an
// otherwise German sentence is ugly and true; a blank is neither.

export const perms = {
  'perms.view_channel.label': 'View Channels',
  'perms.view_channel.hint': 'See channels they have not been shut out of by an overwrite.',
  'perms.manage_channels.label': 'Manage Channels',
  'perms.manage_channels.hint': 'Create, rename, reorder and delete this guild’s channels.',
  'perms.manage_roles.label': 'Manage Roles',
  'perms.manage_roles.hint': 'Edit roles below their own, and hand those roles to anyone. They can never grant a permission they do not already hold.',
  'perms.manage_expressions.label': 'Manage Emoji and Stickers',
  'perms.manage_expressions.hint': 'Upload and remove the emoji and stickers this guild serves.',
  'perms.view_audit_log.label': 'View Audit Log',
  'perms.view_audit_log.hint': 'Read the record of who changed what on this server.',
  'perms.manage_guild.label': 'Manage Server',
  'perms.manage_guild.hint': 'Change the guild’s name, icon, join gate and voice region.',
  'perms.create_invite.label': 'Create Invite',
  'perms.create_invite.hint': 'Mint invite codes that let accounts from any homeserver in.',
  'perms.kick_members.label': 'Kick Members',
  'perms.kick_members.hint': 'Remove members ranked below them. A kick is not a ban: they can come back with a new invite.',
  'perms.ban_members.label': 'Ban Members',
  'perms.ban_members.hint': 'Bar an account from rejoining, by user ID, across every homeserver.',
  'perms.moderate_members.label': 'Timeout Members',
  'perms.moderate_members.hint': 'Silence a member for a while. A timed-out member keeps only reading.',
  'perms.send_messages.label': 'Send Messages',
  'perms.send_messages.hint': 'Post in text channels they can see.',
  'perms.embed_links.label': 'Embed Links',
  'perms.embed_links.hint': 'Have the links they post unfurl into previews.',
  'perms.attach_files.label': 'Attach Files',
  'perms.attach_files.hint': 'Upload images and files to this guild’s own media store.',
  'perms.add_reactions.label': 'Add Reactions',
  'perms.add_reactions.hint': 'Put a new reaction on a message. Joining an existing one needs nothing.',
  'perms.use_external_emoji.label': 'Use External Emoji',
  'perms.use_external_emoji.hint': 'Use emoji served by other guilds, on other homeservers.',
  'perms.mention_everyone.label': 'Mention @everyone and Roles',
  'perms.mention_everyone.hint': 'Ping the whole guild, or any role, whether or not that role is mentionable.',
  'perms.manage_messages.label': 'Manage Messages',
  'perms.manage_messages.hint': 'Delete and pin anyone’s messages.',
  'perms.read_message_history.label': 'Read Message History',
  'perms.read_message_history.hint': 'See what was said before they arrived. Without it a channel starts empty.',
  'perms.connect.label': 'Connect',
  'perms.connect.hint': 'Join voice channels they can see.',
  'perms.speak.label': 'Speak',
  'perms.speak.hint': 'Be heard in voice. Without it they can listen.',
  'perms.video.label': 'Video',
  'perms.video.hint': 'Turn a camera on in voice.',
  'perms.stream.label': 'Go Live',
  'perms.stream.hint': 'Share a screen in voice.',
  'perms.priority_speaker.label': 'Priority Speaker',
  'perms.priority_speaker.hint': 'Be heard over everyone else while they talk.',
  'perms.mute_members.label': 'Mute Members',
  'perms.mute_members.hint': 'Silence other people in voice channels.',
  'perms.deafen_members.label': 'Deafen Members',
  'perms.deafen_members.hint': 'Stop other people hearing a voice channel.',
  'perms.move_members.label': 'Move Members',
  'perms.move_members.hint': 'Drag people between voice channels, or out of them.',
  'perms.administrator.label': 'Administrator',
  'perms.administrator.hint': 'Every permission on this server, and every channel overwrite ignored. Only hand this to someone you would trust with the guild itself.',
  // The headings the role editor groups the switches under. `advanced` holds
  // exactly one switch today -- `ADMINISTRATOR` -- and is a group of its own
  // anyway, because the thing that makes it advanced is not that there are
  // several of them.
  'perms.group.general': 'General Server Permissions',
  'perms.group.membership': 'Membership Permissions',
  'perms.group.text': 'Text Channel Permissions',
  'perms.group.voice': 'Voice Channel Permissions',
  'perms.group.advanced': 'Advanced Permissions',
};
