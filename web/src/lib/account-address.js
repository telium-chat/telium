// Parses the desktop sign-in field: handle, server, invite link or bare name. Pure; network lookups run on commit.

import { discover, request } from './api.js';
import { isPortalHost, normalizeHomeserver } from './homeserver.js';
import { readStored } from './local-state.js';

export const DEFAULT_HOME = 'telium.chat';

const RECENT_KEY = 'telium.recent-accounts.v1';
const RECENT_MAX = 5;
const SUGGEST_MAX = 4;

const USER = /^[A-Za-z0-9._-]{1,64}$/;

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const DOTTED = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,}$`, 'i');
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/// Narrower than "parses as a URL": `ada:foo` parses, but `foo` is not a host.
function addressable(host) {
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(host);
  if (!m) return false;
  const [, name, port] = m;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return false;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  const ip = IPV4.exec(name);
  if (ip) return ip.slice(1).every((octet) => Number(octet) <= 255);
  return DOTTED.test(name);
}

function inviteCode(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'invite' && parts[1]) {
    try { return decodeURIComponent(parts[1]); } catch { return null; }
  }
  return null;
}

/// `base` is present only when a scheme was typed, so `http://localhost:8080` stays plain http.
function located(host, path, base) {
  const lower = host.toLowerCase();
  if (!addressable(lower)) return { kind: 'invalid' };
  const extra = base ? { base } : {};
  const code = inviteCode(path);
  if (code) {
    // A portal link names its server after the code: `telium.chat/invite/CODE@server`.
    // Neither invite codes nor aliases contain `@`, so a separator is unambiguous, and
    // the named server replaces the portal host — the portal only carries the link, so
    // its origin is deliberately not kept: discovery must aim at the named server.
    const at = code.lastIndexOf('@');
    if (at !== -1) {
      const server = code.slice(at + 1).toLowerCase();
      if (at === 0 || !addressable(server)) return { kind: 'invalid' };
      return { kind: 'invite', host: server, code: code.slice(0, at) };
    }
    return { kind: 'invite', host: lower, code, ...extra };
  }
  return { kind: 'server', host: lower, ...extra };
}

export function parseAddress(text) {
  const value = String(text ?? '').trim().replace(/\/+$/, '');
  if (!value) return { kind: 'empty' };
  if (/\s/.test(value)) return { kind: 'invalid' };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { return { kind: 'invalid' }; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'invalid' };
    // Reject credentials in the URL (phishing-shaped).
    if (url.username || url.password || !url.host) return { kind: 'invalid' };
    return located(url.host, url.pathname, url.origin);
  }

  // Checked before handle forms: `localhost:8080` is also `user:host`-shaped.
  const slash = value.indexOf('/');
  const head = slash === -1 ? value : value.slice(0, slash);
  if (!head.includes('@') && addressable(head.toLowerCase())) {
    return located(head, slash === -1 ? '' : value.slice(slash), null);
  }
  if (slash !== -1) return { kind: 'invalid' };

  const colon = /^@?([^@:]+):(.+)$/.exec(value);
  if (colon) {
    const [, user, host] = colon;
    if (!USER.test(user) || !addressable(host.toLowerCase())) return { kind: 'invalid' };
    return { kind: 'handle', user, host: host.toLowerCase() };
  }
  const at = /^@?([^@:]+)@([^@]+)$/.exec(value);
  if (at) {
    const [, user, host] = at;
    if (!USER.test(user) || !addressable(host.toLowerCase())) return { kind: 'invalid' };
    return { kind: 'handle', user, host: host.toLowerCase() };
  }

  const user = value.replace(/^@/, '');
  if (USER.test(user)) return { kind: 'name', user };
  return { kind: 'invalid' };
}

export const fullHandle = (user, serverName) => `@${user}:${serverName}`;

/// The API base comes from the well-known document. A bare host gets its scheme here (https except loopback) so blocking 443 can't force cleartext; an https document may not name an http API.
export async function findHome(hostOrBase) {
  const target = /^https?:\/\//i.test(hostOrBase)
    ? hostOrBase
    : (normalizeHomeserver(hostOrBase) || hostOrBase);
  let doc;
  try {
    doc = await discover(target);
  } catch (e) {
    throw unreachable(hostOrBase, e);
  }
  if (!doc || typeof doc.server_name !== 'string' || !doc.server_name || !doc.api) {
    throw unreachable(hostOrBase, null);
  }
  if (/^https:/i.test(target) && !/^https:/i.test(doc.api)) {
    throw unreachable(hostOrBase, null);
  }
  return { serverName: doc.server_name, api: doc.api, movedTo: doc.moved_to || null };
}

function unreachable(target, cause) {
  const err = new Error(`could not reach ${target}`, cause ? { cause } : undefined);
  err.code = 'unreachable';
  err.sentence = cause?.sentence
    || `Could not reach ${target}. Check the address; if it is right, that server is down.`;
  return err;
}

