import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  defaultCapabilities, defaultLifetime, encodeMlsMessage, generateKeyPackage,
} from 'ts-mls';
import { Mls, wipe } from '../lib/mls.js';
import { Backup } from '../lib/backup.js';
import { Trust } from '../lib/verify.js';
import { FakeHome, device } from './mls-home.js';

class LifecycleHome extends FakeHome {
  constructor() {
    super();
    this.revoked = new Set();
    this.serveRevokedStock = false;
    this.replayClaims = false;
  }

  revoke(userId, deviceId) { this.revoked.add(`${userId}|${deviceId}`); }

  isRevoked(userId, deviceId) { return this.revoked.has(`${userId}|${deviceId}`); }

  for(userId, deviceId) {
    const api = super.for(userId, deviceId);
    const home = this;
    return {
      ...api,
      deviceList: async (target) => {
        const answer = await api.deviceList(target);
        return { ...answer, devices: (answer.devices || []).map((d) => ({ ...d, active: !home.isRevoked(target, d.device_id) })) };
      },
      crossSigning: async () => {
        const answer = await api.crossSigning();
        return { ...answer, devices: (answer.devices || []).filter((d) => !home.isRevoked(userId, d.device_id)) };
      },
      claimKeyPackages: async (target) => {
        const answer = await api.claimKeyPackages(target);
        let rows = answer.key_packages || [];
        if (!home.serveRevokedStock) rows = rows.filter((row) => !home.isRevoked(target, row.device_id));
        if (home.replayClaims) rows = rows.flatMap((row) => [row, { ...row }]);
        return { ...answer, key_packages: rows };
      },
    };
  }
}

async function session(home, userId, deviceId, key, { mirrored = false } = {}) {
  const api = home.for(userId, deviceId);
  const backup = mirrored ? new Backup(api, { key, openers: [key] }) : null;
  const mls = new Mls(api, { userId, deviceId, recoveryKey: key, backup });
  await mls.start();
  const trust = new Trust(home.for(userId, deviceId), {
    userId, deviceId, recovery: { key, raw: key, retired: [], openers: [key], mode: 'device_custody' },
  });
  await trust.start(mls.cs, key, await mls.leafKey(), 'opaque_custody');
  mls.verifyClaimedPackage = (u, d, sig) => trust.verifyClaimedPackage(u, d, sig);
  return { mls, trust, backup };
}

const recoveryKey = () => crypto.getRandomValues(new Uint8Array(32));

async function forge(cs, identity) {
  const made = await generateKeyPackage(
    { credentialType: 'basic', identity: new TextEncoder().encode(identity) },
    defaultCapabilities(), defaultLifetime, [], cs,
  );
  const bytes = encodeMlsMessage({ version: 'mls10', wireformat: 'mls_key_package', keyPackage: made.publicPackage });
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

const leafOf = (mls, conv, userId, deviceId) => mls.devicesIn(conv).filter((d) => d.userId === userId && d.deviceId === deviceId);
const lastText = (home, conv) => home.frames.get(conv).filter((f) => f.kind === 'application').at(-1);

async function dm(home, alice, aliceDevice, bob, conv) {
  const built = await alice.mls.establish(conv, ['@b:h', '@a:h']);
  await home.for('@a:h', aliceDevice).sendFrame(conv, { kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch });
  await bob.mls.sync(conv, home.frames.get(conv));
  return built;
}

async function freshDisk() {
  globalThis.indexedDB = new IDBFactory();
  await wipe();
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  await wipe();
});

