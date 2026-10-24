import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  defaultCapabilities, defaultLifetime, encodeMlsMessage, generateKeyPackage,
} from 'ts-mls';
import { decodeBody, encodeBody, wipe } from '../lib/mls.js';
import { open as openVault } from '../lib/vault.js';
import { FakeHome, device } from './mls-home.js';
import { mirrored, recoveryKey, freshDisk, trustFor } from './mls-helpers.js';

describe('mls', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  it('rejects a KeyPackage relabelled as another account or device', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');

    const relabelled = await generateKeyPackage(
      {
        credentialType: 'basic',
        identity: new TextEncoder().encode('@mallory:h|original-device'),
      },
      defaultCapabilities(),
      defaultLifetime,
      [],
      alice.cs,
    );
    const encoded = encodeMlsMessage({
      version: 'mls10',
      wireformat: 'mls_key_package',
      keyPackage: relabelled.publicPackage,
    });
    home.device('@b:h', 'claimed-device').push(
      btoa(String.fromCharCode(...new Uint8Array(encoded))),
    );

    const claimed = await alice.claim(['@b:h']);
    expect(claimed.packages).toHaveLength(0);
    expect(claimed.rejected).toEqual(['@b:h (claimed-device)']);
  });

  it('does not admit a homeserver-injected unsigned device to a new MLS group', async () => {
    const home = new FakeHome();
    const aliceKey = await recoveryKey();
    const bobKey = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice', aliceKey);
    const bob = await device(home, '@b:h', 'd-bob', bobKey);
    const aliceTrust = await trustFor(home, alice, '@a:h', 'd-alice', aliceKey);
    await trustFor(home, bob, '@b:h', 'd-bob', bobKey);

    const fake = await generateKeyPackage(
      {
        credentialType: 'basic',
        identity: new TextEncoder().encode('@b:h|evil'),
      },
      defaultCapabilities(),
      defaultLifetime,
      [],
      bob.cs,
    );
    const encoded = encodeMlsMessage({
      version: 'mls10',
      wireformat: 'mls_key_package',
      keyPackage: fake.publicPackage,
    });
    const binary = String.fromCharCode(...new Uint8Array(encoded));
    home.device('@b:h', 'evil').push(btoa(binary));

    alice.verifyClaimedPackage = (userId, deviceId, signatureKey) => (
      aliceTrust.verifyClaimedPackage(userId, deviceId, signatureKey)
    );

    const built = await alice.establish('conv-injected-device', ['@b:h', '@a:h']);
    expect(built.welcome).toBeTruthy();
    expect(built.rejected).toContain('@b:h (evil)');

    const devices = alice.devicesIn('conv-injected-device');
    expect(devices.some((d) => d.userId === '@b:h' && d.deviceId === 'd-bob')).toBe(true);
    expect(devices.some((d) => d.userId === '@b:h' && d.deviceId === 'evil')).toBe(false);
  });

  it('fails closed when a verified contact\'s identity goes missing', async () => {
    const home = new FakeHome();
    const aliceKey = await recoveryKey();
    const bobKey = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice', aliceKey);
    const bob = await device(home, '@b:h', 'd-bob', bobKey);
    const aliceTrust = await trustFor(home, alice, '@a:h', 'd-alice', aliceKey);
    await trustFor(home, bob, '@b:h', 'd-bob', bobKey);
    const bobLeaf = await bob.leafKey();
    const seen = await aliceTrust.refresh('@b:h');
    expect(await aliceTrust.verifyClaimedPackage('@b:h', 'd-bob', bobLeaf)).toBe(true);

    aliceTrust.signed.set('@b:h', { subject_key: seen.identityKey, subject_identity_id: seen.immutableId });
    localStorage.clear();
    home.cross.delete('@b:h');
    home.identities.delete('@b:h');
    expect(await aliceTrust.verifyClaimedPackage('@b:h', 'd-bob', bobLeaf)).toBe(false);
    expect(aliceTrust.statusFor('@b:h', 'd-bob', bobLeaf)).toBe('changed');

    await device(home, '@c:h', 'd-carol');
    expect(await aliceTrust.verifyClaimedPackage('@c:h', 'd-carol', 'any-key')).toBe(null);
    expect(aliceTrust.statusFor('@c:h', 'd-carol', 'any-key')).toBe('unsigned');
  });

  it('refuses a Welcome into a group named for another conversation', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-elsewhere', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-target', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-target', home.frames.get('conv-target'));
    expect(bob.joined('conv-target')).toBe(false);
  });

  it('does not let a Welcome replace a group the device is still in', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    const built = await alice.establish('conv-swap', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-swap', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-swap', home.frames.get('conv-swap'));
    expect(bob.joined('conv-swap')).toBe(true);

    const elsewhere = new FakeHome();
    elsewhere.device('@b:h', 'd-bob').push(home.device('@b:h', 'd-bob')[0]);
    await device(elsewhere, '@d:h', 'd-dave');
    const carol = await device(elsewhere, '@c:h', 'd-carol');
    const theirs = await carol.establish('conv-swap', ['@d:h']);
    await elsewhere.for('@c:h', 'd-carol').sendFrame('conv-swap', {
      kind: 'welcome', ciphertext: theirs.welcome, epoch: theirs.epoch,
    });
    await carol.addMembers('conv-swap', ['@b:h']);
    const forged = elsewhere.frames.get('conv-swap').findLast((f) => f.kind === 'welcome');
    expect(forged.epoch).toBeGreaterThan(1);
    await home.for('@a:h', 'd-alice').sendFrame('conv-swap', {
      kind: 'welcome', ciphertext: forged.ciphertext, epoch: forged.epoch,
    });

    await alice.send('conv-swap', 'still the real group');
    await bob.sync('conv-swap', home.frames.get('conv-swap'));
    expect(bob.devicesIn('conv-swap').some((d) => d.userId === '@c:h')).toBe(false);
    const message = home.frames.get('conv-swap').find((f) => f.kind === 'application');
    expect(bob.textOf(message.id)).toBe('still the real group');
  });

  it('still takes the Welcome of a conversation started over', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    const first = await alice.establish('conv-over', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-over', {
      kind: 'welcome', ciphertext: first.welcome, epoch: first.epoch,
    });
    await bob.sync('conv-over', home.frames.get('conv-over'));
    expect(bob.joined('conv-over')).toBe(true);

    await alice.forget('conv-over');
    const again = await alice.establish('conv-over', ['@b:h'], {
      from: home.frames.get('conv-over').length,
    });
    await home.for('@a:h', 'd-alice').sendFrame('conv-over', {
      kind: 'welcome', ciphertext: again.welcome, epoch: again.epoch,
    });
    await alice.send('conv-over', 'from the new group');
    await bob.sync('conv-over', home.frames.get('conv-over'));
    const message = home.frames.get('conv-over').find((f) => f.kind === 'application');
    expect(bob.textOf(message.id)).toBe('from the new group');
  });

  it('refuses a Welcome whose tree holds a device its owner did not sign', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    bob.verifyClaimedPackage = async (userId) => userId !== '@a:h';

    const built = await alice.establish('conv-unsigned', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-unsigned', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-unsigned', home.frames.get('conv-unsigned'));
    expect(bob.joined('conv-unsigned')).toBe(false);
  });

  it('carries a message between two devices without the server reading it', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-1', ['@b:h', '@a:h']);
    expect(built.welcome).toBeTruthy();
    expect(built.missing).toEqual([]);

    await home.for('@a:h', 'd-alice').sendFrame('conv-1', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await alice.send('conv-1', 'the eagle has landed');

    const frames = home.frames.get('conv-1');
    await bob.sync('conv-1', frames);

    const message = frames.find((f) => f.kind === 'application');
    expect(bob.textOf(message.id)).toBe('the eagle has landed');
    expect(message.ciphertext).not.toContain(btoa('the eagle'));
    expect(atob(message.ciphertext)).not.toContain('eagle');
  });

  it('lets both sides talk, in both directions', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-2', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-2', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await alice.send('conv-2', 'first');
    await bob.sync('conv-2', home.frames.get('conv-2'));
    await bob.send('conv-2', 'second');
    await alice.sync('conv-2', home.frames.get('conv-2'));

    const frames = home.frames.get('conv-2').filter((f) => f.kind === 'application');
    expect(bob.textOf(frames[0].id)).toBe('first');
    expect(alice.textOf(frames[1].id)).toBe('second');
    expect(alice.textOf(frames[0].id)).toBe('first');
  });

  it('survives a reload, because the group state is on disk', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-3', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-3', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-3', home.frames.get('conv-3'));

    const reloaded = await device(home, '@a:h', 'd-alice');
    await reloaded.sync('conv-3', home.frames.get('conv-3'));
    await reloaded.send('conv-3', 'still me');

    await bob.sync('conv-3', home.frames.get('conv-3'));
    const last = home.frames.get('conv-3').filter((f) => f.kind === 'application').pop();
    expect(bob.textOf(last.id)).toBe('still me');
  });

  it('still shows what it already opened after a reload', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-r', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-r', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await alice.send('conv-r', 'read me once');
    await bob.sync('conv-r', home.frames.get('conv-r'));

    const reloaded = await device(home, '@b:h', 'd-bob');
    await reloaded.sync('conv-r', home.frames.get('conv-r'));
    const said = home.frames.get('conv-r').find((f) => f.kind === 'application');
    expect(reloaded.textOf(said.id)).toBe('read me once');
  });

  it('cannot read what was said before it was let in', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    const carol = await device(home, '@c:h', 'd-carol');

    const built = await alice.establish('conv-4', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-4', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await alice.send('conv-4', 'before carol');
    await bob.sync('conv-4', home.frames.get('conv-4'));

    await alice.addMembers('conv-4', ['@c:h']);
    await alice.send('conv-4', 'after carol');
    await carol.sync('conv-4', home.frames.get('conv-4'));

    const said = home.frames.get('conv-4').filter((f) => f.kind === 'application');
    expect(carol.textOf(said[0].id)).toBeUndefined();
    expect(carol.textOf(said[1].id)).toBe('after carol');
    await bob.sync('conv-4', home.frames.get('conv-4'));
    expect(bob.textOf(said[1].id)).toBe('after carol');
  });

  it('walks up to a window from the newest end before trying to read it', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    const carol = await device(home, '@c:h', 'd-carol');
    await device(home, '@d:h', 'd-dave');

    const built = await alice.establish('conv-w', ['@b:h', '@c:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-w', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-w', home.frames.get('conv-w'));
    await carol.sync('conv-w', home.frames.get('conv-w'));

    await alice.send('conv-w', 'under the window');
    await alice.addMembers('conv-w', ['@d:h']);
    await alice.send('conv-w', 'the newest thing said');

    const frames = home.frames.get('conv-w');
    const shown = frames.slice(-1);
    const said = frames.filter((f) => f.kind === 'application');

    await bob.sync('conv-w', shown, { backfill: true });
    await carol.sync('conv-w', shown);

    expect(bob.textOf(said[1].id)).toBe('the newest thing said');
    expect(bob.textOf(said[0].id)).toBe('under the window');
    expect(carol.textOf(said[1].id)).toBe('the newest thing said');
    expect(carol.textOf(said[0].id)).toBe('under the window');
  });

  it('does not walk over a hole its home says it could not fill', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    await device(home, '@d:h', 'd-dave');

    const built = await alice.establish('conv-h', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-h', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-h', home.frames.get('conv-h'));

    await alice.send('conv-h', 'below the hole');
    await alice.addMembers('conv-h', ['@d:h']);
    await alice.send('conv-h', 'above the hole');
    const frames = home.frames.get('conv-h');
    const commit = frames.find((f) => f.kind === 'commit');
    const said = frames.filter((f) => f.kind === 'application');
    home.missing = new Map([['conv-h', new Set([commit.seq])]]);

    await bob.sync('conv-h', frames.slice(-1), { backfill: true });
    expect(bob.textOf(said[0].id)).toBe('below the hole');
    expect(bob.textOf(said[1].id)).toBeUndefined();
    expect(bob.walkedTo('conv-h')).toBe(commit.seq - 1);
    expect(bob.failed.get('conv-h')).toBeUndefined();

    home.missing = null;
    await bob.sync('conv-h', frames.slice(-1), { backfill: true });
    expect(bob.textOf(said[1].id)).toBe('above the hole');
  });

  it('does not bury a frame that arrives after one sequenced above it', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-o', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-o', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-o', home.frames.get('conv-o'));

    await alice.send('conv-o', 'sequenced first');
    await alice.send('conv-o', 'delivered first');
    const said = home.frames.get('conv-o').filter((f) => f.kind === 'application');

    await bob.sync('conv-o', [said[1]]);
    await bob.sync('conv-o', [said[0]]);

    expect(bob.textOf(said[0].id)).toBe('sequenced first');
    expect(bob.textOf(said[1].id)).toBe('delivered first');
    expect(bob.failed.get('conv-o')).toBeUndefined();
  });

  it('keeps talking after a send whose answer was lost', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-l', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-l', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-l', home.frames.get('conv-l'));

    const real = alice.home.sendFrame;
    alice.home.sendFrame = async (...args) => {
      await real(...args);
      throw new Error('the connection dropped before the answer');
    };
    await expect(alice.send('conv-l', 'sent, unanswered')).rejects.toThrow();
    alice.home.sendFrame = real;
    await alice.send('conv-l', 'sent again');

    await bob.sync('conv-l', home.frames.get('conv-l'));
    const said = home.frames.get('conv-l').filter((f) => f.kind === 'application');
    expect(said.map((f) => bob.textOf(f.id))).toEqual(['sent, unanswered', 'sent again']);
    expect(bob.failed.get('conv-l')).toBeUndefined();
  });

  it('reports the devices it could not reach instead of dropping them', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    home.device('@b:h', 'd-bob-phone');

    const built = await alice.establish('conv-5', ['@b:h']);
    expect(built.missing).toEqual(['@b:h (d-bob-phone)']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-5', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-5', home.frames.get('conv-5'));
    expect(bob.joined('conv-5')).toBe(true);
  });

  it('names the devices in the tree, not the ones on the member list', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-6', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-6', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-6', home.frames.get('conv-6'));

    const seen = alice.devicesIn('conv-6').map((d) => `${d.userId}|${d.deviceId}`).sort();
    expect(seen).toEqual(['@a:h|d-alice', '@b:h|d-bob']);
    expect(bob.devicesIn('conv-6')).toHaveLength(2);
  });

  it('starts a conversation once for a name it was handed twice', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-dup', ['@b:h', '@b:h', '@a:h']);
    expect(built.welcome).toBeTruthy();
    expect(alice.devicesIn('conv-dup')).toHaveLength(2);
  });

  it('gives an account one leaf however many times it has signed in', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice-1');
    await device(home, '@a:h', 'd-alice-2');
    await device(home, '@b:h', 'd-bob-1');
    await device(home, '@b:h', 'd-bob-2');
    await device(home, '@b:h', 'd-bob-3');

    const built = await alice.establish('conv-many', ['@b:h', '@a:h']);
    expect(built.welcome).toBeTruthy();
    const who = alice.devicesIn('conv-many').map((d) => d.userId).sort();
    expect(who).toEqual(['@a:h', '@b:h']);
  });

  it('leaves out a device whose account already holds a leaf', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    await device(home, '@b:h', 'd-bob-1');
    await alice.establish('conv-held', ['@b:h']);

    await device(home, '@b:h', 'd-bob-2');
    const again = await alice.addMembers('conv-held', ['@b:h']);
    expect(again.added).toBe(0);
    expect(again.rejected).toEqual([]);
    expect(alice.devicesIn('conv-held')).toHaveLength(2);
  });

  it('builds an add against the tree as it is, not as the caller last saw it', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    await device(home, '@d:h', 'd-dave');

    const built = await alice.establish('conv-moved', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-moved', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-moved', home.frames.get('conv-moved'));

    await bob.addMembers('conv-moved', ['@d:h']);
    await alice.sync('conv-moved', home.frames.get('conv-moved'));

    const again = await alice.addMembers('conv-moved', ['@d:h']);
    expect(again.added).toBe(0);
    const daves = alice.devicesIn('conv-moved').filter((d) => d.userId === '@d:h');
    expect(daves).toHaveLength(1);
  });

  it('lets a new sign-in keep talking with no other device online', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice-1', key);
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());

    const built = await alice.establish('conv-1', ['@b:h', '@a:h']);
    await home.for('@a:h', 'd-alice-1').sendFrame('conv-1', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-1', home.frames.get('conv-1'));
    await bob.send('conv-1', 'before the new laptop');

    const laptop = await device(home, '@a:h', 'd-alice-2', key);
    expect(await laptop.selfJoin('conv-1', home.frames.get('conv-1'))).toBe(false);
    expect(laptop.joined('conv-1')).toBe(true);

    const sent = await laptop.send('conv-1', 'sent from the new laptop');
    await bob.sync('conv-1', home.frames.get('conv-1'));
    expect(bob.textOf(sent.id)).toBe('sent from the new laptop');

    const back = await bob.send('conv-1', 'welcome back');
    await laptop.sync('conv-1', home.frames.get('conv-1'));
    expect(laptop.textOf(back.id)).toBe('welcome back');
  });

  it('goes back for a group that was built before the recovery key arrived', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice-1');
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());

    const built = await alice.establish('conv-late', ['@b:h', '@a:h']);
    await home.for('@a:h', 'd-alice-1').sendFrame('conv-late', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-late', home.frames.get('conv-late'));
    const mine = () => home.frames.get('conv-late')
      .filter((f) => f.kind === 'groupinfo' && f.sender === '@a:h');
    expect(mine().length).toBe(0);

    await alice.adoptRecoveryKey({ key, openers: [key] });
    const info = mine();
    expect(info.length).toBe(1);
    expect(info[0].sender).toBe('@a:h');

    const frames = [...home.frames.get('conv-late')];
    await freshDisk();
    const laptop = await device(home, '@a:h', 'd-alice-2', key);
    expect(await laptop.selfJoin('conv-late', frames)).toBe(true);
  });

  it('lets itself in from a GroupInfo above the window the view loaded', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice-1');
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());

    const built = await alice.establish('conv-deep', ['@b:h', '@a:h']);
    await home.for('@a:h', 'd-alice-1').sendFrame('conv-deep', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-deep', home.frames.get('conv-deep'));
    for (let i = 0; i < 6; i += 1) await bob.send('conv-deep', `line ${i}`);

    await alice.adoptRecoveryKey({ key, openers: [key] });
    const all = home.frames.get('conv-deep');
    const mine = all.filter((f) => f.kind === 'groupinfo' && f.sender === '@a:h');
    expect(mine).toHaveLength(1);

    const firstPage = all.slice(0, 3);
    expect(firstPage.some((f) => f.kind === 'groupinfo' && f.sender === '@a:h')).toBe(false);

    await freshDisk();
    const laptop = await device(home, '@a:h', 'd-alice-2', key);
    expect(await laptop.selfJoin('conv-deep', firstPage)).toBe(true);
    expect(laptop.joined('conv-deep')).toBe(true);

    await bob.sync('conv-deep', home.frames.get('conv-deep'));
    const after = await bob.send('conv-deep', 'after the new laptop');
    await laptop.sync('conv-deep', home.frames.get('conv-deep'));
    expect(laptop.textOf(after.id)).toBe('after the new laptop');
    expect(laptop.failed.has('conv-deep')).toBe(false);
  });

  it('advances the MLS epoch before publishing under a rotated recovery key', async () => {
    const home = new FakeHome();
    const oldKey = await recoveryKey();
    const nextKey = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice-1', oldKey);

    await alice.establish('conv-rotate', ['@a:h']);
    const infos = () => home.frames.get('conv-rotate')
      .filter((f) => f.kind === 'groupinfo' && f.sender === '@a:h');
    const commits = () => home.frames.get('conv-rotate')
      .filter((f) => f.kind === 'commit' && f.sender === '@a:h');
    expect(infos()).toHaveLength(1);
    const oldEpoch = infos()[0].epoch;

    const result = await alice.adoptRecoveryKey({
      key: nextKey,
      raw: nextKey,
      retired: [oldKey],
      openers: [nextKey, oldKey],
    });
    expect(result.failures).toEqual([]);
    expect(commits()).toHaveLength(1);
    expect(commits()[0].epoch).toBeGreaterThan(oldEpoch);
    expect(infos()).toHaveLength(2);
    const newest = infos().at(-1);
    expect(newest.epoch).toBe(commits()[0].epoch);
    await expect(openVault(oldKey, newest.ciphertext)).rejects.toThrow();
    expect((await openVault(nextKey, newest.ciphertext)).length).toBeGreaterThan(0);
  });

  it('hands a brand new machine the history MLS will not give it', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const { mls: alice, backup } = await mirrored(home, '@a:h', 'd-alice-1', key);
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());

    const built = await alice.establish('conv-mirror', ['@b:h', '@a:h']);
    await home.for('@a:h', 'd-alice-1').sendFrame('conv-mirror', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-mirror', home.frames.get('conv-mirror'));
    await bob.send('conv-mirror', 'said before the new machine existed');
    await alice.sync('conv-mirror', home.frames.get('conv-mirror'));

    const said = home.frames.get('conv-mirror').find((f) => f.kind === 'application');
    expect(alice.textOf(said.id)).toBe('said before the new machine existed');
    await backup.flush();

    const frames = [...home.frames.get('conv-mirror')];
    await freshDisk();
    const { mls: laptop } = await mirrored(home, '@a:h', 'd-alice-2', key);
    await laptop.sync('conv-mirror', frames);
    expect(laptop.textOf(said.id)).toBe('said before the new machine existed');
  });

  it('takes a deleted message out of the mirror rather than leaving it there', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const { mls: alice, backup } = await mirrored(home, '@a:h', 'd-alice-1', key);
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());

    const built = await alice.establish('conv-gone', ['@b:h', '@a:h']);
    await home.for('@a:h', 'd-alice-1').sendFrame('conv-gone', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-gone', home.frames.get('conv-gone'));
    await bob.send('conv-gone', 'regretted immediately');
    await alice.sync('conv-gone', home.frames.get('conv-gone'));

    const said = home.frames.get('conv-gone').find((f) => f.kind === 'application');
    await backup.flush();
    expect(decodeBody((await backup.restore('conv-gone')).get(said.id)).text)
      .toBe('regretted immediately');

    alice.applyDelete('conv-gone', '@b:h', { target: said.id });
    await backup.flush();
    expect((await backup.restore('conv-gone')).get(said.id)).toBe(null);
  });

  it('does not republish a way in that is already there', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice-1', key);
    await alice.establish('conv-quiet', ['@a:h']);
    const published = home.frames.get('conv-quiet').filter((f) => f.kind === 'groupinfo').length;
    expect(published).toBe(1);

    const again = await device(home, '@a:h', 'd-alice-2', key);
    await again.catchUpGroupInfo();
    expect(home.frames.get('conv-quiet').filter((f) => f.kind === 'groupinfo').length)
      .toBe(published);
  });

  it('starts a conversation over when the group is gone from every device', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice', await recoveryKey());
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    const built = await alice.establish('conv-over', ['@b:h', '@a:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-over', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-over', home.frames.get('conv-over'));
    const before = await bob.send('conv-over', 'from the group that was lost');
    await alice.sync('conv-over', home.frames.get('conv-over'));
    expect(alice.textOf(before.id)).toBe('from the group that was lost');

    const from = home.frames.get('conv-over').reduce((h, f) => Math.max(h, f.seq), 0);
    await alice.forget('conv-over');
    const rebuilt = await alice.establish('conv-over', ['@b:h', '@a:h'], { from });
    await home.for('@a:h', 'd-alice').sendFrame('conv-over', {
      kind: 'welcome', ciphertext: rebuilt.welcome, epoch: rebuilt.epoch,
    });

    await bob.sync('conv-over', home.frames.get('conv-over'));
    expect(bob.failed.get('conv-over')).toBeUndefined();
    const after = await bob.send('conv-over', 'and the conversation carries on');
    await alice.sync('conv-over', home.frames.get('conv-over'));
    expect(alice.failed.get('conv-over')).toBeUndefined();
    expect(alice.textOf(after.id)).toBe('and the conversation carries on');
  });

  it('hands a refreshed sign-in the whole conversation, not just its tail', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice-1', key);
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());

    const built = await alice.establish('conv-1', ['@b:h', '@a:h']);
    await home.for('@a:h', 'd-alice-1').sendFrame('conv-1', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-1', home.frames.get('conv-1'));
    const old = await bob.send('conv-1', 'said before the laptop existed');

    const laptop = await device(home, '@a:h', 'd-alice-2', key);
    await laptop.sync('conv-1', home.frames.get('conv-1'));
    expect(laptop.textOf(old.id)).toBe('said before the laptop existed');
  });

  it('restores reactions, edits and pins with the history on a new sign-in', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice', await recoveryKey());
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    const built = await alice.establish('conv-f', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-f', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    const said = await alice.send('conv-f', 'the original words');
    await bob.sync('conv-f', home.frames.get('conv-f'));

    await alice.react('conv-f', said.id, '\u{1F525}');
    await alice.editMessage('conv-f', said.id, 'the corrected words');
    await alice.setPin('conv-f', said.id, true);
    await bob.sync('conv-f', home.frames.get('conv-f'));

    const again = await device(home, '@b:h', 'd-bob-2');
    await again.sync('conv-f', home.frames.get('conv-f'));

    expect(again.textOf(said.id)).toBe('the original words');
    expect(again.currentText('conv-f', said.id)).toBe('the corrected words');
    expect(again.reactionsTo('conv-f', said.id))
      .toEqual([{ emoji: '\u{1F525}', count: 1, users: ['@a:h'] }]);
    expect(again.pinsIn('conv-f')).toEqual([{
      id: said.id, by: '@a:h', author: '@a:h', snippet: 'the original words',
    }]);
  });

  it('steps over its own last send from a session that died mid-flight', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice-1', null);
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    const built = await alice.establish('conv-d', ['@b:h']);
    await home.for('@a:h', 'd-alice-1').sendFrame('conv-d', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-d', home.frames.get('conv-d'));
    const lastWords = await alice.send('conv-d', 'sent just before the crash');

    await bob.send('conv-d', 'written after the crash');

    const next = await device(home, '@a:h', 'd-alice-2');
    await next.sync('conv-d', home.frames.get('conv-d'));
    expect(next.failed.get('conv-d')).toBeUndefined();
    expect(next.textOf(lastWords.id)).toBe('sent just before the crash');
    const after = home.frames.get('conv-d').filter((f) => f.kind === 'application').pop();
    expect(next.textOf(after.id)).toBe('written after the crash');
  });

  it('survives a message that sequenced after its join but predates it', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice-1', key);
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    const built = await alice.establish('conv-r', ['@b:h', '@a:h']);
    await home.for('@a:h', 'd-alice-1').sendFrame('conv-r', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-r', home.frames.get('conv-r'));
    await alice.send('conv-r', 'before any of this');

    const frozen = [...home.frames.get('conv-r')];
    await freshDisk();
    const laptop = await device(home, '@a:h', 'd-alice-2', key);
    expect(await laptop.selfJoin('conv-r', frozen)).toBe(true);

    await bob.send('conv-r', 'written against the old epoch');
    await bob.sync('conv-r', home.frames.get('conv-r'));
    const after = await bob.send('conv-r', 'and one after');

    await laptop.sync('conv-r', home.frames.get('conv-r'));
    expect(laptop.failed.get('conv-r')).toBeUndefined();
    expect(laptop.textOf(after.id)).toBe('and one after');

    await alice.sync('conv-r', home.frames.get('conv-r'));
    expect(alice.textOf(after.id)).toBe('and one after');
  });

  it('shares nothing with another account on the same machine', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice', await recoveryKey());
    const built = await alice.establish('conv-p', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-p', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await alice.send('conv-p', 'alice only');

    const carol = await device(home, '@c:h', 'd-carol', await recoveryKey());
    await carol.sync('conv-p', home.frames.get('conv-p'));
    const said = home.frames.get('conv-p').find((f) => f.kind === 'application');
    expect(carol.textOf(said.id)).toBeUndefined();
    expect(carol.joined('conv-p')).toBe(false);
  });

  it('cannot let itself in without the account recovery key', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice-1', await recoveryKey());
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    const built = await alice.establish('conv-1', ['@b:h', '@a:h']);
    await home.for('@a:h', 'd-alice-1').sendFrame('conv-1', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-1', home.frames.get('conv-1'));

    await freshDisk();
    const impostor = await device(home, '@a:h', 'd-impostor', await recoveryKey());
    expect(await impostor.selfJoin('conv-1', home.frames.get('conv-1'))).toBe(false);
    expect(impostor.joined('conv-1')).toBe(false);
  });

  it('pairs every application frame with the same-shape opaque notification request', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const built = await alice.establish('conv-hints', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-hints', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });

    const message = await alice.send('conv-hints', 'visible message');
    const reaction = await alice.react('conv-hints', message.id, '👍');

    const application = home.frames.get('conv-hints')
      .filter((frame) => frame.kind === 'application');
    const hints = home.notificationHints
      .filter((hint) => hint.conversation_id === 'conv-hints');

    expect(application).toHaveLength(2);
    expect(hints).toHaveLength(2);
    expect(hints.map((hint) => hint.notification_id))
      .toEqual(application.map((frame) => frame.notification_id));
    expect(hints.every((hint) => Array.isArray(hint.envelopes))).toBe(true);
    expect(JSON.stringify(hints)).not.toContain('"notify"');
    expect(Object.keys(hints[0]).sort()).toEqual(Object.keys(hints[1]).sort());
  });

  it('retries incomplete notification-key discovery after the MLS frame is accepted', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const built = await alice.establish('conv-hint-race', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-hint-race', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });

    let discoveries = 0;
    alice.home.dmNotificationKeys = async (conversationId) => {
      discoveries += 1;
      return {
        hint_origin: `dm:${conversationId}`,
        targets: [],
        complete: discoveries > 1,
      };
    };

    const sent = await alice.send('conv-hint-race', 'first cross-server message');

    expect(sent.kind).toBe('application');
    expect(sent.notification_id).toBeTruthy();
    expect(discoveries).toBe(2);
  });

  it('carries a read receipt as an application frame the server cannot tell apart', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    alice.sendsRead = () => true;
    bob.sendsRead = () => true;

    const built = await alice.establish('conv-s', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-s', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    const said = await alice.send('conv-s', 'did you see this');

    await bob.sync('conv-s', home.frames.get('conv-s'));
    bob.noteRead('conv-s', said.id);
    const receipt = await bob.flushSignals('conv-s');

    expect(receipt.kind).toBe('application');
    expect(atob(receipt.ciphertext)).not.toContain('read');
    expect(atob(receipt.ciphertext)).not.toContain(`{\"read\":\"${said.id}\",\"delivered\":`);

    await alice.sync('conv-s', home.frames.get('conv-s'));
    expect(alice.isSignal(receipt.id)).toBe(true);
    expect(alice.textOf(receipt.id)).toBeUndefined();
    expect(alice.deliveredTo('conv-s', said.id)).toEqual(['@b:h']);
    expect(alice.readersOf('conv-s', said.id)).toEqual(['@b:h']);
  });

  it('marks a message as worth waking a phone for, and marks nothing else', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    alice.sendsRead = () => true;
    bob.sendsRead = () => true;

    const built = await alice.establish('conv-n', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-n', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });

    const said = await alice.send('conv-n', 'wake the phone');
    await bob.sync('conv-n', home.frames.get('conv-n'));
    bob.noteRead('conv-n', said.id);
    const receipt = await bob.flushSignals('conv-n');
    const typing = await bob.typing('conv-n');
    const reaction = await bob.react('conv-n', said.id, 'ok');

    const frames = home.frames.get('conv-n');
    const frameOf = (id) => frames.find((f) => f.id === id);

    expect(frameOf(said.id).notify).toBe(true);
    expect(frameOf(receipt.id).notify).toBe(false);
    expect(frameOf(typing.id).notify).toBe(false);
    expect(frameOf(reaction.id).notify).toBe(false);

    for (const id of [said.id, receipt.id, typing.id, reaction.id]) {
      expect(frameOf(id).kind).toBe('application');
    }
    expect(atob(frameOf(said.id).ciphertext)).not.toContain('wake the phone');
  });

  it('coalesces a backlog into one watermark and sends nothing when nothing moved', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    alice.sendsRead = () => true;
    bob.sendsRead = () => true;

    const built = await alice.establish('conv-w', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-w', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    const first = await alice.send('conv-w', 'one');
    await alice.send('conv-w', 'two');
    const last = await alice.send('conv-w', 'three');

    await bob.sync('conv-w', home.frames.get('conv-w'));
    bob.noteRead('conv-w', first.id);
    bob.noteRead('conv-w', last.id);
    bob.noteRead('conv-w', first.id);

    const before = home.frames.get('conv-w').length;
    const receipt = await bob.flushSignals('conv-w');
    expect(receipt).toBeTruthy();
    expect(home.frames.get('conv-w').length).toBe(before + 1);

    expect(await bob.flushSignals('conv-w')).toBeNull();
    expect(home.frames.get('conv-w').length).toBe(before + 1);

    await alice.sync('conv-w', home.frames.get('conv-w'));
    expect(alice.readersOf('conv-w', first.id)).toEqual(['@b:h']);
    expect(alice.readersOf('conv-w', last.id)).toEqual(['@b:h']);
  });

  it('keeps no read state for an account that does not send its own', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    alice.sendsRead = () => false;
    bob.sendsRead = () => true;

    const built = await alice.establish('conv-o', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-o', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    const said = await alice.send('conv-o', 'read this if you like');
    await bob.sync('conv-o', home.frames.get('conv-o'));
    bob.noteRead('conv-o', said.id);
    await bob.flushSignals('conv-o');
    await alice.sync('conv-o', home.frames.get('conv-o'));

    expect(alice.readersOf('conv-o', said.id)).toEqual([]);
    expect(alice.deliveredTo('conv-o', said.id)).toEqual(['@b:h']);

    const asked = await bob.send('conv-o', 'well?');
    await alice.sync('conv-o', home.frames.get('conv-o'));
    alice.noteRead('conv-o', asked.id);
    expect(await alice.flushSignals('conv-o')).toBeTruthy();
    await bob.sync('conv-o', home.frames.get('conv-o'));
    expect(bob.deliveredTo('conv-o', asked.id)).toEqual(['@a:h']);
    expect(bob.readersOf('conv-o', asked.id)).toEqual([]);
  });

  it('refuses a second join built on an epoch that has already moved', async () => {
    const home = new FakeHome();
    const key = await recoveryKey();
    const alice = await device(home, '@a:h', 'd-alice-1', key);
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    const built = await alice.establish('conv-1', ['@b:h', '@a:h']);
    await home.for('@a:h', 'd-alice-1').sendFrame('conv-1', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-1', home.frames.get('conv-1'));

    const frozen = [...home.frames.get('conv-1')];
    await freshDisk();
    const first = await device(home, '@a:h', 'd-alice-2', key);
    expect(await first.selfJoin('conv-1', frozen)).toBe(true);

    await freshDisk();
    const second = await device(home, '@a:h', 'd-alice-3', key);
    await expect(second.selfJoin('conv-1', frozen)).rejects.toMatchObject({ status: 409 });

    expect(await second.selfJoin('conv-1', home.frames.get('conv-1'))).toBe(true);
    const sent = await second.send('conv-1', 'third device, still fine');
    await bob.sync('conv-1', home.frames.get('conv-1'));
    expect(bob.textOf(sent.id)).toBe('third device, still fine');
  });

  it('carries an attachment key inside the message rather than beside it', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-att', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-att', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    const attachment = {
      ref: 'sha-1', url: 'https://h/_telium/v1/media/sha-1?cap=c1', capability: 'c1',
      name: 'severance-agreement.pdf', mime: 'application/pdf', size: 4096,
      key: 'RGVjbGFzc2lmaWVkS2V5TWF0ZXJpYWxGb3JUaGlzT25lRmlsZQ',
      iv: 'SW5pdGlhbGlzYXRpb24',
    };
    await alice.send('conv-att', 'signed, as promised', [attachment]);
    await bob.sync('conv-att', home.frames.get('conv-att'));

    const frame = home.frames.get('conv-att').filter((f) => f.kind === 'application').pop();
    expect(bob.textOf(frame.id)).toBe('signed, as promised');
    expect(bob.attachmentsOf(frame.id)).toEqual([attachment]);
    expect(atob(frame.ciphertext)).not.toContain('severance-agreement.pdf');
    expect(atob(frame.ciphertext)).not.toContain(attachment.key);
  });
});

