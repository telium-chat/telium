// Per-account key-value store on the home server. Values are sealed on-device under a key from the recovery keyring; last-write-wins except drafts (merged per target); a per-key counter catches replays. Writes mirror to localStorage first, so it degrades to local-only.

import { HttpError } from './api.js';
import { isSealed, open, seal, syncKeys } from './sealed-sync.js';
import {
  adoptSyncedPins, allIdentityPins, onPinsChanged, sanitizePins,
} from './identity-pins.js';
import { debounce, storage } from './util.js';

export const MIRROR_KEY = 'telium.sync.v1';
/// Whether the store was ever sealed (plaintext is then a downgrade) and whether a value was held under the live key (a retired-key value is then one).
export const STATE_KEY = 'telium.sync.state.v1';

const PUSH_DELAY = 1500;
/// Pushing less often keeps the write pattern from being a keystroke log.
const DRAFT_PUSH_DELAY = 15_000;

/// Names are readable to the server; the values are what is sealed.
export const KEYS = {
  prefs: 'prefs.v1',
  emojiRecent: 'emoji.recent.v1',
  emojiTone: 'emoji.tone.v1',
  gifFavorites: 'gif.favorites.v1',
  savedStickers: 'stickers.saved.v1',
  drafts: 'drafts.v2',
  // Merged, and only ever sealed.
  identityPins: 'identity.pins.v1',
};

/// Plaintext drafts key from a brief client: deleted from the server, never read.
const LEGACY_DRAFTS = 'drafts.v1';

const SYNCED = new Set(Object.values(KEYS));
/// Keys that have never held plaintext; the server refuses plaintext for them too.
const SEALED_ONLY = new Set([KEYS.savedStickers, KEYS.drafts, KEYS.identityPins]);

// Sized for imports from Discord and similar clients.
export const MAX_GIF_FAVORITES = 500;
export const MAX_SAVED_STICKERS = 100;
export const MAX_DRAFTS = 100;
export const MAX_DRAFT_LENGTH = 4000;
/// Newest first; the device keeps all of it.
export const MAX_SYNCED_DRAFT_BYTES = 96 * 1024;
/// So clearing a draft on one device reaches another.
const DRAFT_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULTS = {
  [KEYS.prefs]: {
    theme: 'dark', muted: {}, collapsed: {}, showCustomStatusOffline: false, trustedDomains: [],
  },
  [KEYS.emojiRecent]: [],
  [KEYS.emojiTone]: '',
  [KEYS.gifFavorites]: [],
  [KEYS.savedStickers]: [],
  [KEYS.drafts]: {},
  [KEYS.identityPins]: {},
};

/// Fields that describe the machine rather than the account (voice region, Rich Presence, noise cancellation, GIF picker size, date format, seen pins) never leave this device.
const DEVICE_FIELDS = {
  [KEYS.prefs]: [
    'voiceRegion',
    'richPresenceEnabled',
    'richPresenceGameEnabled',
    'richPresenceMusicEnabled',
    'richPresenceVideoEnabled',
    'micNoise',
    'gifSize',
    'dateFormat',
    'pinsSeen',
  ],
};

/// Read once and moved into the mirror so existing users keep their settings.
const LEGACY = [
  [KEYS.prefs, 'telium.prefs.v1', (name) => storage.get(name, null)],
  [KEYS.emojiRecent, 'telium.emoji.recent.v1', (name) => storage.get(name, null)],
  // The picker wrote the tone unquoted, so it is not JSON.
  [KEYS.emojiTone, 'telium.emoji.tone.v1', (name) => localStorage.getItem(name)],
];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/// A bare string (the local-only era) is a draft of unknown age.
function draftEntry(raw) {
  if (typeof raw === 'string') return raw ? { text: raw.slice(0, MAX_DRAFT_LENGTH), at: 0 } : null;
  if (!raw || typeof raw !== 'object') return null;
  const at = Number.isFinite(raw.at) && raw.at > 0 ? Math.floor(raw.at) : 0;
  return { text: String(raw.text || '').slice(0, MAX_DRAFT_LENGTH), at };
}

