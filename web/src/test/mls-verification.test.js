import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { heldSecret, keepSecret, wipe } from '../lib/mls.js';
import { Trust, Verification } from '../lib/verify.js';
import { seal as sealVault } from '../lib/vault.js';
import { FakeHome, device } from './mls-home.js';
import {
  recoveryKey, freshDisk, trustFor, exchange, glyphs, sealRootUnderThrowaway,
} from './mls-helpers.js';

describe('verification', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await wipe();
  });

  it('recovers a legacy cross-signing root through a retired escrow key', async () => {
    const home = new FakeHome();
    const oldKey = await recoveryKey();
    const nextKey = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-1', nextKey);
    const pair = await alice.cs.signature.keygen();
    const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const legacySealed = await sealVault(oldKey, pair.signKey);
    home.cross.set('@a:h', {
      identity_key: encode(pair.publicKey),
      sealed_secret: legacySealed,
    });

    const ring = {
      key: nextKey,
      raw: nextKey,
      retired: [oldKey],
      openers: [nextKey, oldKey],
      mode: 'device_custody',
    };
    const trust = new Trust(home.for('@a:h', 'd-1'), {
      userId: '@a:h',
      deviceId: 'd-1',
      recovery: ring,
    });
    await trust.start(
      alice.cs,
      nextKey,
      await alice.leafKey(),
      'device_custody',
    );

    expect(trust.canSign).toBe(true);
    // Phase 1: a start never re-seals the root under a throwaway key (it used to, here, as `device-v1:`); with no
    // opaque-custody mode in hand it leaves the server's copy exactly as it was.
    expect(home.cross.get('@a:h').sealed_secret).toBe(legacySealed);
  });

  it('does not let a legacy homeserver choose the signer of stored user verification', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-1', key);
    const first = await trustFor(home, alice, '@a:h', 'd-1', key);
    const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const sign = async (secret, payload) => encode(
      await alice.cs.signature.sign(secret, new TextEncoder().encode(payload)),
    );

    const bob = await alice.cs.signature.keygen();
    const mallory = await alice.cs.signature.keygen();
    const attacker = await alice.cs.signature.keygen();
    const bobKey = encode(bob.publicKey);
    const malloryKey = encode(mallory.publicKey);
    const currentSigner = encode(first.identityKey);
    const attackerSigner = encode(attacker.publicKey);

    home.endorsedBy('@a:h').clear();
    home.endorsedBy('@a:h').set('@b:h', {
      subject: '@b:h',
      subject_key: bobKey,
      signer_key: currentSigner,
      signature: await sign(
        first.signKey,
        `telium-user-sig:v1|@a:h|@b:h|${bobKey}`,
      ),
      signed_at: 1,
    });
    home.endorsedBy('@a:h').set('@mallory:h', {
      subject: '@mallory:h',
      subject_key: malloryKey,
      signer_key: attackerSigner,
      signature: await sign(
        attacker.signKey,
        `telium-user-sig:v1|@a:h|@mallory:h|${malloryKey}`,
      ),
      signed_at: 2,
    });

    localStorage.clear();
    home.identities.delete('@a:h');
    const api = home.for('@a:h', 'd-1');
    const unsupported = async () => {
      const error = new Error('not found');
      error.status = 404;
      throw error;
    };
    api.identityContinuity = unsupported;
    api.identityDocument = unsupported;

    const ring = {
      key, raw: key, retired: [], openers: [key], mode: 'device_custody',
    };
    const reloaded = new Trust(api, {
      userId: '@a:h', deviceId: 'd-1', recovery: ring,
    });
    await reloaded.start(
      alice.cs, key, await alice.leafKey(), 'device_custody',
    );

    expect(reloaded.signed.has('@b:h')).toBe(true);
    expect(reloaded.signed.has('@mallory:h')).toBe(false);
  });

  it('refuses a homeserver replacement of this account\'s cross-signing identity', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-1', key);
    const first = await trustFor(home, alice, '@a:h', 'd-1', key);
    expect(first.canSign).toBe(true);

    const attacker = await alice.cs.signature.keygen();
    home.cross.get('@a:h').identity_key = btoa(
      String.fromCharCode(...new Uint8Array(attacker.publicKey)),
    );

    const ring = {
      key, raw: key, retired: [], openers: [key], mode: 'device_custody',
    };
    const reloaded = new Trust(home.for('@a:h', 'd-1'), {
      userId: '@a:h', deviceId: 'd-1', recovery: ring,
    });
    await reloaded.start(
      alice.cs, key, await alice.leafKey(), 'device_custody',
    );
    expect(reloaded.canSign).toBe(false);
    expect(reloaded.identityMismatch).toBe(true);
    expect(await reloaded.authorizedRejoinDevice('@a:h', 'd-1')).toBe(false);
  });

  it('a held key that is not the account\'s does not hide a sealed copy that is', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-1', key);
    const ring = { key, raw: key, retired: [], openers: [key], mode: 'opaque_custody' };
    const first = new Trust(home.for('@a:h', 'd-1'), { userId: '@a:h', deviceId: 'd-1', recovery: ring });
    await first.start(alice.cs, key, await alice.leafKey(), 'opaque_custody');
    expect(first.canSign).toBe(true);

    const stray = await alice.cs.signature.keygen();
    await keepSecret('@a:h', stray.signKey);
    const again = new Trust(home.for('@a:h', 'd-1'), { userId: '@a:h', deviceId: 'd-1', recovery: ring });
    await again.start(alice.cs, key, await alice.leafKey(), 'opaque_custody');
    expect(again.canSign).toBe(true);
    expect(again.identityMismatch).toBe(false);
    expect(again.signKey).toEqual(first.signKey);
  });

  it('refuses a handed-over key that is not the one the account publishes', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-1', key);
    await trustFor(home, alice, '@a:h', 'd-1', key);
    await freshDisk();
    const second = await device(home, '@a:h', 'd-2');
    const locked = await trustFor(home, second, '@a:h', 'd-2', null);
    const stray = await second.cs.signature.keygen();
    await expect(locked.adoptSecret(stray.signKey, null)).rejects.toThrow();
    expect(locked.canSign).toBe(false);
  });

  it('does not report your own devices verified when neither holds the account key', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const first = await device(home, '@a:h', 'd-1', key);
    const firstLeaf = await first.leafKey();
    await trustFor(home, first, '@a:h', 'd-1', key);
    // The state under test: the root sealed only under a throwaway key (as before phase 1), so no ring key opens it.
    await sealRootUnderThrowaway(home, '@a:h');
    // The broken state: this device keeps a key that is not the published one, sealed only under a throwaway.
    await keepSecret('@a:h', (await first.cs.signature.keygen()).signKey);
    const stuck = await trustFor(home, first, '@a:h', 'd-1', key);
    expect(stuck.canSign).toBe(false);

    await freshDisk();
    const second = await device(home, '@a:h', 'd-2', key);
    const other = await trustFor(home, second, '@a:h', 'd-2', key);
    expect(other.canSign).toBe(false);

    const ends = exchange(stuck, other, { keys: { a: firstLeaf, b: await second.leafKey() } });
    await ends.a.begin();
    await ends.a.confirm();
    await ends.b.confirm();
    expect(ends.a.state).not.toBe('done');
    expect(ends.b.state).not.toBe('done');
  });

  it('still hands over DM history when neither device holds the account key', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const first = await device(home, '@a:h', 'd-1', key);
    const firstLeaf = await first.leafKey();
    await trustFor(home, first, '@a:h', 'd-1', key);
    // The state under test: the root sealed only under a throwaway key (as before phase 1), so no ring key opens it.
    await sealRootUnderThrowaway(home, '@a:h');
    await keepSecret('@a:h', (await first.cs.signature.keygen()).signKey);
    const stuck = await trustFor(home, first, '@a:h', 'd-1', key);
    expect(stuck.canSign).toBe(false);

    await freshDisk();
    const second = await device(home, '@a:h', 'd-2');
    const bare = await trustFor(home, second, '@a:h', 'd-2', null);
    expect(bare.canSign).toBe(false);
    expect(bare.recovery).toBe(null);

    const ends = exchange(stuck, bare, { keys: { a: firstLeaf, b: await second.leafKey() } });
    await ends.a.begin();
    await ends.a.confirm();
    await ends.b.confirm();
    expect(bare.recovery?.raw).toEqual(key);
    expect(ends.a.state).toBe('cancelled');
    expect(ends.b.state).toBe('cancelled');
    expect(ends.b.reason).toMatch(/history was shared/);
  });

  it('waits for DM history that lands after its own half settled', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const first = await device(home, '@a:h', 'd-1', key);
    const firstLeaf = await first.leafKey();
    await trustFor(home, first, '@a:h', 'd-1', key);
    // The state under test: the root sealed only under a throwaway key (as before phase 1), so no ring key opens it.
    await sealRootUnderThrowaway(home, '@a:h');
    await keepSecret('@a:h', (await first.cs.signature.keygen()).signKey);
    const stuck = await trustFor(home, first, '@a:h', 'd-1', key);

    await freshDisk();
    const second = await device(home, '@a:h', 'd-2');
    const bare = await trustFor(home, second, '@a:h', 'd-2', null);

    // Hold the history frame until the receiving side has settled.
    let held = null;
    const ends = exchange(stuck, bare, {
      keys: { a: firstLeaf, b: await second.leafKey() },
      tamper: (e) => {
        if (e.payload.step === 'secret' && !held) { held = e; return { ...e, payload: { ...e.payload, txn: 'x' } }; }
        return e;
      },
    });
    await ends.a.begin();
    await ends.b.confirm();
    await ends.a.confirm();
    expect(held).not.toBe(null);
    expect(ends.b.state).toBe('waiting');
    await ends.b.handle(held);
    expect(bare.recovery?.raw).toEqual(key);
    expect(ends.b.state).toBe('cancelled');
    expect(ends.b.reason).toMatch(/history was shared/);
  });

  it('a create that reached the server but was never stored is found again', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-1', key);
    const api = home.for('@a:h', 'd-1');
    // The tab closes after the server took the key but before this device filed it.
    const lost = new Proxy(api, {
      get(target, name) {
        if (name !== 'putCrossSigning') return target[name];
        return async (body) => {
          await target.putCrossSigning(body);
          throw new Error('connection dropped');
        };
      },
    });
    const first = new Trust(lost, { userId: '@a:h', deviceId: 'd-1' });
    await expect(first.start(alice.cs, key, await alice.leafKey(), 'device_custody')).rejects.toThrow();
    expect(await heldSecret('@a:h')).toBe(null);

    const again = new Trust(api, { userId: '@a:h', deviceId: 'd-1' });
    await again.start(alice.cs, key, await alice.leafKey(), 'device_custody');
    expect(again.canSign).toBe(true);
    expect(again.identityMismatch).toBe(false);
  });

  it('a refused create keeps nothing of its own and takes the account key', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-1', key);
    const api = home.for('@a:h', 'd-1');
    const winner = new Trust(home.for('@a:h', 'd-9'), { userId: '@a:h', deviceId: 'd-9' });
    // Another device creates between this one's read and its write.
    let raced = false;
    const racing = new Proxy(api, {
      get(target, name) {
        if (name !== 'putCrossSigning') return target[name];
        return async (body) => {
          if (!raced) {
            raced = true;
            const saved = globalThis.indexedDB;
            globalThis.indexedDB = new IDBFactory();
            await winner.start(alice.cs, key, null, 'opaque_custody');
            globalThis.indexedDB = saved;
          }
          return target.putCrossSigning(body);
        };
      },
    });
    const ring = { key, raw: key, retired: [], openers: [key], mode: 'opaque_custody' };
    const loser = new Trust(racing, { userId: '@a:h', deviceId: 'd-1', recovery: ring });
    await loser.start(alice.cs, key, await alice.leafKey(), 'opaque_custody');
    expect(loser.identityKey).toEqual(winner.identityKey);
    expect(loser.canSign).toBe(true);
    expect(await heldSecret('@a:h')).toEqual(winner.signKey);
  });

  it('approves a fresh sibling once and transfers signing plus DM recovery', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const first = await device(home, '@a:h', 'd-1', key);
    const firstLeaf = await first.leafKey();
    const held = await trustFor(home, first, '@a:h', 'd-1', key);

    await freshDisk();
    const second = await device(home, '@a:h', 'd-2');
    const secondLeaf = await second.leafKey();
    const locked = await trustFor(home, second, '@a:h', 'd-2', null);
    expect(held.canSign).toBe(true);
    expect(locked.canSign).toBe(false);
    expect(locked.recovery).toBe(null);
    expect(locked.ready).toBe(true);

    const ends = exchange(held, locked, {
      keys: { a: firstLeaf, b: secondLeaf },
    });
    await ends.a.begin();

    expect(ends.a.emoji).toHaveLength(7);
    expect(glyphs(ends.a)).toBe(glyphs(ends.b));
    expect(ends.a.state).toBe('compare');

    await ends.a.confirm();
    await ends.b.confirm();
    expect(ends.a.state).toBe('done');
    expect(ends.b.state).toBe('done');

    expect(locked.canSign).toBe(true);
    expect(locked.recovery?.raw).toEqual(key);
    await held.refresh('@a:h');
    expect(held.statusFor('@a:h', 'd-2', secondLeaf)).toBe('verified');
    expect(held.statusFor('@a:h', 'd-1', firstLeaf)).toBe('verified');
  });

  it('does not let a real human verification bless a homeserver-owned account root', async () => {
    const home = new FakeHome();
    const aliceKey = await recoveryKey();
    const bobKey = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice', aliceKey);
    const bob = await device(home, '@b:h', 'd-bob', bobKey);
    const aliceTrust = await trustFor(home, alice, '@a:h', 'd-alice', aliceKey);
    const bobTrust = await trustFor(home, bob, '@b:h', 'd-bob', bobKey);

    const attacker = await bob.cs.signature.keygen();
    bobTrust.identityKey = attacker.publicKey;
    bobTrust.signKey = null;

    const ends = exchange(aliceTrust, bobTrust, {
      keys: { a: await alice.leafKey(), b: await bob.leafKey() },
    });
    await ends.a.begin();
    expect(glyphs(ends.a)).toBe(glyphs(ends.b));

    await ends.a.confirm();
    await ends.b.confirm();

    expect(ends.a.state).toBe('cancelled');
    expect(ends.a.reason).toContain('does not hold the account identity');
    expect(aliceTrust.signed.has('@b:h')).toBe(false);
  });

  it('covers every device a verified contact signs, including later ones', async () => {
    const home = new FakeHome();
    const aliceKey = await recoveryKey();
    const bobKey = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice', aliceKey);
    const bob = await device(home, '@b:h', 'd-bob', bobKey);
    const aliceTrust = await trustFor(home, alice, '@a:h', 'd-alice', aliceKey);
    const bobTrust = await trustFor(home, bob, '@b:h', 'd-bob', bobKey);

    await aliceTrust.refresh('@b:h');
    expect(aliceTrust.statusFor('@b:h', 'd-bob', await bob.leafKey())).toBe('unverified');

    const ends = exchange(aliceTrust, bobTrust, {
      keys: { a: await alice.leafKey(), b: await bob.leafKey() },
    });
    await ends.a.begin();
    expect(glyphs(ends.a)).toBe(glyphs(ends.b));
    await ends.a.confirm();
    await ends.b.confirm();
    expect(ends.a.state).toBe('done');

    await aliceTrust.refresh('@b:h');
    expect(aliceTrust.statusFor('@b:h', 'd-bob', await bob.leafKey())).toBe('verified');

    const laptop = await device(home, '@b:h', 'd-bob-2');
    await bobTrust.vouchForOwnDevice('d-bob-2', await laptop.leafKey());
    const surveyed = await aliceTrust.survey([
      { userId: '@b:h', deviceId: 'd-bob-2', signatureKey: await laptop.leafKey() },
    ]);
    expect(surveyed[0].status).toBe('verified');

    await aliceTrust.withdraw('@b:h');
    expect(aliceTrust.statusFor('@b:h', 'd-bob-2', await laptop.leafKey())).toBe('unverified');
  });

  it('notices a device whose key is not the one that was signed', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-1', key);
    const trust = await trustFor(home, alice, '@a:h', 'd-1', key);
    await trust.refresh('@a:h');

    const other = await device(home, '@b:h', 'd-other');
    expect(trust.statusFor('@a:h', 'd-1', await other.leafKey())).toBe('unverified');
  });

  it('accepts a SAS start frame after a homeserver reorders its JSON keys', async () => {
    const home = new FakeHome();
    const aliceKey = await recoveryKey();
    const bobKey = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice', aliceKey);
    const bob = await device(home, '@b:h', 'd-bob', bobKey);
    const aliceTrust = await trustFor(home, alice, '@a:h', 'd-alice', aliceKey);
    const bobTrust = await trustFor(home, bob, '@b:h', 'd-bob', bobKey);

    const ends = exchange(aliceTrust, bobTrust, {
      keys: { a: await alice.leafKey(), b: await bob.leafKey() },
      tamper: (envelope) => {
        if (envelope.payload.step === 'start') {
          envelope.payload = Object.fromEntries(
            Object.entries(envelope.payload).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return envelope;
      },
    });

    await ends.a.begin();
    expect(ends.a.state).toBe('compare');
    expect(ends.b.state).toBe('compare');
    expect(glyphs(ends.a)).toBe(glyphs(ends.b));

    await ends.a.confirm();
    await ends.b.confirm();
    expect(ends.a.state).toBe('done');
    expect(ends.b.state).toBe('done');
  });

  it('refuses a responder that changes its answer after seeing the nonce', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const first = await device(home, '@a:h', 'd-1', key);
    const firstLeaf = await first.leafKey();
    const held = await trustFor(home, first, '@a:h', 'd-1', key);
    await freshDisk();
    const second = await device(home, '@a:h', 'd-2');
    const secondLeaf = await second.leafKey();
    const locked = await trustFor(home, second, '@a:h', 'd-2', null);

    const ends = exchange(held, locked, {
      keys: { a: firstLeaf, b: secondLeaf },
      tamper: (envelope) => {
        if (envelope.payload.step === 'reveal') {
          const enc = envelope.payload.enc;
          envelope.payload.enc = (enc[0] === 'A' ? 'B' : 'A') + enc.slice(1);
        }
        return envelope;
      },
    });
    await ends.a.begin();

    expect(ends.a.state).toBe('cancelled');
    expect(ends.a.reason).toMatch(/changed its answer/);
    expect(ends.a.emoji).toEqual([]);
    expect(home.vouchedFor('@a:h').has('d-2')).toBe(false);
  });

  it('shows the two humans different emoji when something sits in the middle', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice', await recoveryKey());
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    const aliceTrust = await trustFor(home, alice, '@a:h', 'd-alice', await recoveryKey());
    const bobTrust = await trustFor(home, bob, '@b:h', 'd-bob', await recoveryKey());

    const asBob = { cs: alice.cs, userId: '@b:h', deviceId: 'd-bob', identityKey: null };
    const asAlice = { cs: bob.cs, userId: '@a:h', deviceId: 'd-alice', identityKey: null };
    const ends = {};
    const post = (mine, theirs) => async (payload) => {
      await ends[theirs].handle({
        from_user: ends[mine].trust.userId,
        from_device: ends[mine].trust.deviceId,
        payload,
      });
    };
    ends.alice = new Verification(aliceTrust, {
      peerUser: '@b:h', peerDevice: 'd-bob', initiator: true, txn: 'txn-test',
      send: post('alice', 'relayA'),
    });
    ends.relayA = new Verification(asBob, {
      peerUser: '@a:h', peerDevice: 'd-alice', initiator: false, txn: 'txn-test',
      send: post('relayA', 'alice'),
    });
    ends.relayB = new Verification(asAlice, {
      peerUser: '@b:h', peerDevice: 'd-bob', initiator: true, txn: 'txn-test',
      send: post('relayB', 'bob'),
    });
    ends.bob = new Verification(bobTrust, {
      peerUser: '@a:h', peerDevice: 'd-alice', initiator: false, txn: 'txn-test',
      send: post('bob', 'relayB'),
    });

    await ends.alice.begin();
    await ends.relayB.begin();
    expect(ends.alice.state).toBe('compare');
    expect(ends.bob.state).toBe('compare');
    expect(glyphs(ends.alice)).not.toBe(glyphs(ends.bob));
  });
});
