// Identity pins, synced across the account's devices in the sealed sync store (`identity.pins.v1`). A merge never resolves a conflict silently: a verified pin wins, otherwise this device keeps its own, and the conflict is recorded.

import { storage } from './util.js';

export const PIN_PREFIX = 'telium.identity.pin.v1:';
const CONFLICT_PREFIX = 'telium.identity.pin.conflict.v1:';

const listeners = new Set();

export function onPinsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function pinsChanged() {
  for (const fn of listeners) {
    try { fn(); } catch { /* a listener is never a reason to fail a pin */ }
  }
}

function count(value) {
  const n = Number(value);
  return value != null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function sanitizePin(raw) {
  if (typeof raw === 'string' && raw.startsWith('tid:')) raw = { immutableId: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.immutableId !== 'string' || !raw.immutableId) return null;
  return {
    immutableId: raw.immutableId,
    sequence: count(raw.sequence),
    currentKey: typeof raw.currentKey === 'string' ? raw.currentKey : null,
    policyVersion: count(raw.policyVersion),
    policySignature: typeof raw.policySignature === 'string' ? raw.policySignature : null,
    verified: raw.verified === true,
  };
}

export function sanitizePins(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const userId of Object.keys(value).sort()) {
    if (!userId.startsWith('@')) continue;
    const pin = sanitizePin(value[userId]);
    if (pin) out[userId] = pin;
  }
  return out;
}

export function mergePin(local, remote) {
  local = sanitizePin(local);
  remote = sanitizePin(remote);
  if (!local || !remote) return { pin: local || remote, conflict: false };
  const keepOne = () => ({
    pin: remote.verified && !local.verified ? remote : local,
    conflict: true,
  });
  if (local.immutableId !== remote.immutableId) return keepOne();

  let root = local;
  if (local.sequence != null && remote.sequence != null) {
    if (
      local.sequence === remote.sequence
      && local.currentKey && remote.currentKey
      && local.currentKey !== remote.currentKey
    ) return keepOne();
    if (remote.sequence > local.sequence) root = remote;
  } else if (local.sequence == null) {
    root = remote;
  }
  const other = root === local ? remote : local;
  const currentKey = root.currentKey
    || (other.sequence === root.sequence ? other.currentKey : null);

  let policy = local;
  if (local.policyVersion != null && remote.policyVersion != null) {
    if (
      local.policyVersion === remote.policyVersion
      && local.policySignature && remote.policySignature
      && local.policySignature !== remote.policySignature
    ) return keepOne();
    if (remote.policyVersion > local.policyVersion) policy = remote;
  } else if (local.policyVersion == null) {
    policy = remote;
  }

  return {
    pin: {
      immutableId: local.immutableId,
      sequence: root.sequence,
      currentKey,
      policyVersion: policy.policyVersion,
      policySignature: policy.policySignature || local.policySignature || remote.policySignature,
      verified: local.verified || remote.verified,
    },
    conflict: false,
  };
}

export function allIdentityPins() {
  const out = {};
  if (typeof localStorage === 'undefined') return out;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PIN_PREFIX)) continue;
    out[key.slice(PIN_PREFIX.length)] = storage.get(key, null);
  }
  return sanitizePins(out);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/// A conflict leaves the account's copy as it was, unless this device holds the verified side.
export function adoptSyncedPins(remote) {
  const theirs = sanitizePins(remote);
  const mine = allIdentityPins();
  const next = { ...theirs };
  let changed = false;
  for (const userId of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const { pin, conflict } = mergePin(mine[userId], theirs[userId]);
    if (!pin) continue;
    if (conflict) {
      const record = { local: mine[userId], remote: theirs[userId] };
      const held = storage.get(CONFLICT_PREFIX + userId, null);
      if (!held || !same({ local: held.local, remote: held.remote }, record)) {
        storage.set(CONFLICT_PREFIX + userId, { ...record, at: Date.now() });
      }
      next[userId] = same(pin, mine[userId]) && pin.verified && !theirs[userId].verified
        ? pin
        : theirs[userId];
    } else {
      next[userId] = pin;
    }
    if (!same(mine[userId], pin)) {
      storage.set(PIN_PREFIX + userId, pin);
      changed = true;
    }
  }
  if (changed) pinsChanged();
  return sanitizePins(next);
}

export function pinConflict(userId) {
  return storage.get(CONFLICT_PREFIX + userId, null);
}

export function clearPinConflict(userId) {
  storage.remove(CONFLICT_PREFIX + userId);
}

export function markPinVerified(userId, immutableId = null) {
  const pin = sanitizePin(storage.get(PIN_PREFIX + userId, null));
  if (!pin || (immutableId && pin.immutableId !== immutableId)) return false;
  const had = pinConflict(userId);
  if (had) clearPinConflict(userId);
  if (pin.verified) return Boolean(had);
  storage.set(PIN_PREFIX + userId, { ...pin, verified: true });
  pinsChanged();
  return true;
}
