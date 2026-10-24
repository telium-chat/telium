import { t } from './i18n/index.js';

// Name -> bit, mirroring src/perms.rs on the server. The values matter: the server can't tell a wrong bit from a deliberate one.
export const PERMISSION_BITS = {
  VIEW_CHANNEL: 0, SEND_MESSAGES: 1, MANAGE_MESSAGES: 2, MANAGE_CHANNELS: 3,
  MANAGE_ROLES: 4, KICK_MEMBERS: 5, BAN_MEMBERS: 6, MANAGE_GUILD: 7,
  MANAGE_EXPRESSIONS: 8, CREATE_INVITE: 9, ATTACH_FILES: 10, EMBED_LINKS: 11,
  MENTION_EVERYONE: 12, MODERATE_MEMBERS: 13, USE_EXTERNAL_EMOJI: 14,
  CONNECT: 15, SPEAK: 16, VIDEO: 17, STREAM: 18, VIEW_AUDIT_LOG: 19,
  ADD_REACTIONS: 20, READ_MESSAGE_HISTORY: 21, PRIORITY_SPEAKER: 22,
  MUTE_MEMBERS: 23, DEAFEN_MEMBERS: 24, MOVE_MEMBERS: 25, ADMINISTRATOR: 40,
};

export const PERMISSIONS = Object.keys(PERMISSION_BITS);

/// ADMINISTRATOR is bit 40, so these don't fit in a double; BigInt out to the wire, where they cross as decimal strings.
export const PERMISSION_MASKS = new Map(
  Object.entries(PERMISSION_BITS).map(([name, shift]) => [name, 1n << BigInt(shift)]),
);

/// The server returns exactly this for an owner or administrator.
export const ALL_PERMISSIONS = (1n << 64n) - 1n;

export const TIMEOUT_ALLOWED = PERMISSION_MASKS.get('VIEW_CHANNEL')
  | PERMISSION_MASKS.get('READ_MESSAGE_HISTORY');

/// The only place that has to care whether a string or BigInt arrived.
export function toBits(value) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined || value === '') return 0n;
  try { return BigInt(value); } catch { return 0n; }
}

export function has(bits, name) {
  const mask = PERMISSION_MASKS.get(name);
  return !!mask && (toBits(bits) & mask) !== 0n;
}

export function namesOf(bits) {
  const b = toBits(bits);
  return PERMISSIONS.filter((name) => (b & PERMISSION_MASKS.get(name)) !== 0n);
}

/// Mirrors `perms::channel_permissions` so a button can be greyed out instead of 403ing. An affordance, never an authority: if they disagree the server is right.
export function channelPermissions(member, guildId, overwrites = []) {
  if (!member) return 0n;
  let perms = toBits(member.permissions);
  if (perms === ALL_PERMISSIONS) return applyTimeout(member, perms);

  const roles = new Set(member.roles || []);
  const everyone = overwrites.find((o) => o.target_type === 'role' && o.target_id === guildId);
  if (everyone) {
    perms &= ~toBits(everyone.deny);
    perms |= toBits(everyone.allow);
  }

  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.target_type !== 'role' || o.target_id === guildId) continue;
    if (!roles.has(o.target_id)) continue;
    allow |= toBits(o.allow);
    deny |= toBits(o.deny);
  }
  perms &= ~deny;
  perms |= allow;

  const mine = overwrites.find((o) => o.target_type === 'member' && o.target_id === member.user_id);
  if (mine) {
    perms &= ~toBits(mine.deny);
    perms |= toBits(mine.allow);
  }

  return applyTimeout(member, perms);
}

function applyTimeout(member, perms) {
  const until = member.timeout_until;
  if (until && new Date(until).getTime() > Date.now()) return perms & TIMEOUT_ALLOWED;
  return perms;
}

/// A member's rank is their highest role; the server refuses edits at or above your rank and the interface hides them.
export function outranks(actor, targetPosition) {
  if (!actor) return false;
  if (actor.is_owner) return true;
  return (actor.top_role_position ?? 0) > targetPosition;
}

/// `group` sorts a switch into `PERMISSION_GROUPS`; `danger` marks ones worth a second look. `label` and `hint` are accessors so they follow the active language (a string here would freeze at boot).
const bit = (name, group, danger = false) => {
  const key = name.toLowerCase();
  return {
    group,
    danger,
    get label() { return t(`perms.${key}.label`); },
    get hint() { return t(`perms.${key}.hint`); },
  };
};

export const PERMISSION_INFO = {
  VIEW_CHANNEL: bit('VIEW_CHANNEL', 'general'),
  MANAGE_CHANNELS: bit('MANAGE_CHANNELS', 'general'),
  MANAGE_ROLES: bit('MANAGE_ROLES', 'general', true),
  MANAGE_EXPRESSIONS: bit('MANAGE_EXPRESSIONS', 'general'),
  VIEW_AUDIT_LOG: bit('VIEW_AUDIT_LOG', 'general'),
  MANAGE_GUILD: bit('MANAGE_GUILD', 'general', true),
  CREATE_INVITE: bit('CREATE_INVITE', 'membership'),
  KICK_MEMBERS: bit('KICK_MEMBERS', 'membership'),
  BAN_MEMBERS: bit('BAN_MEMBERS', 'membership', true),
  MODERATE_MEMBERS: bit('MODERATE_MEMBERS', 'membership'),
  SEND_MESSAGES: bit('SEND_MESSAGES', 'text'),
  EMBED_LINKS: bit('EMBED_LINKS', 'text'),
  ATTACH_FILES: bit('ATTACH_FILES', 'text'),
  ADD_REACTIONS: bit('ADD_REACTIONS', 'text'),
  USE_EXTERNAL_EMOJI: bit('USE_EXTERNAL_EMOJI', 'text'),
  MENTION_EVERYONE: bit('MENTION_EVERYONE', 'text', true),
  MANAGE_MESSAGES: bit('MANAGE_MESSAGES', 'text', true),
  READ_MESSAGE_HISTORY: bit('READ_MESSAGE_HISTORY', 'text'),
  CONNECT: bit('CONNECT', 'voice'),
  SPEAK: bit('SPEAK', 'voice'),
  VIDEO: bit('VIDEO', 'voice'),
  STREAM: bit('STREAM', 'voice'),
  PRIORITY_SPEAKER: bit('PRIORITY_SPEAKER', 'voice'),
  MUTE_MEMBERS: bit('MUTE_MEMBERS', 'voice'),
  DEAFEN_MEMBERS: bit('DEAFEN_MEMBERS', 'voice'),
  MOVE_MEMBERS: bit('MOVE_MEMBERS', 'voice'),
  ADMINISTRATOR: bit('ADMINISTRATOR', 'advanced', true),
};

/// `[key, title]` pairs; the title getter is installed on index 1 afterwards because an array literal can't hold one. `.map` destructuring, `JSON.stringify` and spread still work.
const groupPair = (key) => Object.defineProperty([key, ''], 1, {
  get: () => t(`perms.group.${key}`),
  enumerable: true,
});

export const PERMISSION_GROUPS = [
  'general', 'membership', 'text', 'voice', 'advanced',
].map(groupPair);

/// The permission's own name is the fallback: a server one version ahead can send an unknown bit.
export function permissionInfo(name) {
  return PERMISSION_INFO[name] || { label: name, group: 'advanced', hint: '', danger: false };
}
