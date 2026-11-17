import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Mls, heldSecret, wipe } from '../lib/mls.js';
import { Backup } from '../lib/backup.js';
import { Trust, Verification } from '../lib/verify.js';
import { seal } from '../lib/vault.js';

export async function mirrored(home, userId, deviceId, key) {
  const api = home.for(userId, deviceId);
  const backup = new Backup(api, { key, openers: [key] });
  const mls = new Mls(api, { userId, deviceId, recoveryKey: key, backup });
  await mls.start();
  return { mls, backup };
}

export function recoveryKey() {
  return Promise.resolve(crypto.getRandomValues(new Uint8Array(32)));
}

export async function freshDisk() {
  globalThis.indexedDB = new IDBFactory();
  await wipe();
}

const STORE_NAMES = ['identity', 'packages', 'groups', 'opened'];

export async function legacyPut(storeName, key, value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('telium-mls', 1);
    request.onupgradeneeded = () => {
      const opened = request.result;
      for (const name of STORE_NAMES) {
        if (!opened.objectStoreNames.contains(name)) opened.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readwrite');
      t.objectStore(storeName).put(value, key);
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

/// The root as clients before phase 1 could leave it: sealed under a throwaway key only the device that made it ever
/// held (`device-v1:`). Clients no longer write this, so tests that need the state put it on the server directly.
export async function sealRootUnderThrowaway(home, userId) {
  const held = await heldSecret(userId);
  const row = home.cross.get(userId);
  home.cross.set(userId, {
    ...row,
    sealed_secret: `device-v1:${await seal(crypto.getRandomValues(new Uint8Array(32)), held)}`,
  });
}

export async function trustFor(home, mls, userId, deviceId, key = null) {
  const recovery = key ? {
    key,
    raw: key,
    retired: [],
    openers: [key],
    mode: 'device_custody',
  } : null;
  const trust = new Trust(home.for(userId, deviceId), {
    userId, deviceId, recovery,
  });
  await trust.start(mls.cs, key, await mls.leafKey());
  return trust;
}

export function exchange(a, b, { keys = {}, tamper = (e) => e } = {}) {
  const txn = 'txn-test';
  const ends = {};
  const post = (mine, theirs) => async (payload, toDevice) => {
    await ends[theirs].handle(tamper({
      from_user: ends[mine].trust.userId,
      from_device: ends[mine].trust.deviceId,
      to_user: ends[theirs].trust.userId,
      to_device: toDevice,
      payload,
    }));
  };
  ends.a = new Verification(a, {
    peerUser: b.userId, peerDevice: b.deviceId, initiator: true,
    txn, send: post('a', 'b'), mlsKey: keys.a || null,
  });
  ends.b = new Verification(b, {
    peerUser: a.userId, peerDevice: a.deviceId, initiator: false,
    txn, send: post('b', 'a'), mlsKey: keys.b || null,
  });
  return ends;
}

export const glyphs = (end) => end.emoji.map(([glyph]) => glyph).join('');