describe('a revoked device', () => {
  it('is refused a leaf on the very next claim even if the server keeps serving its stock', async () => {
    const home = new LifecycleHome();
    const bobKey = recoveryKey();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bobPhone = await session(home, '@b:h', 'd-bob-phone', bobKey);
    await session(home, '@b:h', 'd-bob-laptop', bobKey);
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob-phone', await bobPhone.mls.leafKey())).toBe(true);

    home.revoke('@b:h', 'd-bob-phone');
    home.serveRevokedStock = true;

    const built = await alice.mls.establish('conv-revoked', ['@b:h', '@a:h']);
    expect(built.rejected).toContain('@b:h (d-bob-phone)');
    expect(leafOf(alice.mls, 'conv-revoked', '@b:h', 'd-bob-phone')).toHaveLength(0);
    expect(leafOf(alice.mls, 'conv-revoked', '@b:h', 'd-bob-laptop')).toHaveLength(1);
  });

  it('cannot rejoin via a rejoin frame after revocation', async () => {
    const home = new LifecycleHome();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bobPhone = await session(home, '@b:h', 'd-bob-phone', recoveryKey());
    expect(await alice.trust.authorizedRejoinDevice('@b:h', 'd-bob-phone')).toBe(false);
    await alice.trust.vouchForUser('@b:h', bobPhone.trust.identityKey);
    expect(await alice.trust.authorizedRejoinDevice('@b:h', 'd-bob-phone')).toBe(true);
    home.revoke('@b:h', 'd-bob-phone');
    expect(await alice.trust.authorizedRejoinDevice('@b:h', 'd-bob-phone')).toBe(false);
  });

  it('keeps an existing leaf (no eviction) but is shown as unverified on the next survey', async () => {
    const home = new LifecycleHome();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bobPhone = await session(home, '@b:h', 'd-bob-phone', recoveryKey());
    await alice.trust.vouchForUser('@b:h', bobPhone.trust.identityKey);
    await dm(home, alice, 'd-alice', bobPhone, 'conv-still-in');
    const status = async () => (await alice.trust.survey(alice.mls.devicesIn('conv-still-in')))
      .find((d) => d.deviceId === 'd-bob-phone').status;
    expect(await status()).toBe('verified');

    home.revoke('@b:h', 'd-bob-phone');
    expect(leafOf(alice.mls, 'conv-still-in', '@b:h', 'd-bob-phone')).toHaveLength(1);
    await alice.mls.send('conv-still-in', 'said after revocation');
    await bobPhone.mls.sync('conv-still-in', home.frames.get('conv-still-in'));
    expect(bobPhone.mls.textOf(lastText(home, 'conv-still-in').id)).toBe('said after revocation');
    expect(await status()).toBe('unverified');
  });

  async function ownPhone(home, aliceKey) {
    const phone = await session(home, '@a:h', 'd-alice-phone', aliceKey);
    expect(phone.trust.canSign).toBe(true);
    const leaf = await phone.mls.leafKey();
    await freshDisk();
    await session(home, '@b:h', 'd-bob', recoveryKey());
    return leaf;
  }

  it('of this account is refused by a client started after the revocation', async () => {
    const home = new LifecycleHome();
    const aliceKey = recoveryKey();
    await ownPhone(home, aliceKey);
    home.revoke('@a:h', 'd-alice-phone');
    home.serveRevokedStock = true;

    const laptop = await session(home, '@a:h', 'd-alice-laptop', aliceKey);
    const built = await laptop.mls.establish('conv-own-revoked', ['@b:h', '@a:h']);
    expect(built.rejected).toContain('@a:h (d-alice-phone)');
    expect(leafOf(laptop.mls, 'conv-own-revoked', '@a:h', 'd-alice-phone')).toHaveLength(0);
  });

  it.fails('of this account is refused by a client that was already running when it was revoked', async () => {
    const home = new LifecycleHome();
    const aliceKey = recoveryKey();
    const phoneLeaf = await ownPhone(home, aliceKey);
    const laptop = await session(home, '@a:h', 'd-alice-laptop', aliceKey);
    expect(await laptop.trust.verifyClaimedPackage('@a:h', 'd-alice-phone', phoneLeaf)).toBe(true);

    home.revoke('@a:h', 'd-alice-phone');
    home.serveRevokedStock = true;

    expect(await laptop.trust.verifyClaimedPackage('@a:h', 'd-alice-phone', phoneLeaf)).toBe(false);
    const built = await laptop.mls.establish('conv-live-revoke', ['@b:h', '@a:h']);
    expect(built.rejected).toContain('@a:h (d-alice-phone)');
  });
});