function sanitizeDrafts(value, now = Date.now()) {
  const entries = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value)
    : [];
  const rows = [];
  for (const [target, raw] of entries) {
    const entry = draftEntry(raw);
    if (!entry) continue;
    // A cleared draft is kept as a tombstone; an undated one says nothing another device needs.
    if (!entry.text && (!entry.at || now - entry.at > DRAFT_TOMBSTONE_MS)) continue;
    rows.push([String(target).slice(0, 160), entry]);
  }
  rows.sort(([a, x], [b, y]) => (y.at - x.at) || (a < b ? -1 : a > b ? 1 : 0));
  const out = {};
  let live = 0;
  let cleared = 0;
  for (const [target, entry] of rows) {
    if (target in out) continue;
    if (entry.text ? live++ >= MAX_DRAFTS : cleared++ >= MAX_DRAFTS) continue;
    out[target] = entry;
  }
  return out;
}

function sanitizeStickers(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').slice(0, 128);
    if (!id) continue;
    const origin = String(raw.origin || '').slice(0, 255);
    const tag = `${origin}\n${id}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push({ id, origin, name: String(raw.name || '').slice(0, 64) });
    if (out.length >= MAX_SAVED_STICKERS) break;
  }
  return out;
}

/// Replaces a stored value whose type differs from its default's (a null prefs row once crashed boot). Shallow on purpose, so new fields aren't dropped by older builds.
function coerce(key, value) {
  const fallback = DEFAULTS[key];
  if (fallback === undefined) return value;
  if (Array.isArray(fallback)) return Array.isArray(value) ? value : clone(fallback);
  if (typeof fallback === 'object' && fallback !== null) {
    const usable = value && typeof value === 'object' && !Array.isArray(value);
    return usable ? value : clone(fallback);
  }
  return typeof value === typeof fallback ? value : clone(fallback);
}

function sanitize(key, value) {
  value = coerce(key, value);
  if (key === KEYS.gifFavorites) {
    const out = [];
    for (const raw of Array.isArray(value) ? value : []) {
      const url = validHttpsUrl(raw);
      if (url && !out.includes(url)) out.push(url);
      if (out.length >= MAX_GIF_FAVORITES) break;
    }
    return out;
  }
  if (key === KEYS.savedStickers) return sanitizeStickers(value);
  if (key === KEYS.drafts) return sanitizeDrafts(value);
  if (key === KEYS.identityPins) return sanitizePins(value);

  // Shape is checked here, where every entry point funnels; only the container kind, so a newer build's unknown fields survive.
  const fallback = DEFAULTS[key];
  if (fallback === undefined) return value;
  if (shapeOf(value) !== shapeOf(fallback)) return clone(fallback);
  return value;
}

/// `null` is named separately since `typeof null === 'object'`.
function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

/// The newer entry per target; a tie goes to `remote`.
export function mergeDrafts(local, remote) {
  const out = { ...sanitizeDrafts(local) };
  for (const [target, entry] of Object.entries(sanitizeDrafts(remote))) {
    if (!out[target] || entry.at >= out[target].at) out[target] = entry;
  }
  return sanitizeDrafts(out);
}

export function draftText(drafts, target) {
  return draftEntry(drafts?.[target])?.text || '';
}

function draftsToSync(value) {
  const out = {};
  let size = 2;
  for (const [target, entry] of Object.entries(sanitizeDrafts(value))) {
    size += JSON.stringify(target).length + JSON.stringify(entry).length + 2;
    if (size > MAX_SYNCED_DRAFT_BYTES) break;
    out[target] = entry;
  }
  return out;
}

function shared(key, value) {
  if (key === KEYS.drafts) return draftsToSync(value);
  const fields = DEVICE_FIELDS[key];
  if (!fields || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  for (const field of fields) delete out[field];
  return out;
}

function withDeviceFields(key, remote, local) {
  const fields = DEVICE_FIELDS[key];
  if (!fields || !remote || typeof remote !== 'object' || Array.isArray(remote)) return remote;
  const out = { ...remote };
  for (const field of fields) {
    if (local && local[field] !== undefined) out[field] = local[field];
    else delete out[field];
  }
  return out;
}

export class SyncStore {
  constructor() {
    this.api = null;
    // False whenever the home server hasn't answered; degraded, not an error.
    this.online = false;
    this.entries = new Map();
    this.pending = new Set();
    // Nothing is written to the server until the recovery keyring arrives.
    this.keys = null;
    // Opened from the account's vault this session, so it is the account's current keyring (see `adoptSealed`).
    this.keysCurrent = false;
    // Drafts are synced only where the home cannot open the keyring.
    this.draftsSync = false;
    // Remote values this device cannot open and must not overwrite.
    this.stuck = new Set();
    this.sealed = false;
    // Set by an envelope under a retired key too; `sealed` would not do (see `adoptSealed`).
    this.liveSeen = false;
    this.onLoad = null;
    this.queue = Promise.resolve();
    this.readMirror();
    this.adoptLegacy();
    // The pins live in their own localStorage rows, where identity verification reads them.
    const pins = allIdentityPins();
    if (Object.keys(pins).length || this.entries.has(KEYS.identityPins)) {
      this.entries.set(KEYS.identityPins, {
        ...(this.entries.get(KEYS.identityPins) || { updated_at: 0, n: 0, live: false }),
        value: pins,
      });
    }
    this.unwatchPins = onPinsChanged(() => this.set(KEYS.identityPins, allIdentityPins()));
    // One request per burst (muting three channels, dragging the skin-tone row).
    this.schedule = debounce(() => { this.push().catch(() => {}); }, PUSH_DELAY);
    this.scheduleDrafts = debounce(() => { this.push().catch(() => {}); }, DRAFT_PUSH_DELAY);
  }

  /// Hands out the stored object itself; callers mutate then `set`.
  get(key) {
    if (!this.entries.has(key)) {
      this.entries.set(key, { value: clone(DEFAULTS[key]), updated_at: 0, n: 0, live: false });
    }
    const entry = this.entries.get(key);
    // Last gate: every reader goes through here.
    const safe = coerce(key, entry.value);
    if (safe !== entry.value) {
      console.warn('sync value had the wrong shape and was reset', key);
      entry.value = safe;
    }
    return entry.value;
  }

  set(key, value) {
    // Clock skew makes last-write-wins approximate, which is fine here.
    const previous = this.entries.get(key);
    this.entries.set(key, {
      value: sanitize(key, value),
      updated_at: Date.now(),
      n: previous?.n || 0,
      live: !!previous?.live,
    });
    this.writeMirror();
    if (!SYNCED.has(key)) return;
    this.pending.add(key);
    if (key === KEYS.drafts) this.scheduleDrafts();
    else this.schedule();
  }

  /// `current` means it was opened from the account's vault this session; held values are opened now.
  async adoptKeyring(ring, { current = false } = {}) {
    const keys = await syncKeys(ring).catch(() => null);
    if (!keys) return false;
    const same = this.keys?.kid === keys.kid && this.keys.byKid.size === keys.byKid.size;
    this.keys = keys;
    this.keysCurrent = current || (same && this.keysCurrent);
    this.draftsSync = ring.mode !== 'escrowed';
    if (!this.api) return true;
    return this.load(this.api);
  }

  /// Never throws; a down server leaves `online` false and changes queued.
  load(api) {
    this.api = api;
    return this.run(() => this.loadNow(api));
  }

  push() {
    return this.run(() => this.pushNow());
  }

  /// One at a time: interleaved runs would seal the same counter.
  run(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async loadNow(api) {
    if (this.api !== api) return false;
    let remote = null;
    try {
      remote = await api.sync();
    } catch {
      this.online = false;
      return false;
    }
    if (this.api !== api) return false;
    this.online = true;
    remote = remote && typeof remote === 'object' ? remote : {};

    // A brief client wrote draft plaintext while server-readable: deleted unread.
    if (LEGACY_DRAFTS in remote) {
      try {
        await api.syncDelete?.(LEGACY_DRAFTS);
      } catch (e) {
        if (e instanceof HttpError) console.warn('legacy draft purge refused', e);
        else this.online = false;
      }
      delete remote[LEGACY_DRAFTS];
    }

    await this.reconcile(remote);
    this.writeMirror();
    await this.pushNow();
    this.onLoad?.();
    return true;
  }

  async reconcile(remote) {
    const rows = Object.entries(remote).filter(([key]) => SYNCED.has(key));
    if (rows.some(([, row]) => isSealed(row?.value))) this.markSealed();
    this.stuck.clear();
    // Everything is opened before anything is adopted, so one authentic live-key value rules out retired keys.
    const opened = new Map();
    for (const [key, row] of rows) {
      if (!isSealed(row?.value) || !this.keys) continue;
      const result = await open(this.keys, key, row.value).catch((error) => ({ error }));
      opened.set(key, result);
      if (result.kid === this.keys.kid) this.markLive();
    }
    for (const [key, row] of rows) {
      if (isSealed(row?.value)) this.adoptSealed(key, opened.get(key));
      else this.adoptPlain(key, row || {});
    }
    // First sign-in sends the imported localStorage era up, sealed.
    const held = new Set(rows.map(([key]) => key));
    for (const key of this.entries.keys()) {
      if (SYNCED.has(key) && !held.has(key)) this.pending.add(key);
    }
  }

  adoptSealed(key, opened) {
    // Held until the keyring arrives, never overwritten meanwhile.
    if (!this.keys || !opened) { this.stuck.add(key); return; }
    if (opened.error) {
      const e = opened.error;
      // A later format or unheld key may be newer, so the key stays local; unless this is the vault's current keyring, then it is overwritten.
      if (e?.code === 'version' || (e?.code === 'unknown-key' && !this.keysCurrent)) {
        this.stuck.add(key);
        return;
      }
      // Under a held key but not authentic: ours is written back.
      console.warn('sealed sync value refused', key, e?.message);
      this.pending.add(key);
      return;
    }
    const { doc, kid } = opened;
    const mine = this.entries.get(key);
    const seen = mine?.n || 0;
    const live = kid === this.keys.kid;
    // Under a retired key (a former escrow server's, which could seal any counter): taken only where this device has nothing better and the key was never only sealed; otherwise ours is written back.
    if (!live && (SEALED_ONLY.has(key) || this.liveSeen || mine?.live)) {
      console.warn('retired-key sync value refused', key);
      this.pending.add(key);
      return;
    }
    // Authentic but older than already seen: a replay; refused and repaired.
    if (doc.n < seen) {
      console.warn('sync rollback refused', key, doc.n, '<', seen);
      this.pending.add(key);
      return;
    }
    const n = Math.max(doc.n, seen);
    // Sealed under a retired key: adopted, then resealed under the live one.
    const reseal = !live;

    if (key === KEYS.identityPins) {
      const theirs = sanitizePins(doc.v);
      const merged = adoptSyncedPins(theirs);
      this.entries.set(key, {
        value: merged,
        updated_at: Math.max(doc.t, mine?.updated_at || 0),
        n,
        live,
      });
      if (reseal || JSON.stringify(merged) !== JSON.stringify(theirs)) this.pending.add(key);
      else this.pending.delete(key);
      return;
    }
    if (key === KEYS.drafts) {
      const theirs = sanitizeDrafts(doc.v);
      const merged = mergeDrafts(mine?.value, theirs);
      this.entries.set(key, {
        value: merged,
        updated_at: Math.max(doc.t, mine?.updated_at || 0),
        n,
        live,
      });
      if (reseal || JSON.stringify(merged) !== JSON.stringify(theirs)) this.pending.add(key);
      else this.pending.delete(key);
      return;
    }
    // Newer here: written while the server was unreachable.
    if (mine && (mine.updated_at || 0) > doc.t) {
      mine.n = n;
      mine.live = mine.live || live;
      this.pending.add(key);
      return;
    }
    this.entries.set(key, {
      value: sanitize(key, withDeviceFields(key, doc.v, mine?.value)),
      updated_at: doc.t,
      n,
      live,
    });
    if (reseal) this.pending.add(key);
    else this.pending.delete(key);
  }

  /// Legacy plaintext is sealed over, unless the store is known sealed; then it is a downgrade and refused.
  adoptPlain(key, row) {
    const mine = this.entries.get(key);
    if (SEALED_ONLY.has(key) || this.sealed || (mine?.n || 0) > 0) {
      console.warn('plaintext sync value refused', key);
      if (mine) this.pending.add(key);
      return;
    }
    if (mine && (mine.updated_at || 0) > (row.updated_at || 0)) {
      this.pending.add(key);
      return;
    }
    this.entries.set(key, {
      value: sanitize(key, withDeviceFields(key, row.value, mine?.value)),
      updated_at: row.updated_at || 0,
      n: 0,
      live: false,
    });
    this.pending.add(key);
  }

  async pushNow() {
    // No keyring, no writes.
    if (!this.api || !this.keys) return;
    for (const key of [...this.pending]) {
      if (!SYNCED.has(key)) { this.pending.delete(key); continue; }
      if (this.stuck.has(key)) continue;
      if (key === KEYS.drafts && !this.draftsSync) continue;
      const entry = this.entries.get(key);
      if (!entry) { this.pending.delete(key); continue; }
      const n = (entry.n || 0) + 1;
      try {
        const sealed = await seal(this.keys, key, {
          n,
          t: entry.updated_at || 0,
          v: shared(key, entry.value),
        });
        await this.api.syncPut(key, sealed);
        this.online = true;
        this.markSealed();
        this.markLive();
      } catch (e) {
        // A refusal (over quota, key not accepted) would fail again, so drop it; a thrown fetch is the network and the queue stays.
        if (e instanceof HttpError) {
          console.warn('sync write refused', key, e);
          this.pending.delete(key);
          continue;
        }
        this.online = false;
        return;
      }
      const now = this.entries.get(key);
      if (now) {
        now.n = Math.max(now.n || 0, n);
        now.live = true;
      }
      // Written again while in flight: goes on the next push.
      if (now === entry) this.pending.delete(key);
      this.writeMirror();
    }
  }

  markSealed() {
    if (this.sealed) return;
    this.sealed = true;
    this.writeState();
  }

  markLive() {
    if (this.liveSeen) return;
    this.liveSeen = true;
    this.writeState();
  }

  writeState() {
    if (this.retired) return;
    try { storage.set(STATE_KEY, { sealed: this.sealed, live: this.liveSeen }); }
    catch { /* memory only */ }
  }

  /// Account switch: the mirror was already packed away.
  retire() {
    this.retired = true;
    this.unwatchPins?.();
    this.api = null;
    this.online = false;
  }

  /// Sign-out also drops the mirror, so another account's mutes and drafts don't outlive the session.
  detach() {
    this.api = null;
    this.online = false;
    this.keys = null;
    this.keysCurrent = false;
    this.draftsSync = false;
    this.sealed = false;
    this.liveSeen = false;
    this.entries.clear();
    this.pending.clear();
    this.stuck.clear();
    storage.remove(MIRROR_KEY);
    storage.remove(STATE_KEY);
  }

  readMirror() {
    for (const [key, row] of Object.entries(storage.get(MIRROR_KEY, null) || {})) {
      if (!row || typeof row !== 'object' || !('value' in row)) continue;
      const entry = {
        value: row.value,
        updated_at: row.updated_at || 0,
        n: Number.isSafeInteger(row.n) && row.n > 0 ? row.n : 0,
        live: row.live === true,
      };
      if (key === LEGACY_DRAFTS) {
        // Local-only drafts of the previous release.
        const drafts = this.entries.get(KEYS.drafts);
        this.entries.set(KEYS.drafts, {
          value: mergeDrafts(entry.value, drafts?.value),
          updated_at: Math.max(entry.updated_at, drafts?.updated_at || 0),
          n: drafts?.n || 0,
          live: !!drafts?.live,
        });
        continue;
      }
      if (key === KEYS.drafts && this.entries.has(key)) {
        const drafts = this.entries.get(key);
        entry.value = mergeDrafts(drafts.value, entry.value);
      }
      entry.value = sanitize(key, entry.value);
      this.entries.set(key, entry);
    }
    const state = storage.get(STATE_KEY, null);
    this.sealed = !!state?.sealed;
    this.liveSeen = !!state?.live;
  }

  writeMirror() {
    if (this.retired) return;
    try { storage.set(MIRROR_KEY, Object.fromEntries(this.entries)); }
    catch { /* private mode: this session stays in memory */ }
  }

  /// Undated, so stamped 0: fills a key the account never held and loses to anything deliberate.
  adoptLegacy() {
    for (const [key, name, read] of LEGACY) {
      if (this.entries.has(key)) continue;
      let value = null;
      try { value = read(name); } catch { value = null; }
      if (value === null || value === undefined) continue;
      // Oldest data must pass the same shape check as a new row.
      this.entries.set(key, { value: sanitize(key, value), updated_at: 0, n: 0, live: false });
      this.pending.add(key);
      storage.remove(name);
    }
    if (this.pending.size) this.writeMirror();
  }
}
