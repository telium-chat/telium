// Registry of every signed-in account; the active session stays under `SESSION_KEY`. A switch is a reload.

import { MIRROR_KEY as SYNC_MIRROR_KEY, STATE_KEY as SYNC_STATE_KEY } from './sync.js';
import { storage } from './util.js';
import { SESSION_KEY } from './store/shared.js';

export const ACCOUNTS_KEY = 'telium.accounts.v1';
export const MAX_ACCOUNTS = 5;

function read() {
  const raw = storage.get(ACCOUNTS_KEY, null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts)) return [];
  return raw.accounts.filter((a) => a && typeof a.user_id === 'string'
    && a.session?.home?.token && typeof a.session.home.base === 'string');
}

function write(accounts) {
  try { storage.set(ACCOUNTS_KEY, { accounts }); } catch { /* storage full or blocked */ }
}

export function listAccounts() {
  return read().sort((a, b) => (b.used_at || 0) - (a.used_at || 0));
}

export function accountOf(userId) {
  return read().find((a) => a.user_id === userId) || null;
}

export function rememberSession(session, { card = null, local, touch = false } = {}) {
  const userId = session?.home?.user_id;
  if (!userId || !session.home.token) return;
  const accounts = read();
  const at = accounts.findIndex((a) => a.user_id === userId);
  const prev = at >= 0 ? accounts[at] : { user_id: userId, used_at: Date.now() };
  const next = {
    ...prev,
    session,
    card: card ? { ...prev.card, ...card } : prev.card || null,
    local: local === undefined ? prev.local || null : local,
    used_at: touch ? Date.now() : prev.used_at,
  };
  if (at >= 0) accounts[at] = next; else accounts.push(next);
  write(accounts);
}

export function forgetAccount(userId) {
  write(read().filter((a) => a.user_id !== userId));
}

function packLocal() {
  return {
    sync: storage.get(SYNC_MIRROR_KEY, null),
    syncState: storage.get(SYNC_STATE_KEY, null),
  };
}

function unpackLocal(local) {
  for (const [key, value] of [[SYNC_MIRROR_KEY, local?.sync], [SYNC_STATE_KEY, local?.syncState]]) {
    if (value === null || value === undefined) storage.remove(key);
    else storage.set(key, value);
  }
}

export function stashActive(card = null) {
  const session = storage.get(SESSION_KEY, null);
  if (session?.home?.token) rememberSession(session, { card, local: packLocal() });
  storage.remove(SESSION_KEY);
  unpackLocal(null);
}

export function activate(userId) {
  const entry = accountOf(userId);
  if (!entry) return false;
  storage.set(SESSION_KEY, entry.session);
  unpackLocal(entry.local);
  rememberSession(entry.session, { local: null, touch: true });
  return true;
}

export function roomForAnother() {
  return read().length < MAX_ACCOUNTS;
}
