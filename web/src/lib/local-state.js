// Layers: `readStored` validates shape; a poison-pill counter clears cache state after repeated start-up faults; a reset is reachable from the error screen. Identity state is cleared only by `clearIdentityState`, behind a confirmation listing `IDENTITY_COSTS`.

/// localStorage so it is readable synchronously before boot.
const HEALTH_KEY = 'telium.boot-health.v1';

const FAULT_THRESHOLD = 2;

/// A keep-list so new keys default to discardable. The pending recovery key is shown once; OPAQUE pins block downgrade attacks; drafts exist nowhere else.
const PRESERVED_KEYS = [
  'telium.session.v1',
  'telium.accounts.v1',
  'telium.pending-account-recovery.v1',
  'telium.dm-drafts.local.v1',
];
const PRESERVED_PREFIXES = ['telium.auth.opaque.v1:'];

/// Duplicated from `snapshot.js`, `mls.js` and `device-secrets.js` so a reset works when those can't load; tests check they match.
const CACHE_DATABASES = ['telium'];
const IDENTITY_DATABASES = ['telium-mls', 'telium-device-secrets'];

export const CACHE_COSTS = [
  'The offline copy of your guilds, channels and recent messages.',
  'Your locally mirrored preferences, until the next sync brings them back.',
  'Anything the service worker had cached for offline use.',
];
export const IDENTITY_COSTS = [
  'This device’s MLS signing identity. It will be a new device to everyone you talk to, and they will see it as unverified until you verify it again.',
  'The stored group state for every encrypted conversation. Messages already on this device stay readable only if the account’s recovery key can reopen them; anything this device is the last holder of is gone.',
  'The cached DM recovery keyring, so the next sign-in has to unlock the key vault again — with your recovery key or passphrase, which you will need to have.',
  'Your session. You will be signed out on this device.',
];

export function readStored(key, validate, { store = localStorage, onDiscard } = {}) {
  let raw = null;
  try { raw = store?.getItem(key) ?? null; } catch { return null; }
  if (raw === null) return null;

  let value = null;
  try { value = JSON.parse(raw); } catch {
    discard(store, key, onDiscard, 'not JSON');
    return null;
  }

  let ok = false;
  // The validator runs guarded; it may dereference a hostile object.
  try { ok = validate ? validate(value) === true : true; } catch { ok = false; }
  if (ok) return value;

  discard(store, key, onDiscard, 'wrong shape');
  return null;
}

function discard(store, key, onDiscard, why) {
  try { store?.removeItem(key); } catch { /* nothing to remove it from */ }
  try { onDiscard?.(why); } catch { /* a reporter must not become the failure */ }
  console.warn(`discarded local state at ${key}: ${why}`);
}

let opened = false;
let healed = false;
let cacheReadyPromise = Promise.resolve();

function readLedger() {
  const value = readStored(HEALTH_KEY, (v) => (
    v !== null && typeof v === 'object' && typeof v.faults === 'number'
  ));
  return value ? { faults: Math.max(0, Math.trunc(value.faults)), reason: value.reason || '' } : { faults: 0, reason: '' };
}

function writeLedger(ledger) {
  try { localStorage.setItem(HEALTH_KEY, JSON.stringify(ledger)); }
  catch { /* a browser that will not remember simply never self-heals */ }
}

/// Server errors don't count: they have their own screen.
export function noteBootFault(reason = '') {
  if (opened) return 0;
  const ledger = readLedger();
  const next = { faults: ledger.faults + 1, reason: String(reason).slice(0, 200) };
  writeLedger(next);
  return next.faults;
}

export function noteBootHealthy() {
  if (opened) return;
  opened = true;
  if (readLedger().faults === 0) return;
  try { localStorage.removeItem(HEALTH_KEY); }
  catch { /* nothing to clear */ }
}

export function bootFaults() { return readLedger().faults; }

export function healedThisBoot() { return healed; }

export function cacheReady() { return cacheReadyPromise; }

/// Returns synchronously whether it is healing; the database clear is a promise `snapshot.read` awaits.
export function beginBoot() {
  const ledger = readLedger();
  if (ledger.faults < FAULT_THRESHOLD) return false;

  healed = true;
  // Reset the ledger first so a throwing clear can't arm another heal next load.
  writeLedger({ faults: 0, reason: '' });
  clearLocalStorageCache();
  cacheReadyPromise = clearCacheDatabases().catch(() => {});
  return true;
}

function teliumKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (typeof key === 'string' && key.startsWith('telium.')) keys.push(key);
    }
  } catch { return []; }
  return keys;
}

function preserved(key) {
  return PRESERVED_KEYS.includes(key) || PRESERVED_PREFIXES.some((p) => key.startsWith(p));
}

function clearLocalStorageCache() {
  for (const key of teliumKeys()) {
    if (preserved(key)) continue;
    try { localStorage.removeItem(key); } catch { /* keep going */ }
  }
}

/// A blocked delete resolves false rather than hanging on another tab.
function dropDatabase(name) {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(false); return; }
    let request;
    try { request = indexedDB.deleteDatabase(name); } catch { resolve(false); return; }
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
    request.onblocked = () => resolve(false);
  });
}

async function clearCacheDatabases() {
  await Promise.all(CACHE_DATABASES.map(dropDatabase));
}

/// Includes Telium's service worker caches, since a half-written precache can blank the page.
export async function clearCacheState() {
  clearLocalStorageCache();
  await clearCacheDatabases();
  if (typeof caches === 'undefined') return;
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('telium')).map((n) => caches.delete(n)));
  } catch { /* no cache storage in this context */ }
}

/// `store` is best-effort: its `signOut` flushes the history mirror before group states go, but a broken store doesn't stop the wipe.
export async function clearIdentityState(store) {
  // Account list first, so the sign-out below is the last account's and wipes everything.
  try { localStorage.removeItem('telium.accounts.v1'); } catch { /* keep going */ }
  try { await store?.signOut?.(); } catch (e) { console.warn('sign-out during reset failed', e); }
  // PRESERVED_KEYS only, not prefixes: the OPAQUE pin must survive a reset or it becomes a downgrade attack.
  for (const key of [...PRESERVED_KEYS, HEALTH_KEY]) {
    // Drafts are user text, not identity.
    if (key === 'telium.dm-drafts.local.v1') continue;
    try { localStorage.removeItem(key); } catch { /* keep going */ }
  }
  try { sessionStorage.removeItem('telium.pending-account-recovery.v1'); } catch { /* none */ }
  await Promise.all(IDENTITY_DATABASES.map(dropDatabase));
}

export const DATABASES = { cache: CACHE_DATABASES, identity: IDENTITY_DATABASES };
export const HEALTH_STORAGE_KEY = HEALTH_KEY;
export const FAULTS_BEFORE_HEAL = FAULT_THRESHOLD;

export function resetBootHealthForTests() {
  opened = false;
  healed = false;
  cacheReadyPromise = Promise.resolve();
}