describe('a claimed KeyPackage', () => {
  it('is refused when the server invents a device while expanding an existing group', async () => {
    const home = new LifecycleHome();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bob = await session(home, '@b:h', 'd-bob', recoveryKey());
    await session(home, '@c:h', 'd-carol', recoveryKey());
    await dm(home, alice, 'd-alice', bob, 'conv-expand');

    home.device('@c:h', 'server-invented').push(await forge(alice.mls.cs, '@c:h|server-invented'));
    const added = await alice.mls.addMembers('conv-expand', ['@c:h']);
    expect(added.rejected).toContain('@c:h (server-invented)');
    expect(leafOf(alice.mls, 'conv-expand', '@c:h', 'server-invented')).toHaveLength(0);
    expect(leafOf(alice.mls, 'conv-expand', '@c:h', 'd-carol')).toHaveLength(1);
  });

  it('is refused when its credential disagrees with the row, even for a legacy account', async () => {
    const home = new LifecycleHome();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bobLegacy = await device(home, '@b:h', 'd-bob-legacy');
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob-legacy', await bobLegacy.leafKey())).toBe(null);

    home.device('@b:h', 'd-bob-second').push(await forge(alice.mls.cs, '@m:h|mallory'));
    const claimed = await alice.mls.claim(['@b:h']);
    expect(claimed.rejected).toContain('@b:h (d-bob-second)');
    expect(claimed.packages.map((p) => new TextDecoder().decode(p.leafNode.credential.identity))).toEqual(['@b:h|d-bob-legacy']);
  });

  it('is neither taken nor called changed when its account could not be looked up', async () => {
    const home = new LifecycleHome();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bob = await session(home, '@b:h', 'd-bob', recoveryKey());
    const bobLeaf = await bob.mls.leafKey();
    const lookup = alice.trust.home.identityDocument;

    for (const status of [0, undefined, 502, 503, 504]) {
      alice.trust.home.identityDocument = async () => {
        throw Object.assign(new Error('Failed to fetch'), { status });
      };
      await expect(alice.trust.verifyClaimedPackage('@b:h', 'd-bob', bobLeaf))
        .rejects.toMatchObject({ unknown: true });
      expect(alice.trust.statusFor('@b:h', 'd-bob', bobLeaf)).not.toBe('changed');
      await expect(alice.mls.claim(['@b:h'])).rejects.toThrow();
    }

    alice.trust.home.identityDocument = async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    };
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob', bobLeaf)).toBe(false);
    expect(alice.trust.statusFor('@b:h', 'd-bob', bobLeaf)).toBe('changed');

    alice.trust.home.identityDocument = lookup;
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob', bobLeaf)).toBe(true);

    const list = alice.trust.home.deviceList;
    alice.trust.home.deviceList = async () => {
      throw Object.assign(new Error('Bad Gateway'), { status: 502 });
    };
    await expect(alice.trust.verifyClaimedPackage('@b:h', 'd-bob', bobLeaf))
      .rejects.toMatchObject({ unknown: true });
    expect(alice.trust.statusFor('@b:h', 'd-bob', bobLeaf)).not.toBe('changed');
    alice.trust.home.deviceList = list;
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob', bobLeaf)).toBe(true);
  });

  it('served twice in one answer gives one leaf, not a failed commit', async () => {
    const home = new LifecycleHome();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    await session(home, '@b:h', 'd-bob', recoveryKey());
    home.replayClaims = true;
    const built = await alice.mls.establish('conv-replay', ['@b:h', '@a:h']);
    expect(built.welcome).toBeTruthy();
    expect(alice.mls.devicesIn('conv-replay')).toHaveLength(2);
  });

  it('re-served for a device already in the tree commits nothing', async () => {
    const home = new LifecycleHome();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bob = await session(home, '@b:h', 'd-bob', recoveryKey());
    const stock = [...home.device('@b:h', 'd-bob')];
    await dm(home, alice, 'd-alice', bob, 'conv-respend');
    const epoch = alice.mls.epochOf('conv-respend');

    home.device('@b:h', 'd-bob').unshift(stock[0]);
    expect((await alice.mls.addMembers('conv-respend', ['@b:h'])).added).toBe(0);
    expect(leafOf(alice.mls, 'conv-respend', '@b:h', 'd-bob')).toHaveLength(1);
    expect(alice.mls.epochOf('conv-respend')).toBe(epoch);
  });

  it('that has run out is reported, never substituted, and an all-empty add throws', async () => {
    const home = new LifecycleHome();
    const bobKey = recoveryKey();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bob = await session(home, '@b:h', 'd-bob-phone', bobKey);
    await session(home, '@b:h', 'd-bob-laptop', bobKey);
    await session(home, '@c:h', 'd-carol', recoveryKey());

    home.device('@b:h', 'd-bob-phone').length = 0;
    home.device('@b:h', 'd-bob-phone').push(await forge(alice.mls.cs, '@b:h|d-bob-phone'));
    const built = await alice.mls.establish('conv-dry', ['@b:h', '@a:h']);
    expect(built.rejected).toContain('@b:h (d-bob-phone)');
    expect(leafOf(alice.mls, 'conv-dry', '@b:h', 'd-bob-laptop')).toHaveLength(1);

    home.device('@b:h', 'd-bob-phone').length = 0;
    home.lastResort.delete('@b:h|d-bob-phone');
    const second = await alice.mls.establish('conv-dry-2', ['@b:h', '@a:h']);
    expect(second.missing).toContain('@b:h (d-bob-phone)');

    await dm(home, alice, 'd-alice', bob, 'conv-empty');
    home.device('@c:h', 'd-carol').length = 0;
    home.lastResort.delete('@c:h|d-carol');
    await expect(alice.mls.addMembers('conv-empty', ['@c:h'])).rejects.toThrow(/key package/i);
    expect(alice.mls.devicesIn('conv-empty').some((d) => d.userId === '@c:h')).toBe(false);
  });

  it('falls back to the last-resort package once the one-time stock is gone, and keeps it', async () => {
    const home = new LifecycleHome();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bob = await session(home, '@b:h', 'd-bob', recoveryKey());
    expect(home.lastResort.has('@b:h|d-bob')).toBe(true);
    home.device('@b:h', 'd-bob').length = 0;
    const first = await dm(home, alice, 'd-alice', bob, 'conv-lr-1');
    const second = await dm(home, alice, 'd-alice', bob, 'conv-lr-2');
    expect(first.missing || []).not.toContain('@b:h (d-bob)');
    expect(second.missing || []).not.toContain('@b:h (d-bob)');
    expect(home.lastResort.has('@b:h|d-bob')).toBe(true);
    expect(bob.mls.devicesIn('conv-lr-1').some((d) => d.userId === '@a:h')).toBe(true);
    expect(bob.mls.devicesIn('conv-lr-2').some((d) => d.userId === '@a:h')).toBe(true);
    await bob.mls.toppingUp;
    expect(home.device('@b:h', 'd-bob').length).toBeGreaterThan(0);
  });

  it('that is refused does not mark its leaf key taken for the live device sharing it', async () => {
    const home = new LifecycleHome();
    const bobKey = recoveryKey();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bobOld = await session(home, '@b:h', 'd-bob-old', bobKey);
    const bob = await session(home, '@b:h', 'd-bob', bobKey);
    expect(await bobOld.mls.leafKey()).toBe(await bob.mls.leafKey());
    home.revoke('@b:h', 'd-bob-old');
    home.serveRevokedStock = true;

    const built = await dm(home, alice, 'd-alice', bob, 'conv-order');
    expect(built.rejected).toContain('@b:h (d-bob-old)');
    expect(leafOf(alice.mls, 'conv-order', '@b:h', 'd-bob')).toHaveLength(1);
    await alice.mls.send('conv-order', 'the live device still got in');
    await bob.mls.sync('conv-order', home.frames.get('conv-order'));
    expect(bob.mls.textOf(lastText(home, 'conv-order').id)).toBe('the live device still got in');
  });
});