const STATUSES = new Set(['active', 'deactivated', 'unknown', 'moved', 'gone']);

/// Never throws: any failure is `status: null` and the caller carries on to the password.
export async function lookupAccount(api, userId) {
  let body;
  try {
    body = await request(api, 'GET', `/_telium/v1/users/${encodeURIComponent(userId)}/status`);
  } catch {
    return { status: null };
  }
  const status = body?.status;
  if (!STATUSES.has(status)) return { status: null };
  // `moved_to` is the new user id, not a server.
  return status === 'moved'
    ? { status, movedTo: typeof body.moved_to === 'string' ? body.moved_to : null }
    : { status, movedTo: null };
}

// Public data only: this list survives sign-out, so never a token or password.

const validEntry = (e) => e && typeof e === 'object'
  && typeof e.userId === 'string' && e.userId
  && typeof e.host === 'string' && e.host;

export function recentAccounts() {
  const list = readStored(RECENT_KEY, (v) => Array.isArray(v));
  if (!list) return [];
  return list.filter(validEntry).slice(0, RECENT_MAX).map((e) => ({
    userId: e.userId,
    host: e.host,
    base: typeof e.base === 'string' ? e.base : null,
    at: Number(e.at) || 0,
  }));
}

function writeRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* keep going */ }
}

export function rememberAccount({ userId, host, base } = {}) {
  if (typeof userId !== 'string' || !userId || typeof host !== 'string' || !host) return;
  const entry = { userId, host, base: typeof base === 'string' ? base : null, at: Date.now() };
  const rest = recentAccounts().filter((e) => e.userId !== userId);
  writeRecent([entry, ...rest].slice(0, RECENT_MAX));
}

export function forgetAccount(userId) {
  const list = recentAccounts();
  const next = list.filter((e) => e.userId !== userId);
  if (next.length !== list.length) writeRecent(next);
}

export function suggestedHomes() {
  const hosts = [];
  for (const { host } of recentAccounts()) {
    const h = host.toLowerCase();
    if (!hosts.includes(h)) hosts.push(h);
  }
  // The default home is a suggestion, and on the portal it is a dead one: the
  // site there runs no server, so it is not offered as a place to sign in.
  if (!hosts.includes(DEFAULT_HOME) && !isPortalHost()) hosts.push(DEFAULT_HOME);
  return hosts.slice(0, SUGGEST_MAX);
}

// A bare name is looked up on a short fixed list of likely servers, which leaks the name to them; acceptable since it only runs on Continue.

export const SEARCH_CONCURRENCY = 4;
export const SEARCH_TIMEOUT_MS = 4000;

const SEARCH_FOUND = new Set(['active', 'deactivated', 'moved']);

/// The serving server comes first on the web. Recent accounts and recommended servers already carry an API base, so only the serving server and default home need discovering.
export function searchCandidates({ recent = recentAccounts(), recommended = [], here = null } = {}) {
  const seen = new Set();
  const out = [];
  const add = (host, api) => {
    const h = typeof host === 'string' ? host.toLowerCase() : '';
    if (!h || seen.has(h)) return;
    seen.add(h);
    out.push({ host: h, api: typeof api === 'string' && api ? api : null });
  };
  // A base URL, discovered at that exact origin: it is the server that served the page.
  if (here) add(here, null);
  for (const account of recent) add(account.host, account.base);
  for (const server of recommended) add(server?.domain, server?.api_origin);
  // Not on the portal: the default home is the official site there, which runs
  // no server, and a bare-name search must not knock on its door.
  if (!isPortalHost()) add(DEFAULT_HOME, null);
  return out;
}

const within = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    () => { clearTimeout(timer); resolve(null); },
  );
});

/// Never throws; an unreachable or silent server is simply absent, in candidate order.
export async function searchName(user, candidates, {
  lookup = lookupAccount,
  find = findHome,
  concurrency = SEARCH_CONCURRENCY,
  timeoutMs = SEARCH_TIMEOUT_MS,
} = {}) {
  const results = new Array(candidates.length).fill(null);
  const ask = async ({ host, api }) => {
    let base = api;
    let serverName = host;
    if (!base) {
      const home = await find(host);
      base = home.api;
      serverName = home.serverName;
    }
    const userId = fullHandle(user, serverName);
    const { status } = await lookup(base, userId);
    return SEARCH_FOUND.has(status) ? { userId, host: serverName, api: base, status } : null;
  };
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next;
      next += 1;
      results[i] = await within(ask(candidates[i]), timeoutMs);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, candidates.length)) }, worker));
  const ids = new Set();
  return results.filter((r) => r && !ids.has(r.userId) && ids.add(r.userId));
}
