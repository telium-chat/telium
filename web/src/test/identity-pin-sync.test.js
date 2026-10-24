import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  adoptSyncedPins, allIdentityPins, mergePin, pinConflict,
} from '../lib/identity-pins.js';
import { pinIdentity, readIdentityPin } from '../lib/identity-continuity.js';
import { KEYS, SyncStore } from '../lib/sync.js';
import { isSealed } from '../lib/sealed-sync.js';
import { Mls, wipe } from '../lib/mls.js';
import { Trust } from '../lib/verify.js';
import { FakeHome } from './mls-home.js';

const pin = (over = {}) => ({
  immutableId: 'tid:bob', sequence: 0, currentKey: 'K0', policyVersion: 0, policySignature: null, verified: false, ...over,
});

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  await wipe();
});

describe('merging two copies of a pin', () => {
  it('takes the further root and the newer policy of the same identity, and keeps verified', () => {
    const { pin: merged, conflict } = mergePin(
      pin({ verified: true }),
      pin({ sequence: 2, currentKey: 'K2', policyVersion: 1, policySignature: 'P1' }),
    );
    expect(conflict).toBe(false);
    expect(merged).toEqual(pin({
      sequence: 2, currentKey: 'K2', policyVersion: 1, policySignature: 'P1', verified: true,
    }));
  });

  it('takes a pin it did not have', () => {
    expect(mergePin(null, pin())).toEqual({ pin: pin(), conflict: false });
    expect(mergePin(pin(), undefined)).toEqual({ pin: pin(), conflict: false });
  });

  it('calls a different identity a conflict: verified beats unverified, otherwise this device keeps its own', () => {
    const other = pin({ immutableId: 'tid:mallory', currentKey: 'M0' });
    expect(mergePin(pin(), other)).toEqual({ pin: pin(), conflict: true });
    expect(mergePin(pin(), { ...other, verified: true })).toEqual({ pin: { ...other, verified: true }, conflict: true });
    expect(mergePin(pin({ verified: true }), { ...other, verified: true }))
      .toEqual({ pin: pin({ verified: true }), conflict: true });
  });

  it('calls two roots at one sequence, or two policies at one version, a conflict', () => {
    expect(mergePin(pin({ sequence: 1, currentKey: 'K1' }), pin({ sequence: 1, currentKey: 'X1' })).conflict).toBe(true);
    expect(mergePin(
      pin({ policyVersion: 1, policySignature: 'P1' }), pin({ policyVersion: 1, policySignature: 'Q1' }),
    ).conflict).toBe(true);
  });
});

describe('adopting the account’s pins on this device', () => {
  it('fills in what a sibling pinned, and a later identity swap is then refused here too', () => {
    const account = adoptSyncedPins({ '@b:h': pin({ sequence: 1, currentKey: 'K1' }) });
    expect(account['@b:h']).toEqual(pin({ sequence: 1, currentKey: 'K1' }));
    expect(readIdentityPin('@b:h')).toMatchObject({ immutableId: 'tid:bob', sequence: 1 });
    expect(pinIdentity('@b:h', { immutableId: 'tid:mallory', sequence: 0, currentKey: 'M0' }))
      .toMatchObject({ ok: false, reason: 'immutable-id-changed' });
    expect(pinIdentity('@b:h', { immutableId: 'tid:bob', sequence: 0, currentKey: 'K0' }))
      .toMatchObject({ ok: false, reason: 'identity-sequence-rollback' });
  });

  it('never overwrites a conflicting pin silently, and leaves the account’s copy alone', () => {
    pinIdentity('@b:h', { immutableId: 'tid:bob', sequence: 0, currentKey: 'K0' });
    const theirs = { '@b:h': pin({ immutableId: 'tid:mallory', currentKey: 'M0' }) };
    const account = adoptSyncedPins(theirs);
    expect(readIdentityPin('@b:h').immutableId).toBe('tid:bob');
    expect(pinConflict('@b:h')).toMatchObject({ local: { immutableId: 'tid:bob' }, remote: { immutableId: 'tid:mallory' } });
    expect(account['@b:h'].immutableId).toBe('tid:mallory');
  });

  it('lets a verified pin win, and pushes it when it is this device that holds it', () => {
    localStorage.setItem('telium.identity.pin.v1:@b:h', JSON.stringify(pin({ verified: true })));
    const account = adoptSyncedPins({ '@b:h': pin({ immutableId: 'tid:mallory', currentKey: 'M0' }) });
    expect(account['@b:h']).toEqual(pin({ verified: true }));
    expect(pinConflict('@b:h')).not.toBeNull();

    localStorage.clear();
    pinIdentity('@b:h', { immutableId: 'tid:mallory', sequence: 0, currentKey: 'M0' });
    adoptSyncedPins({ '@b:h': pin({ verified: true }) });
    expect(readIdentityPin('@b:h')).toEqual(pin({ verified: true }));
    expect(pinConflict('@b:h')).not.toBeNull();
  });
});

