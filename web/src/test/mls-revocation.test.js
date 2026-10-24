import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Mls, wipe } from '../lib/mls.js';
import { Trust } from '../lib/verify.js';
import {
  deviceRevocationPayload, readIdentityPin, verifyIdentityDocument,
} from '../lib/identity-continuity.js';
import { FakeHome } from './mls-home.js';

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const recoveryKey = () => crypto.getRandomValues(new Uint8Array(32));

let current = null;
function machine() { return { idb: new IDBFactory(), storage: new Map() }; }
function use(disk) {
  if (current === disk) return;
  if (current) {
    current.storage = new Map(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]));
  }
  localStorage.clear();
  for (const [k, v] of disk.storage) localStorage.setItem(k, v);
  globalThis.indexedDB = disk.idb;
  current = disk;
}

async function session(home, disk, userId, deviceId, key) {
  use(disk);
  const api = home.for(userId, deviceId);
  const mls = new Mls(api, { userId, deviceId, recoveryKey: key, backup: null });
  await mls.start();
  const trust = new Trust(home.for(userId, deviceId), {
    userId, deviceId, recovery: { key, raw: key, retired: [], openers: [key], mode: 'device_custody' },
  });
  await trust.start(mls.cs, key, await mls.leafKey(), 'opaque_custody');
  mls.verifyClaimedPackage = (u, d, sig) => trust.verifyClaimedPackage(u, d, sig);
  mls.isRevokedKey = (u, k) => trust.isRevokedKey(u, k);
  return { mls, trust, disk, leaf: await mls.leafKey() };
}

async function world() {
  const home = new FakeHome();
  const bobKey = recoveryKey();
  const alice = await session(home, machine(), '@a:h', 'd-alice', recoveryKey());
  const phone = await session(home, machine(), '@b:h', 'd-bob-phone', bobKey);
  const laptop = await session(home, machine(), '@b:h', 'd-bob-laptop', bobKey);
  expect(phone.trust.canSign).toBe(true);
  expect(laptop.trust.canSign).toBe(true);
  use(phone.disk);
  await phone.trust.start(phone.mls.cs, bobKey, phone.leaf, 'opaque_custody');
  use(alice.disk);
  await alice.trust.vouchForUser('@b:h', laptop.trust.identityKey);
  return { home, bobKey, alice, phone, laptop };
}

async function sync(who, home, conv) {
  use(who.disk);
  await who.mls.sync(conv, home.frames.get(conv));
}

async function dm(home, alice, bobs, conv) {
  use(alice.disk);
  const built = await alice.mls.establish(conv, ['@b:h', '@a:h']);
  await home.for('@a:h', 'd-alice').sendFrame(conv, { kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch });
  for (const b of bobs) await sync(b, home, conv);
  return built;
}

const bobLeaves = (mls, conv) => mls.devicesIn(conv).filter((d) => d.userId === '@b:h').map((d) => d.deviceId).sort();

beforeEach(async () => {
  current = null;
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  await wipe();
});

describe('a device revoked by its account root', () => {
  it('is refused by a peer: no KeyPackage, no frames, no commits, status revoked', async () => {
    const { home, alice, phone, laptop } = await world();
    await dm(home, alice, [phone, laptop], 'conv-rev');
    use(alice.disk);
    expect(bobLeaves(alice.mls, 'conv-rev')).toEqual(['d-bob-laptop', 'd-bob-phone']);
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob-phone', phone.leaf)).toBe(true);

    use(laptop.disk);
    expect(await laptop.trust.revokeDevice('d-bob-phone')).toMatchObject({ signed: true });
    expect(laptop.trust.isRevokedKey('@b:h', phone.leaf)).toBe(true);

    use(alice.disk);
    await alice.trust.refresh('@b:h');
    expect(alice.trust.isRevokedKey('@b:h', phone.leaf)).toBe(true);
    expect(alice.trust.isRevokedKey('@b:h', laptop.leaf)).toBe(false);
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob-phone', phone.leaf)).toBe(false);
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob-laptop', laptop.leaf)).toBe(true);
    expect(alice.trust.statusFor('@b:h', 'd-bob-phone', phone.leaf)).toBe('revoked');
    expect(await alice.trust.authorizedRejoinDevice('@b:h', 'd-bob-phone', phone.leaf)).toBe(false);

    use(phone.disk);
    await phone.mls.send('conv-rev', 'from a revoked phone');
    use(laptop.disk);
    await laptop.mls.send('conv-rev', 'from the laptop');
    await sync(alice, home, 'conv-rev');
    const texts = home.frames.get('conv-rev').filter((f) => f.kind === 'application')
      .map((f) => alice.mls.textOf(f.id));
    expect(texts).toContain('from the laptop');
    expect(texts).not.toContain('from a revoked phone');

    const before = alice.mls.devicesIn('conv-rev').length;
    use(phone.disk);
    await phone.mls.removeMembers('conv-rev', ['@a:h']).catch(() => null);
    await sync(alice, home, 'conv-rev');
    expect(alice.mls.devicesIn('conv-rev')).toHaveLength(before);
    expect(alice.mls.devicesIn('conv-rev').some((d) => d.userId === '@a:h')).toBe(true);
  });

  it('has its leaf taken out by the account’s other device', async () => {
    const { home, alice, phone, laptop } = await world();
    await dm(home, alice, [phone, laptop], 'conv-out');

    use(laptop.disk);
    await laptop.trust.revokeDevice('d-bob-phone');
    const sent = [];
    const post = laptop.mls.home.sendFrame;
    laptop.mls.home.sendFrame = async (id, body) => { sent.push(body); return post(id, body); };
    expect(await laptop.mls.removeRevoked('conv-out')).toEqual({ removed: 1 });
    expect(sent.filter((b) => b.kind === 'commit')).toHaveLength(1);
    expect(bobLeaves(laptop.mls, 'conv-out')).toEqual(['d-bob-laptop']);
    expect(await laptop.mls.removeRevoked('conv-out')).toEqual({ removed: 0 });

    use(alice.disk);
    await alice.trust.refresh('@b:h');
    await sync(alice, home, 'conv-out');
    expect(alice.mls.errorFor('conv-out')).toBeUndefined();
    expect(bobLeaves(alice.mls, 'conv-out')).toEqual(['d-bob-laptop']);
  });

  it('is not revoked by a statement its root did not sign', async () => {
    const { home, alice, phone, laptop } = await world();
    const immutableId = home.identities.get('@b:h').immutable_id;
    const forger = await alice.mls.cs.signature.keygen();
    const signature = b64(await alice.mls.cs.signature.sign(
      forger.signKey, deviceRevocationPayload('@b:h', immutableId, 'd-bob-phone', phone.leaf),
    ));
    home.revocations.set('@b:h', [
      { device_id: 'd-bob-phone', mls_key: phone.leaf, immutable_id: immutableId, signer_key: b64(forger.publicKey), signature },
      { device_id: 'd-bob-phone', mls_key: phone.leaf, immutable_id: immutableId, signer_key: b64(laptop.trust.identityKey), signature },
    ]);
    use(alice.disk);
    await alice.trust.refresh('@b:h');
    expect(alice.trust.isRevokedKey('@b:h', phone.leaf)).toBe(false);
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob-phone', phone.leaf)).toBe(true);
  });
});

