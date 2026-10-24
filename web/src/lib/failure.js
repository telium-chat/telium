// Classifies socket and request failures into a kind, a sentence and one action. When the device is offline no server is blamed.

import { t } from './i18n/index.js';
import { errorMessage, isNetworkFailure } from './i18n/errors.js';

/// Ordered by `PRIORITY` below; protocol first because it never fixes itself.
export const Kind = {
  Protocol: 'protocol',
  Auth: 'auth',
  Offline: 'offline',
  AccountHome: 'account_home',
  GuildServer: 'guild_server',
  Reconnecting: 'reconnecting',
};

export const Action = {
  Wait: 'wait',
  SignIn: 'sign-in',
  Update: 'update',
  HomeOperator: 'home-operator',
  GuildOperator: 'guild-operator',
  Network: 'network',
};

/// Matches `FALLBACK_AFTER_MS` in `failover.js`.
export const DOWN_AFTER_MS = 20_000;

/// `PROTOCOL_INCOMPATIBLE` is sent before the server reads the token, with a reason that is already a full sentence.
export const Close = {
  IDENTIFY_EXPECTED: 4001,
  MALFORMED: 4002,
  AUTH_FAILED: 4004,
  RESTARTING: 4005,
  PROTOCOL_INCOMPATIBLE: 4015,
};

function saneReason(reason) {
  if (typeof reason !== 'string') return '';
  const flat = reason.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}

export const Role = { Home: 'home', Guild: 'guild' };

/// @param {object} input
/// @param {number} [input.code]
/// @param {string} [input.reason]
/// @param {string} [input.role]
/// @param {string} [input.name]
/// @param {boolean} [input.online]
/// @param {number} [input.downFor]
/// @returns {{kind: string, action: string, sentence: string, retryable: boolean, detail: string|null}}
export function classify({
  code = 0,
  reason = '',
  role = Role.Guild,
  name = t('shell.socket.unnamedServer'),
  online = true,
  downFor = 0,
} = {}) {
  const detail = saneReason(reason);

  // A device with no network fails every connection at once; don't blame servers.
  if (!online) {
    return {
      kind: Kind.Offline,
      action: Action.Network,
      sentence: t('shell.socket.offline'),
      retryable: false,
      detail: null,
    };
  }

  if (code === Close.PROTOCOL_INCOMPATIBLE) {
    return {
      kind: Kind.Protocol,
      action: Action.Update,
      // The server knows which end is behind; use its words.
      sentence: detail || t('shell.socket.incompatible', { name }),
      retryable: false,
      detail,
    };
  }

  if (code === Close.MALFORMED) {
    return {
      kind: Kind.Protocol,
      action: Action.Update,
      sentence: t('shell.socket.malformed', { name }),
      retryable: false,
      detail,
    };
  }

  if (code === Close.IDENTIFY_EXPECTED || code === Close.AUTH_FAILED) {
    return {
      kind: Kind.Auth,
      action: Action.SignIn,
      // `role` is a catalogue selector so translators see both variants together.
      sentence: t('shell.socket.sessionRefused', { name, role: role === Role.Home ? 'home' : 'guild' }),
      retryable: false,
      detail,
    };
  }

  if (code === Close.RESTARTING) {
    return {
      kind: Kind.Reconnecting,
      action: Action.Wait,
      sentence: t('shell.socket.restarting', { name }),
      retryable: true,
      detail,
    };
  }

  if (downFor < DOWN_AFTER_MS) {
    return {
      kind: Kind.Reconnecting,
      action: Action.Wait,
      sentence: t('shell.socket.reconnecting', { name, role: role === Role.Home ? 'home' : 'guild' }),
      retryable: true,
      detail,
    };
  }

  if (role === Role.Home) {
    return {
      kind: Kind.AccountHome,
      action: Action.HomeOperator,
      sentence: t('shell.socket.homeDown', { name }),
      retryable: true,
      detail,
    };
  }

  return {
    kind: Kind.GuildServer,
    action: Action.GuildOperator,
    sentence: t('shell.socket.guildDown', { name }),
    retryable: true,
    detail,
  };
}

const PRIORITY = [
  Kind.Protocol,
  Kind.Auth,
  Kind.Offline,
  Kind.AccountHome,
  Kind.GuildServer,
  Kind.Reconnecting,
];

export function rank(kind) {
  const at = PRIORITY.indexOf(kind);
  return at === -1 ? PRIORITY.length : at;
}

export function summarize(failures) {
  const live = failures.filter(Boolean);
  if (!live.length) return null;
  const byKind = new Map();
  for (const failure of live) {
    const group = byKind.get(failure.kind) || { ...failure, names: [] };
    if (failure.name) group.names.push(failure.name);
    byKind.set(failure.kind, group);
  }
  const groups = [...byKind.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
  return { lead: groups[0], groups };
}

/// @param {any} error
/// @param {boolean} [online]
/// @returns {string}
export function describeRequest(error, online = true) {
  // `online: false` only changes wording for real network failures, not local refusals.
  if (!online && isNetworkFailure(error)) return t('errors.offlineDevice');
  return errorMessage(error);
}

export function label(kind) {
  switch (kind) {
    case Kind.Protocol: return 'protocol incompatible';
    case Kind.Auth: return 'session refused';
    case Kind.Offline: return 'device offline';
    case Kind.AccountHome: return 'account home unreachable';
    case Kind.GuildServer: return 'guild server unreachable';
    default: return 'reconnecting';
  }
}