describe('pins in the sealed sync store', () => {
  function fakeAccount() {
    const account = {
      rows: {},
      api: {
        sync: vi.fn(async () => JSON.parse(JSON.stringify(account.rows))),
        syncPut: vi.fn(async (key, value) => {
          account.rows[key] = { value: JSON.parse(JSON.stringify(value)), updated_at: Date.now() };
          return { ok: true, key };
        }),
        syncDelete: vi.fn(async () => ({ ok: true })),
      },
    };
    return account;
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const ring = { key: raw, raw, retired: [], openers: [raw], mode: 'opaque_custody' };

  it('reach a new device sealed, and come back merged', async () => {
    const account = fakeAccount();
    pinIdentity('@b:h', { immutableId: 'tid:bob', sequence: 1, currentKey: 'K1' });
    const laptop = new SyncStore();
    await laptop.load(account.api);
    await laptop.adoptKeyring(ring, { current: true });
    expect(isSealed(account.rows[KEYS.identityPins].value)).toBe(true);
    expect(JSON.stringify(account.rows[KEYS.identityPins])).not.toContain('tid:bob');

    localStorage.clear();
    pinIdentity('@c:h', { immutableId: 'tid:carol', sequence: 0, currentKey: 'C0' });
    const phone = new SyncStore();
    await phone.load(account.api);
    expect(readIdentityPin('@b:h')).toBeNull();
    await phone.adoptKeyring(ring, { current: true });
    expect(readIdentityPin('@b:h')).toMatchObject({ immutableId: 'tid:bob', sequence: 1, currentKey: 'K1' });
    expect(Object.keys(allIdentityPins()).sort()).toEqual(['@b:h', '@c:h']);
    expect(Object.keys(phone.get(KEYS.identityPins)).sort()).toEqual(['@b:h', '@c:h']);
    phone.retire();
    laptop.retire();
  });

  it('follow a new pin made after load', async () => {
    const account = fakeAccount();
    const laptop = new SyncStore();
    await laptop.load(account.api);
    await laptop.adoptKeyring(ring, { current: true });
    pinIdentity('@d:h', { immutableId: 'tid:dan', sequence: 0, currentKey: 'D0' });
    expect(laptop.get(KEYS.identityPins)['@d:h']).toMatchObject({ immutableId: 'tid:dan' });
    await laptop.push();
    expect(account.api.syncPut).toHaveBeenCalledWith(KEYS.identityPins, expect.objectContaining({ sealed: 'v1' }));
    laptop.retire();
  });
});

describe('a conflicting pin, as the person is shown', () => {
  it('is shown as changed until a human verifies them again', async () => {
    const home = new FakeHome();
    const start = async (userId, deviceId) => {
      const key = crypto.getRandomValues(new Uint8Array(32));
      const mls = new Mls(home.for(userId, deviceId), { userId, deviceId, recoveryKey: key, backup: null });
      await mls.start();
      const trust = new Trust(home.for(userId, deviceId), {
        userId, deviceId, recovery: { key, raw: key, retired: [], openers: [key], mode: 'device_custody' },
      });
      await trust.start(mls.cs, key, await mls.leafKey(), 'opaque_custody');
      return { mls, trust };
    };
    const alice = await start('@a:h', 'd-alice');
    const bob = await start('@b:h', 'd-bob');
    const bobLeaf = await bob.mls.leafKey();
    await alice.trust.vouchForUser('@b:h', bob.trust.identityKey);
    await alice.trust.refresh('@b:h');
    expect(alice.trust.statusFor('@b:h', 'd-bob', bobLeaf)).toBe('verified');
    const real = readIdentityPin('@b:h');
    expect(real.verified).toBe(true);

    adoptSyncedPins({ '@b:h': pin({ immutableId: 'tid:somebody-else', currentKey: 'Z0' }) });
    expect(readIdentityPin('@b:h')).toEqual(real);
    await alice.trust.refresh('@b:h');
    expect(alice.trust.statusFor('@b:h', 'd-bob', bobLeaf)).toBe('changed');

    await alice.trust.vouchForUser('@b:h', bob.trust.identityKey);
    expect(pinConflict('@b:h')).toBeNull();
    await alice.trust.refresh('@b:h');
    expect(alice.trust.statusFor('@b:h', 'd-bob', bobLeaf)).toBe('verified');
  });
});
