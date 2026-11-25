/// What Android Back does in the mobile shell, topmost first:
/// voice stage → members panel → back up to the list → leave the app.
/// The channel list (the drawer) is the list level for guilds, so Back from a guild
/// channel opens it and Back from the open drawer leaves; closing it instead would
/// loop channel → list → channel forever. DMs keep their list in the main view.
export function mobileBackAction({ drawerOpen, membersOpen, voiceStageOpen, route }) {
  if (voiceStageOpen) return 'close-voice';
  if (membersOpen) return 'close-members';
  if (drawerOpen) return 'exit';
  if (route?.view === 'dms' && route.conversationId) return 'dm-list';
  if (route?.view !== 'dms' && route?.guildId) return 'open-drawer';
  return 'exit';
}
