
import { storage } from './util.js';

const DB = 'telium-device-secrets';
const VERSION = 1;
const STORE = 'secrets';
const SESSION_KEY = 'telium.session.v1';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A later tab wanting a newer schema must not be blocked by this connection.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    // Reject on blocked so a hang becomes a degraded load.
    request.onblocked = () => reject(new Error('another tab is holding an older version of this database'));
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const request = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(request ? request.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

const slot = (userId) => `dm-recovery:${userId}`;

export async function rememberRecoveryKeyring(userId, keyring) {
  if (!userId || !keyring?.raw || typeof indexedDB === 'undefined') return;
  await tx('readwrite', (store) => store.put({
    raw: new Uint8Array(keyring.raw),
    retired: (keyring.retired || []).map((key) => new Uint8Array(key)),
    saved_at: Date.now(),
  }, slot(userId)));
}

export async function heldRecoveryKeyring(userId) {
  if (!userId || typeof indexedDB === 'undefined') return null;
  const row = await tx('readonly', (store) => store.get(slot(userId))).catch(() => null);
  if (!row?.raw) return null;
  return {
    raw: new Uint8Array(row.raw),
    retired: (row.retired || []).map((key) => new Uint8Array(key)),
  };
}

// Escrow-exit pin: a server reporting an escrowed vault under another key after this device left escrow is a downgrade; only choosing escrow clears it.
const pin = (userId) => `escrow-exit:${userId}`;

export async function pinOutOfEscrow(userId) {
  if (!userId || typeof indexedDB === 'undefined') return;
  await tx('readwrite', (store) => store.put({ at: Date.now() }, pin(userId))).catch(() => {});
}

export async function unpinOutOfEscrow(userId) {
  if (!userId || typeof indexedDB === 'undefined') return;
  await tx('readwrite', (store) => store.delete(pin(userId))).catch(() => {});
}

export async function pinnedOutOfEscrow(userId) {
  if (!userId || typeof indexedDB === 'undefined') return false;
  const row = await tx('readonly', (store) => store.get(pin(userId))).catch(() => null);
  return Boolean(row);
}

export async function forgetDeviceSecrets(userId) {
  if (!userId || typeof indexedDB === 'undefined') return;
  const sessionHome = storage.get(SESSION_KEY, null)?.home || null;
  const androidCleanup = sessionHome?.user_id === userId
    ? import('./android-notifications.js')
      .then(({ retireAndroidNotifications }) => retireAndroidNotifications(sessionHome))
      .catch(() => {})
    : Promise.resolve();
  const recoveryCleanup = tx('readwrite', (store) => {
    store.delete(pin(userId));
    return store.delete(slot(userId));
  }).catch(() => {});
  await Promise.allSettled([recoveryCleanup, androidCleanup]);
}

export async function wipeDeviceSecrets() {
  // Capture now: the Android cleanup is async and may run after the WebView session is gone.
  const sessionHome = storage.get(SESSION_KEY, null)?.home || null;
  const androidCleanup = sessionHome
    ? import('./android-notifications.js')
      .then(({ retireAndroidNotifications }) => retireAndroidNotifications(sessionHome))
      .catch(() => {})
    : Promise.resolve();

  const recoveryCleanup = typeof indexedDB === 'undefined'
    ? Promise.resolve()
    : tx('readwrite', (store) => store.clear()).catch(() => {});

  await Promise.allSettled([recoveryCleanup, androidCleanup]);
}
