// A homeserver that strips a contact's identity (no identity key, a 404 or `exists:false` identity document) must not
// turn an identity-protected account into a "legacy" one. Legacy is only for homes that do not advertise continuity.
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Mls, wipe } from '../lib/mls.js';
import { Trust } from '../lib/verify.js';
import { FakeHome, device } from './mls-home.js';

const recoveryKey = () => crypto.getRandomValues(new Uint8Array(32));
const notFound = () => Object.assign(new Error('not found'), { status: 404 });

/// A FakeHome whose `capabilities()` answers like the real server's, or fails the way a broken one would.
class AdvertisingHome extends FakeHome {
  constructor(caps) {
    super();
    this.caps = caps;
    this.stripIdentity = new Set();
  }

  for(userId, deviceId) {
    const api = super.for(userId, deviceId);
    const home = this;
    return {
      ...api,
      capabilities: async () => {
        if (typeof home.caps === 'function') return home.caps();
        return home.caps;
      },
      identityDocument: async (target) => {
        if (home.stripIdentity.has(target)) throw notFound();
        return api.identityDocument(target);
      },
      deviceList: async (target) => {
        const answer = await api.deviceList(target);
        return home.stripIdentity.has(target) ? { ...answer, identity_key: null } : answer;
      },
    };
  }
}

async function session(home, userId, deviceId, key) {
  const api = home.for(userId, deviceId);
  const mls = new Mls(api, { userId, deviceId, recoveryKey: key, backup: null });
  await mls.start();
  const trust = new Trust(home.for(userId, deviceId), {
    userId, deviceId, recovery: { key, raw: key, retired: [], openers: [key], mode: 'device_custody' },
  });
  await trust.start(mls.cs, key, await mls.leafKey(), 'opaque_custody');
  mls.verifyClaimedPackage = (u, d, sig) => trust.verifyClaimedPackage(u, d, sig);
  return { mls, trust };
}

/// Every session here shares one localStorage; drop what the other accounts' own clients wrote about themselves, so
/// Alice has never pinned or looked at anyone.
function aliceKnowsNobody() {
  const keep = new Set(['telium.identity.pin.v1:@a:h', 'telium.identity.continuity-domain.v1:h']);
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
  for (const k of keys) {
    if (k?.startsWith('telium.identity.') && !keep.has(k)) localStorage.removeItem(k);
  }
}

const ADVERTISES = { identity: { continuity: true, protocol: 'telium-identity-v1' } };
const LEGACY = { identity: { continuity: false } };

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  await wipe();
});

describe('a contact whose identity the homeserver withholds', () => {
  it('is refused when the home advertises continuity and the identity document 404s', async () => {
    const home = new AdvertisingHome(ADVERTISES);
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bob = await session(home, '@b:h', 'd-bob', recoveryKey());
    const leaf = await bob.mls.leafKey();
    aliceKnowsNobody();
    expect(localStorage.getItem('telium.identity.pin.v1:@b:h')).toBe(null);

    // Bob's real identity, never looked at by Alice, is stripped by the home.
    home.stripIdentity.add('@b:h');
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob', leaf)).toBe(false);
    expect(await alice.trust.deviceConfirmed('@b:h', 'd-bob')).toBe(false);
    const claimed = await alice.mls.claim(['@b:h']);
    expect(claimed.rejected).toContain('@b:h (d-bob)');
    expect(claimed.packages).toHaveLength(0);
  });

  it('is refused when an advertising home says the account has no identity at all', async () => {
    const home = new AdvertisingHome(ADVERTISES);
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    // KeyPackages but no root: what a stripped account looks like (`exists:false`, no identity key).
    const bob = await device(home, '@b:h', 'd-bob');
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob', await bob.leafKey())).toBe(false);
    const claimed = await alice.mls.claim(['@b:h']);
    expect(claimed.rejected).toContain('@b:h (d-bob)');
  });

  it('is unknown, never legacy, when the home’s capabilities could not be read', async () => {
    for (const status of [0, 429, 502, 503]) {
      localStorage.clear();
      await wipe();
      globalThis.indexedDB = new IDBFactory();
      const home = new AdvertisingHome(() => { throw Object.assign(new Error('down'), { status }); });
      const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
      const bob = await device(home, '@b:h', 'd-bob');
      await expect(alice.trust.verifyClaimedPackage('@b:h', 'd-bob', await bob.leafKey()))
        .rejects.toMatchObject({ unknown: true });
      await expect(alice.mls.claim(['@b:h'])).rejects.toThrow();
    }
  });

  it('stays refused after the home stops advertising continuity', async () => {
    const home = new AdvertisingHome(ADVERTISES);
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const bob = await device(home, '@b:h', 'd-bob');
    expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob', await bob.leafKey())).toBe(false);

    home.caps = LEGACY;
    const again = new Trust(home.for('@a:h', 'd-alice'), { userId: '@a:h', deviceId: 'd-alice' });
    again.cs = alice.trust.cs;
    expect(await again.verifyClaimedPackage('@b:h', 'd-bob', await bob.leafKey())).toBe(false);
  });

  it('on a remote domain is refused too, never seen before or not, whatever form the strip takes', async () => {
    const home = new AdvertisingHome(ADVERTISES);
    const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
    const carol = await session(home, '@carol:far', 'd-carol', recoveryKey());
    const erin = await device(home, '@erin:elsewhere', 'd-erin');
    aliceKnowsNobody();

    // A remote account with a real root, stripped: 404 identity document and no identity key.
    home.stripIdentity.add('@carol:far');
    expect(await alice.trust.verifyClaimedPackage('@carol:far', 'd-carol', await carol.mls.leafKey())).toBe(false);
    // A remote account on a domain this client has never heard of, with no identity at all (`exists:false`).
    expect(await alice.trust.verifyClaimedPackage('@erin:elsewhere', 'd-erin', await erin.leafKey())).toBe(false);
    const claimed = await alice.mls.claim(['@carol:far', '@erin:elsewhere']);
    expect(claimed.rejected).toEqual(expect.arrayContaining(['@carol:far (d-carol)', '@erin:elsewhere (d-erin)']));
    expect(claimed.packages).toHaveLength(0);
  });
});

describe('a legacy homeserver', () => {
  it('still serves identity-less accounts as legacy when continuity is not advertised', async () => {
    for (const caps of [LEGACY, () => { throw notFound(); }]) {
      localStorage.clear();
      await wipe();
      globalThis.indexedDB = new IDBFactory();
      const home = new AdvertisingHome(caps);
      const alice = await session(home, '@a:h', 'd-alice', recoveryKey());
      const bob = await device(home, '@b:h', 'd-bob');
      home.stripIdentity.add('@b:h');
      expect(await alice.trust.verifyClaimedPackage('@b:h', 'd-bob', await bob.leafKey())).toBe(null);
      const claimed = await alice.mls.claim(['@b:h']);
      expect(claimed.rejected).toEqual([]);
      expect(claimed.packages).toHaveLength(1);
      const erin = await device(home, '@erin:elsewhere', 'd-erin');
      expect(await alice.trust.verifyClaimedPackage('@erin:elsewhere', 'd-erin', await erin.leafKey())).toBe(null);
    }
  });
});