describe('message bodies', () => {
  it('leaves a message with no attachments exactly as it was typed', () => {
    expect(encodeBody('just words', [])).toBe('just words');
    expect(encodeBody('just words', undefined)).toBe('just words');
    expect(encodeBody('just words', undefined, null)).toBe('just words');
    expect(decodeBody('just words'))
      .toEqual({ text: 'just words', attachments: [], reply: null });
  });

  it('round-trips text and attachments together', () => {
    const attachments = [{ name: 'notes.txt', key: 'k', iv: 'i' }];
    expect(decodeBody(encodeBody('see attached', attachments)))
      .toEqual({ text: 'see attached', attachments, reply: null });
  });

  it('carries a reply as a snapshot inside the envelope, and reads it back', () => {
    const quote = { id: 'f9', author: '@b:h', text: 'the thing being answered' };
    const raw = encodeBody('and my answer', [], quote);
    expect(raw.startsWith('\u0000telium/dm-body/1\n')).toBe(true);
    expect(decodeBody(raw)).toEqual({ text: 'and my answer', attachments: [], reply: quote });
  });

  it('shows a body it decrypted even when the envelope is nonsense', () => {
    expect(decodeBody('\u0000telium/dm-body/1\nnot json').attachments).toEqual([]);
  });
});

describe('reactions', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await wipe();
  });

  it('carries a reaction as a signal frame and folds it in on both ends', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-r', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-r', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    const said = await alice.send('conv-r', 'look at this');
    await bob.sync('conv-r', home.frames.get('conv-r'));

    const gesture = await alice.react('conv-r', said.id, '\u{1F525}');
    expect(gesture.kind).toBe('application');
    expect(atob(gesture.ciphertext)).not.toContain('\u{1F525}');
    expect(atob(gesture.ciphertext)).not.toContain(`{\"target\":\"${said.id}\",\"emoji\":`);

    expect(alice.reactionsTo('conv-r', said.id))
      .toEqual([{ emoji: '\u{1F525}', count: 1, users: ['@a:h'] }]);

    await bob.sync('conv-r', home.frames.get('conv-r'));
    expect(bob.reactionsTo('conv-r', said.id))
      .toEqual([{ emoji: '\u{1F525}', count: 1, users: ['@a:h'] }]);

    await alice.unreact('conv-r', said.id, '\u{1F525}');
    await bob.sync('conv-r', home.frames.get('conv-r'));
    expect(bob.reactionsTo('conv-r', said.id)).toEqual([]);
  });

  it('ignores a malformed reaction instead of throwing out of the sync walk', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    const built = await alice.establish('conv-bad', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-bad', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    const said = await alice.send('conv-bad', 'still readable after this');

    await alice.post('conv-bad', new Uint8Array([
      0x03, ...new TextEncoder().encode(JSON.stringify({ nonsense: true })),
    ]));

    await bob.sync('conv-bad', home.frames.get('conv-bad'));
    expect(bob.textOf(said.id)).toBe('still readable after this');
    expect(bob.reactionsTo('conv-bad', said.id)).toEqual([]);
  });
});

