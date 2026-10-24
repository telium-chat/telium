// IndexedDB layer under the MLS state: one database, four stores, and a cross-tab lock.

const DB = 'telium-mls';
const VERSION = 1;
export const IDENTITY = 'identity';
export const PACKAGES = 'packages';
export const GROUPS = 'groups';
export const OPENED = 'opened';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [IDENTITY, PACKAGES, GROUPS, OPENED]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
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

async function tx(store, mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const request = fn(t.objectStore(store));
      // `result` is readable only after commit; `undefined` is a valid `get` answer.
      t.oncomplete = () => resolve(request ? request.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const put = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

/// Lock shared by every tab: two tabs advancing the same ratchet would reuse a generation. Without Web Locks it serialises per tab.
export function exclusive(name, fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  return locks?.request ? locks.request(name, () => fn()) : fn();
}

/// Filed under the account scope, never the conversation alone: a state read by the wrong account decodes plausibly and fails later in the key schedule.
export const all = (store, prefix) => tx(store, 'readonly', (s) => s.getAll(
  IDBKeyRange.bound(`${prefix}:`, `${prefix};`, false, true),
));

/// One pass, since a cursor transaction auto-commits when control yields.
export async function rows(store) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const found = [];
      const t = db.transaction(store, 'readonly');
      const request = t.objectStore(store).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        found.push([cursor.key, cursor.value]);
        cursor.continue();
      };
      t.oncomplete = () => resolve(found);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

/// Kept in the identity store so sign-out clears it; a leftover key would sign devices as you.
export async function keepSecret(userId, secret) {
  await put(IDENTITY, `crosssign:${userId}`, { secret, created_at: Date.now() });
}

export async function heldSecret(userId) {
  const stored = await get(IDENTITY, `crosssign:${userId}`).catch(() => null);
  return stored ? new Uint8Array(stored.secret) : null;
}

/// A leftover group state is a readable copy of its conversations.
export async function wipe() {
  if (typeof indexedDB === 'undefined') return;
  for (const store of [IDENTITY, PACKAGES, GROUPS, OPENED]) {
    await tx(store, 'readwrite', (s) => s.clear()).catch(() => {});
  }
}

/// The scope itself, `scope:`/legacy `scope|` prefixes, and `<kind>:scope`.
export async function wipeScope(scope) {
  if (typeof indexedDB === 'undefined' || !scope) return;
  const mine = (key) => typeof key === 'string' && (
    key === scope || key.startsWith(`${scope}:`) || key.startsWith(`${scope}|`)
    || key.endsWith(`:${scope}`)
  );
  for (const store of [IDENTITY, PACKAGES, GROUPS, OPENED]) {
    const keys = (await rows(store).catch(() => [])).map(([k]) => k).filter(mine);
    if (!keys.length) continue;
    await tx(store, 'readwrite', (s) => { for (const k of keys) s.delete(k); }).catch(() => {});
  }
}