describe('simultaneous commits', () => {
  it('land one, refuse the other without advancing the loser, and converge by sync', async () => {
    const home = new LifecycleHome();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bob = await session(home, '@b:h', 'd-bob', recoveryKey());
    await session(home, '@c:h', 'd-carol', recoveryKey());
    await session(home, '@d:h', 'd-dave', recoveryKey());
    await dm(home, alice, 'd-alice', bob, 'conv-race');
    const start = alice.mls.epochOf('conv-race');

    const [fromAlice, fromBob] = await Promise.allSettled([
      alice.mls.addMembers('conv-race', ['@c:h']),
      bob.mls.addMembers('conv-race', ['@d:h']),
    ]);
    expect([fromAlice, fromBob].map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const aliceWon = fromAlice.status === 'fulfilled';
    const [winner, loser, wanted] = aliceWon ? [alice, bob, '@d:h'] : [bob, alice, '@c:h'];

    expect(loser.mls.epochOf('conv-race')).toBe(start);
    await loser.mls.sync('conv-race', home.frames.get('conv-race'));
    expect(loser.mls.epochOf('conv-race')).toBe(winner.mls.epochOf('conv-race'));

    await winner.mls.send('conv-race', 'after the race');
    await loser.mls.sync('conv-race', home.frames.get('conv-race'));
    expect(loser.mls.textOf(lastText(home, 'conv-race').id)).toBe('after the race');

    expect(loser.mls.devicesIn('conv-race').some((d) => d.userId === wanted)).toBe(false);
    expect((await loser.mls.addMembers('conv-race', [wanted])).added).toBeGreaterThan(0);
  });
});

describe('history for a joining device', () => {
  it('is recovered only with the recovery keyring', async () => {
    const home = new LifecycleHome();
    const aliceKey = recoveryKey();
    const alice = await session(home, '@a:h', 'd-alice-1', aliceKey, { mirrored: true });
    const bob = await session(home, '@b:h', 'd-bob', recoveryKey());
    await dm(home, alice, 'd-alice-1', bob, 'conv-history');
    await bob.mls.send('conv-history', 'said before the new device');
    await alice.mls.sync('conv-history', home.frames.get('conv-history'));
    const said = lastText(home, 'conv-history');
    await alice.backup.flush();
    const frames = [...home.frames.get('conv-history')];

    await freshDisk();
    const locked = new Mls(home.for('@a:h', 'd-alice-locked'), { userId: '@a:h', deviceId: 'd-alice-locked', recoveryKey: null, backup: null });
    await locked.start();
    expect(await locked.selfJoin('conv-history', frames)).toBe(false);
    await locked.sync('conv-history', frames);
    await locked.pullMirror('conv-history');
    expect(locked.textOf(said.id)).toBeUndefined();

    await freshDisk();
    const api = home.for('@a:h', 'd-alice-2');
    const opened = new Mls(api, { userId: '@a:h', deviceId: 'd-alice-2', recoveryKey: aliceKey, backup: new Backup(api, { key: aliceKey, openers: [aliceKey] }) });
    await opened.start();
    await opened.sync('conv-history', frames);
    expect(opened.textOf(said.id)).toBe('said before the new device');
  });

  it('is not readable from another account’s mirror rows', async () => {
    const home = new LifecycleHome();
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey(), { mirrored: true });
    const bob = await session(home, '@b:h', 'd-bob', recoveryKey(), { mirrored: true });
    await dm(home, alice, 'd-alice', bob, 'conv-scoped');
    await alice.mls.send('conv-scoped', 'for bob and alice only');
    await bob.mls.sync('conv-scoped', home.frames.get('conv-scoped'));
    await bob.backup.flush();
    expect(home.mirrorFor('@b:h').size).toBeGreaterThan(0);

    const mallory = new Backup(home.for('@b:h', 'd-mallory'), { key: recoveryKey() });
    expect([...(await mallory.restore('conv-scoped')).values()]).toHaveLength(0);
  });

  it('cannot be joined from the sealed GroupInfo without the account key', async () => {
    const home = new LifecycleHome();
    const aliceKey = recoveryKey();
    const alice = await session(home, '@a:h', 'd-alice-1', aliceKey);
    const bob = await session(home, '@b:h', 'd-bob', recoveryKey());
    await dm(home, alice, 'd-alice-1', bob, 'conv-groupinfo');
    await alice.mls.send('conv-groupinfo', 'members only');
    const frames = [...home.frames.get('conv-groupinfo')];
    expect(frames.some((f) => f.kind === 'groupinfo')).toBe(true);

    await freshDisk();
    const impostor = await device(home, '@a:h', 'd-impostor', recoveryKey());
    expect(await impostor.selfJoin('conv-groupinfo', frames)).toBe(false);

    await freshDisk();
    const real = await device(home, '@a:h', 'd-alice-2', aliceKey);
    expect(await real.selfJoin('conv-groupinfo', frames)).toBe(true);
  });
});