describe('editing, deleting, and pinning', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await wipe();
  });

  async function pairWith(home, conversationId) {
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    const built = await alice.establish(conversationId, ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame(conversationId, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    return { alice, bob };
  }

  it('lets the author supersede their words, on every device reading them', async () => {
    const home = new FakeHome();
    const { alice, bob } = await pairWith(home, 'conv-e');
    const said = await alice.send('conv-e', 'the launch is at noon');
    await bob.sync('conv-e', home.frames.get('conv-e'));

    await alice.editMessage('conv-e', said.id, 'the launch is at dusk');

    expect(alice.isEdited('conv-e', said.id)).toBe(true);
    expect(alice.currentText('conv-e', said.id)).toBe('the launch is at dusk');
    await bob.sync('conv-e', home.frames.get('conv-e'));
    expect(bob.isEdited('conv-e', said.id)).toBe(true);
    expect(bob.currentText('conv-e', said.id)).toBe('the launch is at dusk');
    expect(atob(home.frames.get('conv-e').find((f) => f.id === said.id).ciphertext))
      .not.toContain('dusk');
  });

  it("refuses a superseding gesture from anyone who didn't write it", async () => {
    const home = new FakeHome();
    const { alice, bob } = await pairWith(home, 'conv-x');
    const said = await alice.send('conv-x', 'hers');
    await bob.sync('conv-x', home.frames.get('conv-x'));

    await bob.editMessage('conv-x', said.id, 'now his');
    await bob.deleteMessage('conv-x', said.id);

    expect(bob.currentText('conv-x', said.id)).toBe('hers');
    expect(bob.isDeleted('conv-x', said.id)).toBe(false);
    await alice.sync('conv-x', home.frames.get('conv-x'));
    expect(alice.currentText('conv-x', said.id)).toBe('hers');
    expect(alice.isDeleted('conv-x', said.id)).toBe(false);
  });

  it('deletes for everyone holding it, and stays deleted across a reload', async () => {
    const home = new FakeHome();
    const { alice, bob } = await pairWith(home, 'conv-del');
    const said = await alice.send('conv-del', 'call that back');
    await bob.sync('conv-del', home.frames.get('conv-del'));

    await alice.deleteMessage('conv-del', said.id);
    expect(alice.isDeleted('conv-del', said.id)).toBe(true);
    expect(alice.textOf(said.id)).toBeUndefined();

    await bob.sync('conv-del', home.frames.get('conv-del'));
    expect(bob.isDeleted('conv-del', said.id)).toBe(true);
    expect(bob.textOf(said.id)).toBeUndefined();

    const again = await device(home, '@a:h', 'd-alice');
    await again.sync('conv-del', home.frames.get('conv-del'));
    expect(again.isDeleted('conv-del', said.id)).toBe(true);
    expect(again.textOf(said.id)).toBeUndefined();
  });

  it('pins with a snapshot any device can render, including ones admitted late', async () => {
    const home = new FakeHome();
    const { alice, bob } = await pairWith(home, 'conv-pin');
    const said = await alice.send('conv-pin', 'the address for saturday');
    await bob.sync('conv-pin', home.frames.get('conv-pin'));

    await alice.setPin('conv-pin', said.id, true);

    expect(alice.pinsIn('conv-pin')).toEqual([{
      id: said.id, by: '@a:h', author: '@a:h', snippet: 'the address for saturday',
    }]);
    await bob.sync('conv-pin', home.frames.get('conv-pin'));
    expect(bob.pinsIn('conv-pin')).toEqual([{
      id: said.id, by: '@a:h', author: '@a:h', snippet: 'the address for saturday',
    }]);

    await bob.setPin('conv-pin', said.id, false);
    await alice.sync('conv-pin', home.frames.get('conv-pin'));
    expect(alice.pinsIn('conv-pin')).toEqual([]);
  });

  it('ignores a malformed superseding gesture instead of stopping the walk', async () => {
    const home = new FakeHome();
    const { alice, bob } = await pairWith(home, 'conv-mal');
    const said = await alice.send('conv-mal', 'still here');

    await alice.post('conv-mal', new Uint8Array([
      0x04, ...new TextEncoder().encode(JSON.stringify({ nonsense: true })),
    ]));

    await bob.sync('conv-mal', home.frames.get('conv-mal'));
    expect(bob.currentText('conv-mal', said.id)).toBe('still here');
    expect(bob.isEdited('conv-mal', said.id)).toBe(false);
  });
});
