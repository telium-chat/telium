// A device of your own account that signed in after this one started (a phone joining the call) is signed, not a stranger.
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Mls, wipe } from '../lib/mls.js';
import { Trust } from '../lib/verify.js';
import { FakeHome } from './mls-home.js';

async function session(home, userId, deviceId, key) {
  const mls = new Mls(home.for(userId, deviceId), { userId, deviceId, recoveryKey: key, backup: null });
  await mls.start();
  const trust = new Trust(home.for(userId, deviceId), {
    userId, deviceId, recovery: { key, raw: key, retired: [], openers: [key], mode: 'device_custody' },
  });
  await trust.start(mls.cs, key, await mls.leafKey(), 'opaque_custody');
  return { mls, trust };
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  await wipe();
});

describe('your own devices', () => {
  it('accepts a sibling device that was signed after this one started', async () => {
    const home = new FakeHome();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const desktop = await session(home, '@a:h', 'd-desktop', key);
    const phone = await session(home, '@a:h', 'd-phone', key);
    const leaf = await phone.mls.leafKey();

    expect(await desktop.trust.verifyClaimedPackage('@a:h', 'd-phone', leaf)).toBe(true);
  });

  it('still refuses a device of yours that home does not list as signed', async () => {
    const home = new FakeHome();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const desktop = await session(home, '@a:h', 'd-desktop', key);
    const stranger = crypto.getRandomValues(new Uint8Array(32));
    const b64 = btoa(String.fromCharCode(...stranger));

    expect(await desktop.trust.verifyClaimedPackage('@a:h', 'd-ghost', b64)).toBe(false);
  });
});
