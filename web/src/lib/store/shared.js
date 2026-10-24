/// Imported on demand: the MLS stack is a third of the bundle and only DMs reach it.
export const encryption = () => import('../mls.js');
export const verification = () => import('../verify.js');
export const secureAuth = () => import('../opaque-auth.js');

export const SESSION_KEY = 'telium.session.v1';
export const LOCAL_DM_DRAFTS_KEY = 'telium.dm-drafts.local.v1';
export const OPAQUE_PIN_PREFIX = 'telium.auth.opaque.v1:';
export const PENDING_RECOVERY_KEY = 'telium.pending-account-recovery.v1';

export const DEFAULT_INTENTS = [
  'GUILD_MESSAGES', 'GUILD_MEMBERS', 'GUILD_PRESENCES', 'GUILD_TYPING',
  'GUILD_EXPRESSIONS', 'GUILD_STRUCTURE', 'GUILD_VOICE_STATES', 'DIRECT_MESSAGES',
];

export const RENEW_BEFORE_MS = 5 * 60_000;
export const RENEW_EVERY_MS = 60_000;
/// A server refusing a token it just minted is refusing for another reason.
export const RENEW_MIN_GAP_MS = 30_000;
