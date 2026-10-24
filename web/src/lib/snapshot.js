// Offline snapshot cache in IndexedDB; READY replaces it wholesale. A row of the wrong shape (e.g. from an older build) is deleted, never fatal.

import { cacheReady } from './local-state.js';

const DB = 'telium';
const STORE = 'snapshot';

/// Bump whenever `capture` changes what it writes.
export const VERSION = 1;

const CHANNELS = 30;
const PER_CHANNEL = 50;

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Don't block a newer tab's schema upgrade.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    // Reject rather than hang; callers carry on without the store.
    request.onblocked = () => reject(new Error('another tab is holding an older version of this database'));
  });
}

async function withStore(mode, fn) {
  let db;
  try { db = await open(); } catch { return null; }
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result?.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { return null; } finally { db.close(); }
}

/// Validates at the boundary because `apply` is also driven directly by tests.
export async function read(userId) {
  if (typeof indexedDB === 'undefined' || !userId) return null;
  await cacheReady();
  const row = await withStore('readonly', (s) => s.get(userId));
  if (row === null || row === undefined) return null;
  if (valid(row)) return row;
  console.warn('discarded an offline snapshot this build cannot read');
  await withStore('readwrite', (s) => s.delete(userId));
  return null;
}

export function write(userId, value) {
  if (typeof indexedDB === 'undefined' || !userId) return Promise.resolve(null);
  return withStore('readwrite', (s) => s.put(value, userId));
}

export function drop(userId) {
  if (typeof indexedDB === 'undefined' || !userId) return Promise.resolve(null);
  return withStore('readwrite', (s) => s.delete(userId));
}

export function clear() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return withStore('readwrite', (s) => s.clear());
}

/// Presence, typing and voice are left out: stale copies are worse than none.
export function capture(store) {
  const recent = [...store.messages.entries()]
    .filter(([, list]) => list.length)
    .sort((a, b) => lastAt(b[1]) - lastAt(a[1]))
    .slice(0, CHANNELS)
    .map(([id, list]) => [id, list.slice(-PER_CHANNEL)]);

  return {
    version: VERSION,
    saved_at: Date.now(),
    me: store.me,
    guilds: [...store.guilds.values()],
    channels: [...store.channels.values()],
    roles: [...store.roles.entries()].map(([id, map]) => [id, [...map.values()]]),
    emojis: [...store.emojis.entries()],
    readState: [...store.readState.entries()],
    conversations: store.conversations,
    messages: recent,
  };
}

function lastAt(list) {
  const last = list[list.length - 1];
  return last?.created_at || 0;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const absent = (v) => v === null || v === undefined;

const rowList = (v) => absent(v) || (Array.isArray(v) && v.every(
  (row) => isObject(row) && (typeof row.id === 'string' || typeof row.id === 'number'),
));

const entryList = (v, check) => absent(v) || (Array.isArray(v) && v.every(
  (entry) => Array.isArray(entry) && entry.length === 2 && check(entry[1]),
));

export function valid(snap) {
  if (!isObject(snap)) return false;
  if (snap.version !== VERSION) return false;
  if (!absent(snap.saved_at) && typeof snap.saved_at !== 'number') return false;
  if (!absent(snap.me) && !isObject(snap.me)) return false;
  if (!rowList(snap.guilds) || !rowList(snap.channels)) return false;
  if (!rowList(snap.conversations)) return false;
  if (!entryList(snap.roles, rowList)) return false;
  if (!entryList(snap.emojis, (v) => Array.isArray(v))) return false;
  if (!entryList(snap.readState, isObject)) return false;
  if (!entryList(snap.messages, rowList)) return false;
  return true;
}

/// Refuses a populated store and anything failing `valid`, before any write.
export function apply(store, snap) {
  if (!valid(snap)) return false;
  if (store.guilds.size) return false;

  // A half-applied snapshot (guilds without roles) looks populated and renders members permissionless; discard it all and wait for READY.
  const list = (value) => (Array.isArray(value) ? value : []);
  try {
    if (!store.me) store.me = snap.me || null;
    for (const guild of list(snap.guilds)) store.guilds.set(guild.id, guild);
    for (const channel of list(snap.channels)) store.channels.set(channel.id, channel);
    for (const [id, roles] of list(snap.roles)) {
      store.roles.set(id, new Map(list(roles).map((r) => [r.id, r])));
    }
    for (const [id, emojis] of list(snap.emojis)) store.emojis.set(id, emojis);
    for (const [id, state] of list(snap.readState)) store.readState.set(id, state);
    for (const [id, messages] of list(snap.messages)) {
      store.messages.set(id, messages);
      store.hasMore.set(id, list(messages).length > 0);
    }
    store.conversations = list(snap.conversations);
    store.cachedAt = snap.saved_at || null;
    return true;
  } catch (e) {
    console.warn('discarding an unreadable snapshot', e);
    store.guilds.clear();
    store.channels.clear();
    store.roles.clear();
    store.emojis.clear();
    store.readState.clear();
    store.messages.clear();
    store.hasMore.clear();
    store.conversations = [];
    store.cachedAt = null;
    clear().catch(() => {});
    return false;
  }
}
