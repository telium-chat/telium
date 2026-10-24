// Whether an event is somebody talking to you (may interrupt) or bookkeeping. Surfaces still apply mutes and preferences.

/// Strings so an unclassified event answers `undefined`, not `false`.
export const INTERRUPT = 'interrupt';
export const BOOKKEEPING = 'bookkeeping';

/// Must stay complete; a test asserts every arm of `store/dispatch.js` appears here.
export const EVENT_INTENT = {
  MESSAGE_CREATE: INTERRUPT,

  FRIEND_UPDATE: INTERRUPT,

  VOICE_SIGNAL: INTERRUPT,

  MIGRATION_ALERT: INTERRUPT,
  MIGRATION_UPDATE: INTERRUPT,

  RECOVERY_EMAIL_UPDATE: INTERRUPT,

  // May be a message or a receipt; `FRAME_INTENT` has the real answer once opened.
  DM_MESSAGE: INTERRUPT,

  MESSAGE_REACTION_ADD: BOOKKEEPING,
  MESSAGE_REACTION_REMOVE: BOOKKEEPING,
  MESSAGE_REACTION_CLEAR: BOOKKEEPING,

  // Edits never interrupt: telling an added mention from a typo fix would need every old body.
  MESSAGE_UPDATE: BOOKKEEPING,
  MESSAGE_DELETE: BOOKKEEPING,

  TYPING_START: BOOKKEEPING,
  TYPING_STOP: BOOKKEEPING,
  DM_TYPING_START: BOOKKEEPING,
  DM_TYPING_STOP: BOOKKEEPING,
  PRESENCE_UPDATE: BOOKKEEPING,
  PROFILE_UPDATE: BOOKKEEPING,
  FRIEND_REMOVE: BOOKKEEPING,

  DM_MEMBER_LEAVE: BOOKKEEPING,
  DM_REQUEST_UPDATE: BOOKKEEPING,

  // Same event as above; this later entry wins. The server sends its own push for a bounce.
  RECOVERY_EMAIL_UPDATE: BOOKKEEPING,

  CHANNEL_CREATE: BOOKKEEPING,
  CHANNEL_UPDATE: BOOKKEEPING,
  CHANNEL_DELETE: BOOKKEEPING,
  CHANNEL_PINS_UPDATE: BOOKKEEPING,
  CHANNEL_VISIBILITY: BOOKKEEPING,
  THREAD_CREATE: BOOKKEEPING,
  THREAD_UPDATE: BOOKKEEPING,
  THREAD_DELETE: BOOKKEEPING,
  GUILD_UPDATE: BOOKKEEPING,
  GUILD_DELETE: BOOKKEEPING,
  GUILD_EMOJI_UPDATE: BOOKKEEPING,
  ROLE_CREATE: BOOKKEEPING,
  ROLE_UPDATE: BOOKKEEPING,
  ROLE_DELETE: BOOKKEEPING,
  MEMBER_ADD: BOOKKEEPING,
  MEMBER_UPDATE: BOOKKEEPING,
  MEMBER_REMOVE: BOOKKEEPING,
  MEMBER_LIST_UPDATE: BOOKKEEPING,

  VOICE_STATE_UPDATE: BOOKKEEPING,
  VOICE_SERVER_UPDATE: BOOKKEEPING,
  VOICE_E2EE: BOOKKEEPING,
  VOICE_WATCHERS_UPDATE: BOOKKEEPING,

  MESSAGE_HELD: BOOKKEEPING,
  GUILD_APPLICANT: BOOKKEEPING,
  AUTOMOD_ACTION: BOOKKEEPING,
  // Raises its own dialog; don't double it.
  VERIFICATION: BOOKKEEPING,
};

export function mayInterrupt(t) {
  return EVENT_INTENT[t] === INTERRUPT;
}

export function isClassified(t) {
  return EVENT_INTENT[t] !== undefined;
}

export const FRAME_INTENT = {
  message: INTERRUPT,
  receipt: BOOKKEEPING,
  delivered: BOOKKEEPING,
  typing: BOOKKEEPING,
  reaction: BOOKKEEPING,
  edit: BOOKKEEPING,
  delete: BOOKKEEPING,
  pin: BOOKKEEPING,
  call_sfu: BOOKKEEPING,
  unknown: BOOKKEEPING,
};

/// `undefined` (never opened) answers true: a message this device can't decrypt is still unseen.
export function frameMayInterrupt(type) {
  if (type === undefined || type === null) return true;
  return FRAME_INTENT[type] === INTERRUPT;
}
