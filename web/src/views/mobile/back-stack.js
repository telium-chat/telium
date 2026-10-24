export function mobileBackAction({ drawerOpen, membersOpen, voiceStageOpen, route }) {
  if (voiceStageOpen) return 'close-voice';
  if (membersOpen) return 'close-members';
  if (drawerOpen) return 'close-drawer';
  if (route?.view === 'dms' && route.conversationId) return 'dm-list';
  return 'exit';
}