describe('a root rotation', () => {
  it('signed by both roots is accepted, moves the peer’s pin, and keeps the re-signed devices', async () => {
    const { home, bobKey, alice, laptop, phone } = await world();
    use(alice.disk);
    await alice.trust.refresh('@b:h');
    expect(readIdentityPin('@b:h')).toMatchObject({ sequence: 0 });
    const oldRoot = b64(laptop.trust.identityKey);

    use(laptop.disk);
    const rotated = await laptop.trust.rotateRoot({ recoveryKey: bobKey });
    expect(rotated.sequence).toBe(1);
    const newRoot = b64(laptop.trust.identityKey);
    expect(newRoot).not.toBe(oldRoot);
    expect(readIdentityPin('@b:h')).toMatchObject({ sequence: 1, currentKey: newRoot });
    const doc = home.identities.get('@b:h');
    expect(doc.transitions[0].new_key_signature).toBeTruthy();
    expect(home.cross.get('@b:h').identity_key).toBe(newRoot);

    use(alice.disk);
    await alice.trust.refresh('@b:h');
    expect(readIdentityPin('@b:h')).toMatchObject({ sequence: 1, currentKey: newRoot });
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob-laptop', laptop.leaf)).toBe(true);
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob-phone', phone.leaf)).toBe(true);
  });

  it('missing or forging the new root’s signature is refused, and the pin stays put', async () => {
    const { home, bobKey, alice, laptop } = await world();
    use(alice.disk);
    await alice.trust.refresh('@b:h');
    const pinned = readIdentityPin('@b:h');

    use(laptop.disk);
    await laptop.trust.rotateRoot({ recoveryKey: bobKey });
    const good = home.identities.get('@b:h');

    for (const signature of [null, good.transitions[0].authorization.signature]) {
      home.identities.set('@b:h', {
        ...good, transitions: [{ ...good.transitions[0], new_key_signature: signature }],
      });
      use(alice.disk);
      const checked = await verifyIdentityDocument(alice.mls.cs, home.identities.get('@b:h'), '@b:h');
      expect(checked).toMatchObject({ valid: false, reason: 'bad-new-root-signature' });
      await alice.trust.refresh('@b:h');
      expect(readIdentityPin('@b:h')).toEqual(pinned);
      expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob-laptop', laptop.leaf)).toBe(false);
    }
  });

  it('accepted before transitions were signed by the new root stays accepted', async () => {
    const { home, bobKey, alice, laptop } = await world();
    use(laptop.disk);
    await laptop.trust.rotateRoot({ recoveryKey: bobKey });
    const good = home.identities.get('@b:h');
    const legacy = { ...good, transitions: [{ ...good.transitions[0], new_key_signature: null }] };
    use(alice.disk);
    expect(await verifyIdentityDocument(alice.mls.cs, legacy, '@b:h', { legacyThrough: 1 }))
      .toMatchObject({ valid: true, sequence: 1 });
    expect(await verifyIdentityDocument(alice.mls.cs, legacy, '@b:h', { legacyThrough: 0 }))
      .toMatchObject({ valid: false });
  });
});
