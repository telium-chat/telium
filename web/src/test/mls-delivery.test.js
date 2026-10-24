import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { wipe } from '../lib/mls.js';
import { FakeHome, device } from './mls-home.js';
import { recoveryKey, legacyPut } from './mls-helpers.js';

describe('a device that was never let in', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await wipe();
  });

  it('is committed in when it asks, and reads what is said afterwards', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice', await recoveryKey());

    const built = await alice.establish('conv-late', ['@b:h', '@a:h']);
    expect(built.welcome).toBeNull();
    await alice.send('conv-late', 'said before bob had a device');

    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    await bob.sync('conv-late', home.frames.get('conv-late'));
    expect(bob.joined('conv-late')).toBe(false);

    expect(await bob.selfJoin('conv-late', home.frames.get('conv-late'))).toBe(false);

    await bob.requestRejoin('conv-late');
    await alice.sync('conv-late', home.frames.get('conv-late'));
    const asking = alice.takeRejoins('conv-late');
    expect(asking).toEqual([{ userId: '@b:h', deviceId: 'd-bob', signatureKey: await bob.leafKey() }]);

    const { added } = await alice.catchUp('conv-late', asking);
    expect(added).toBe(1);

    await bob.sync('conv-late', home.frames.get('conv-late'));
    expect(bob.joined('conv-late')).toBe(true);

    await alice.send('conv-late', 'said after bob was let in');
    await bob.sync('conv-late', home.frames.get('conv-late'));

    const said = home.frames.get('conv-late').filter((f) => f.kind === 'application');
    expect(bob.textOf(said[0].id)).toBeUndefined();
    expect(bob.textOf(said[1].id)).toBe('said after bob was let in');
  });

  it('is not added twice when two people answer the same request', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice', await recoveryKey());
    await alice.establish('conv-twice', ['@b:h']);

    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    await bob.requestRejoin('conv-twice');
    await alice.sync('conv-twice', home.frames.get('conv-twice'));
    await alice.catchUp('conv-twice', alice.takeRejoins('conv-twice'));
    await bob.sync('conv-twice', home.frames.get('conv-twice'));
    expect(bob.joined('conv-twice')).toBe(true);

    const before = home.device('@b:h', 'd-bob').length;
    const second = await alice.catchUp('conv-twice', [{ userId: '@b:h', deviceId: 'd-bob' }]);
    expect(second.added).toBe(0);
    expect(home.device('@b:h', 'd-bob').length).toBe(before);
  });

  it('does not stop the conversation for the people already in it', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice', await recoveryKey());
    const carol = await device(home, '@c:h', 'd-carol', await recoveryKey());

    const built = await alice.establish('conv-walk', ['@c:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-walk', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });

    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    await bob.requestRejoin('conv-walk');
    await alice.send('conv-walk', 'still talking');

    await carol.sync('conv-walk', home.frames.get('conv-walk'));
    const said = home.frames.get('conv-walk').filter((f) => f.kind === 'application');
    expect(carol.textOf(said[0].id)).toBe('still talking');
    expect(carol.failed.get('conv-walk')).toBeUndefined();
  });
});

describe('migration from device-keyed rows', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await wipe();
  });

  it('picks up bodies and folds filed under an older device identity', async () => {
    await legacyPut('opened', '@b:h|d-old:f1', 'written by the previous session');
    await legacyPut('opened', '@b:h|d-old:rx:conv-m', [
      { t: 'f1', u: '@a:h', e: ['\u{1F525}'] },
    ]);
    await legacyPut('opened', '@b:h|d-old:cx:conv-m', {
      edits: [{ t: 'f1', x: 'the edit from then', by: '@a:h' }],
      dead: [],
      pins: [{ t: 'f1', by: '@a:h', author: '@a:h', snippet: 'the original words' }],
    });

    const home = new FakeHome();
    const mls = await device(home, '@b:h', 'd-new');

    await mls.sync('conv-m', [{
      id: 'f1', kind: 'application', sender: '@a:h', sender_device: 'd-a', seq: 1,
    }]);

    expect(mls.textOf('f1')).toBe('written by the previous session');
    expect(mls.reactionsTo('conv-m', 'f1'))
      .toEqual([{ emoji: '\u{1F525}', count: 1, users: ['@a:h'] }]);
    expect(mls.isEdited('conv-m', 'f1')).toBe(true);
    expect(mls.currentText('conv-m', 'f1')).toBe('the edit from then');
    expect(mls.pinsIn('conv-m'))
      .toEqual([{ id: 'f1', by: '@a:h', author: '@a:h', snippet: 'the original words' }]);
  });

  it('leaves another account\u2019s rows and its own new layout alone', async () => {
    await legacyPut('opened', '@c:h|d-c:f2', 'carol\u2019s business');
    await legacyPut('opened', '@b:h|d-old:f1', 'the stale copy');
    await legacyPut('opened', '@b:h:f1', 'the fresh copy');

    const home = new FakeHome();
    const mls = await device(home, '@b:h', 'd-new');
    await mls.sync('conv-x', [{
      id: 'f1', kind: 'application', sender: '@a:h', sender_device: 'd-a', seq: 1,
    }]);
    expect(mls.textOf('f1')).toBe('the fresh copy');
  });
});

describe('mls call state', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  it('agrees one call secret per label across the group, and none outside it', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice', await recoveryKey());
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    const built = await alice.establish('conv-call', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-call', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-call', home.frames.get('conv-call'));

    const mine = await alice.callSecret('conv-call', 'telium call signal v1');
    const theirs = await bob.callSecret('conv-call', 'telium call signal v1');
    expect(mine.key).toHaveLength(32);
    expect([...theirs.key]).toEqual([...mine.key]);
    expect(theirs.epoch).toBe(mine.epoch);
    const media = await alice.callSecret('conv-call', 'telium call media v1');
    expect([...media.key]).not.toEqual([...mine.key]);
    expect(await alice.callSecret('conv-elsewhere', 'telium call signal v1')).toBeNull();
  });

  it('labels a call secret with the epoch it was exported from', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice', await recoveryKey());
    await alice.establish('conv-walk', ['@b:h']);
    const before = await alice.callSecret('conv-walk', 'telium call media v1');
    const entry = alice.groups.get('conv-walk');
    const pending = alice.callSecret('conv-walk', 'telium call media v1');
    entry.state = {
      ...entry.state,
      keySchedule: { ...entry.state.keySchedule, exporterSecret: new Uint8Array(32).fill(7) },
      groupContext: { ...entry.state.groupContext, epoch: entry.state.groupContext.epoch + 1n },
    };
    const got = await pending;
    expect(got.epoch).toBe(before.epoch);
    expect([...got.key]).toEqual([...before.key]);
  });

  it('carries the conversation’s own SFU inside the encryption', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice', await recoveryKey());
    const bob = await device(home, '@b:h', 'd-bob', await recoveryKey());
    const built = await alice.establish('conv-sfu', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-sfu', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-sfu', home.frames.get('conv-sfu'));

    await alice.setCallSfu('conv-sfu', 'https://sfu.friends.example');
    await bob.sync('conv-sfu', home.frames.get('conv-sfu'));
    expect(bob.callSfuIn('conv-sfu')).toBe('https://sfu.friends.example');
    expect(JSON.stringify(home.frames.get('conv-sfu'))).not.toContain('friends.example');

    await expect(alice.setCallSfu('conv-sfu', 'javascript:alert(1)')).rejects.toThrow(/http/);

    const again = await device(home, '@b:h', 'd-bob-2');
    await again.sync('conv-sfu', home.frames.get('conv-sfu'));
    expect(again.callSfuIn('conv-sfu')).toBe('https://sfu.friends.example');

    await alice.setCallSfu('conv-sfu', null);
    await bob.sync('conv-sfu', home.frames.get('conv-sfu'));
    expect(bob.callSfuIn('conv-sfu')).toBeNull();
  });
});

describe('delivery acknowledgements', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  async function pairUp(conv) {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    alice.sendsRead = () => true;
    bob.sendsRead = () => false;
    const built = await alice.establish(conv, ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame(conv, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    return { home, alice, bob };
  }

  it('goes from sent to delivered to read, and only on what the leaf itself said', async () => {
    const { home, alice, bob } = await pairUp('conv-ack');
    const said = await alice.send('conv-ack', 'are you there');
    expect(alice.deliveryState('conv-ack', said)).toBe('sent');

    await bob.sync('conv-ack', home.frames.get('conv-ack'));
    const ack = await bob.flushSignals('conv-ack');
    expect(ack.kind).toBe('application');
    expect(atob(ack.ciphertext)).not.toContain('d-bob');
    await alice.sync('conv-ack', home.frames.get('conv-ack'));
    expect(alice.deliveryState('conv-ack', said)).toBe('delivered');
    expect(alice.deliveredDevices('conv-ack', said.id).map((d) => d.deviceId)).toEqual(['d-bob']);

    bob.sendsRead = () => true;
    bob.noteRead('conv-ack', said.id);
    await bob.flushSignals('conv-ack');
    await alice.sync('conv-ack', home.frames.get('conv-ack'));
    expect(alice.deliveryState('conv-ack', said)).toBe('read');
  });

  it('ignores an ack that names a device other than the leaf it came from', async () => {
    const { home, alice, bob } = await pairUp('conv-forge');
    const said = await alice.send('conv-forge', 'hello');
    await bob.sync('conv-forge', home.frames.get('conv-forge'));

    const realKey = bob.leafKey.bind(bob);
    bob.leafKey = async () => btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    try { await bob.flushSignals('conv-forge'); } finally { bob.leafKey = realKey; }

    await alice.sync('conv-forge', home.frames.get('conv-forge'));
    expect(alice.errorFor('conv-forge')).toBeUndefined();
    expect(alice.deliveredTo('conv-forge', said.id)).toEqual([]);
    expect(alice.deliveryState('conv-forge', said)).toBe('sent');
  });

  it('counts one device per leaf key, whatever session id the ack names', async () => {
    const { home, alice, bob } = await pairUp('conv-relabel');
    const said = await alice.send('conv-relabel', 'hello');
    await bob.sync('conv-relabel', home.frames.get('conv-relabel'));

    const real = bob.deviceId;
    bob.deviceId = 'd-bob-reloaded';
    try { await bob.flushSignals('conv-relabel'); } finally { bob.deviceId = real; }
    const frames = home.frames.get('conv-relabel');
    frames[frames.length - 1].sender_device = 'd-bob-reloaded';

    await alice.sync('conv-relabel', frames);
    expect(alice.errorFor('conv-relabel')).toBeUndefined();
    expect(alice.deliveredTo('conv-relabel', said.id)).toEqual(['@b:h']);
    const [row] = alice.deliveryBreakdown('conv-relabel', said.id);
    expect(row.devices).toBe(1);
  });

  it('ignores an honest ack a server has relabelled as another device', async () => {
    const { home, alice, bob } = await pairUp('conv-relabel');
    const said = await alice.send('conv-relabel', 'hello');
    await bob.sync('conv-relabel', home.frames.get('conv-relabel'));
    await bob.flushSignals('conv-relabel');
    const frames = home.frames.get('conv-relabel');
    frames[frames.length - 1].sender_device = 'd-bob-laptop';

    await alice.sync('conv-relabel', frames);
    expect(alice.deliveredTo('conv-relabel', said.id)).toEqual([]);
  });

  it('refuses a forward-dated ack and an ack of the acker’s own words', async () => {
    const { home, alice, bob } = await pairUp('conv-future');
    await alice.send('conv-future', 'first');
    await bob.sync('conv-future', home.frames.get('conv-future'));

    const local = bob.watermarkOf('conv-future');
    local.delivered = 'f999';
    local.deliveredSeq = 999;
    await bob.flushSignals('conv-future');
    await alice.sync('conv-future', home.frames.get('conv-future'));
    const later = await alice.send('conv-future', 'second');
    expect(alice.deliveredTo('conv-future', later.id)).toEqual([]);

    const his = await bob.send('conv-future', 'mine');
    local.delivered = his.id;
    local.deliveredSeq = his.seq;
    local.sentDelivered = null;
    await bob.flushSignals('conv-future');
    await alice.sync('conv-future', home.frames.get('conv-future'));
    expect(alice.deliveredDevices('conv-future', his.id)).toEqual([]);
  });

  it('ignores a replayed or rewound ack', async () => {
    const { home, alice, bob } = await pairUp('conv-replay');
    const first = await alice.send('conv-replay', 'one');
    await bob.sync('conv-replay', home.frames.get('conv-replay'));
    await bob.flushSignals('conv-replay');
    const second = await alice.send('conv-replay', 'two');
    await bob.sync('conv-replay', home.frames.get('conv-replay'));
    await bob.flushSignals('conv-replay');
    await alice.sync('conv-replay', home.frames.get('conv-replay'));
    expect(alice.deliveredTo('conv-replay', second.id)).toEqual(['@b:h']);

    const local = bob.watermarkOf('conv-replay');
    local.delivered = first.id;
    local.deliveredSeq = first.seq;
    local.sentDelivered = null;
    await bob.flushSignals('conv-replay');
    await alice.sync('conv-replay', home.frames.get('conv-replay'));
    expect(alice.deliveredTo('conv-replay', second.id)).toEqual(['@b:h']);
    expect(alice.deliveryState('conv-replay', second)).toBe('delivered');
  });

  it('says nothing at all when this account has turned acknowledgements off', async () => {
    const { home, alice, bob } = await pairUp('conv-quiet');
    bob.sendsDelivered = () => false;
    const said = await alice.send('conv-quiet', 'still there?');
    await bob.sync('conv-quiet', home.frames.get('conv-quiet'));

    expect(await bob.flushSignals('conv-quiet')).toBeNull();
    await alice.sync('conv-quiet', home.frames.get('conv-quiet'));
    expect(alice.deliveryState('conv-quiet', said)).toBe('sent');
    expect(alice.deliveryBreakdown('conv-quiet', said.id)).toEqual([]);

    bob.sendsDelivered = () => true;
    expect(await bob.flushSignals('conv-quiet')).toBeTruthy();
    await alice.sync('conv-quiet', home.frames.get('conv-quiet'));
    expect(alice.deliveryState('conv-quiet', said)).toBe('delivered');
  });

  it('names no device when only delivery is off and read receipts are on', async () => {
    const { home, alice, bob } = await pairUp('conv-readonly');
    bob.sendsDelivered = () => false;
    bob.sendsRead = () => true;
    const said = await alice.send('conv-readonly', 'have a look');
    await bob.sync('conv-readonly', home.frames.get('conv-readonly'));
    bob.noteRead('conv-readonly', said.id);
    expect(await bob.flushSignals('conv-readonly')).toBeTruthy();
    await alice.sync('conv-readonly', home.frames.get('conv-readonly'));

    expect(alice.deliveryState('conv-readonly', said)).toBe('read');
    expect(alice.deliveredDevices('conv-readonly', said.id)).toEqual([]);
    expect(alice.deliveryBreakdown('conv-readonly', said.id))
      .toEqual([{ userId: '@b:h', devices: 0, read: true }]);
  });

  it('keeps nobody else’s acknowledgement while sending none of its own', async () => {
    const { home, alice, bob } = await pairUp('conv-mutual');
    alice.sendsDelivered = () => false;
    const said = await alice.send('conv-mutual', 'one way?');
    await bob.sync('conv-mutual', home.frames.get('conv-mutual'));
    expect(await bob.flushSignals('conv-mutual')).toBeTruthy();
    await alice.sync('conv-mutual', home.frames.get('conv-mutual'));

    expect(alice.deliveryState('conv-mutual', said)).toBe('sent');
    expect(alice.deliveryBreakdown('conv-mutual', said.id)).toEqual([]);
  });

  it('counts each person’s devices, and leaves out whoever said nothing', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    const carol = await device(home, '@c:h', 'd-carol');
    alice.sendsRead = () => true;
    carol.sendsDelivered = () => false;

    const built = await alice.establish('conv-count', ['@b:h', '@c:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-count', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    const said = await alice.send('conv-count', 'roll call');
    for (const member of [bob, carol]) {
      await member.sync('conv-count', home.frames.get('conv-count'));
      await member.flushSignals('conv-count');
    }
    await alice.sync('conv-count', home.frames.get('conv-count'));

    expect(alice.applyAck(
      'conv-count',
      { sender: '@b:h', seq: said.seq + 1 },
      { device: 'd-bob-phone', seq: said.seq, id: said.id },
      { userId: '@b:h', deviceId: 'd-bob-phone' },
    )).toBe(true);

    expect(alice.deliveryBreakdown('conv-count', said.id))
      .toEqual([{ userId: '@b:h', devices: 2, read: false }]);
    expect(alice.deliveryState('conv-count', said)).toBe('sent');
  });
});

describe('group membership policy', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  const MANAGED = { add: 'admins', remove: 'admins', policy: 'creator', admins: [] };

  async function group(conv, policy) {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    const carol = await device(home, '@c:h', 'd-carol');
    const dave = await device(home, '@d:h', 'd-dave');
    const built = await alice.establish(conv, ['@b:h', '@c:h'], { policy });
    await home.for('@a:h', 'd-alice').sendFrame(conv, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync(conv, home.frames.get(conv));
    await carol.sync(conv, home.frames.get(conv));
    const users = (mls) => new Set(mls.devicesIn(conv).map((d) => d.userId));
    return { home, alice, bob, carol, dave, built, users };
  }

  it('puts the creator’s policy into the group every member reads', async () => {
    const { alice, bob, built } = await group('conv-p1', MANAGED);
    expect(built.policy).toBe(true);
    expect(bob.policyOf('conv-p1')).toMatchObject({
      creator: '@a:h', add: 'admins', remove: 'admins', policy: 'creator',
    });
    expect(bob.permits('conv-p1', 'add')).toBe(false);
    expect(alice.permits('conv-p1', 'add')).toBe(true);
    await expect(bob.addMembers('conv-p1', ['@d:h'])).rejects.toThrow(/policy/);
    await expect(bob.removeMembers('conv-p1', ['@c:h'])).rejects.toThrow(/policy/);
  });

  it('has every honest member refuse an add the policy does not allow', async () => {
    const { home, alice, bob, carol, users } = await group('conv-p2', MANAGED);
    bob.permits = () => true;
    await bob.addMembers('conv-p2', ['@d:h']);

    await alice.sync('conv-p2', home.frames.get('conv-p2'));
    await carol.sync('conv-p2', home.frames.get('conv-p2'));
    expect(alice.errorFor('conv-p2')?.message).toMatch(/refused/);
    expect(carol.errorFor('conv-p2')?.message).toMatch(/refused/);
    expect(users(alice).has('@d:h')).toBe(false);
    expect(users(carol).has('@d:h')).toBe(false);
  });

  it('has every honest member refuse a policy change from someone without the right', async () => {
    const { home, alice, bob, carol } = await group('conv-p3', MANAGED);
    bob.permits = () => true;
    await bob.setPolicy('conv-p3', { ...bob.policyOf('conv-p3'), add: 'anyone', admins: ['@b:h'] });

    await alice.sync('conv-p3', home.frames.get('conv-p3'));
    await carol.sync('conv-p3', home.frames.get('conv-p3'));
    expect(alice.errorFor('conv-p3')?.message).toMatch(/refused/);
    expect(carol.errorFor('conv-p3')?.message).toMatch(/refused/);
    expect(alice.policyOf('conv-p3').add).toBe('admins');
    expect(carol.policyOf('conv-p3').admins).toEqual([]);
  });

  it('applies a change the creator makes, and the new admin may then add and remove', async () => {
    const { home, alice, bob, carol, dave, users } = await group('conv-p4', MANAGED);
    await alice.setPolicy('conv-p4', { ...alice.policyOf('conv-p4'), admins: ['@b:h'] });
    await bob.sync('conv-p4', home.frames.get('conv-p4'));
    await carol.sync('conv-p4', home.frames.get('conv-p4'));
    expect(bob.policyOf('conv-p4').admins).toEqual(['@b:h']);
    expect(bob.permits('conv-p4', 'add')).toBe(true);
    expect(carol.permits('conv-p4', 'add')).toBe(false);

    await bob.addMembers('conv-p4', ['@d:h']);
    await alice.sync('conv-p4', home.frames.get('conv-p4'));
    await carol.sync('conv-p4', home.frames.get('conv-p4'));
    await dave.sync('conv-p4', home.frames.get('conv-p4'));
    expect(alice.errorFor('conv-p4')).toBeUndefined();
    expect(carol.errorFor('conv-p4')).toBeUndefined();
    expect(users(carol).has('@d:h')).toBe(true);
    expect(dave.policyOf('conv-p4')?.creator).toBe('@a:h');

    await bob.removeMembers('conv-p4', ['@d:h']);
    await alice.sync('conv-p4', home.frames.get('conv-p4'));
    await carol.sync('conv-p4', home.frames.get('conv-p4'));
    expect(carol.errorFor('conv-p4')).toBeUndefined();
    expect(users(carol).has('@d:h')).toBe(false);
  });

  it('keeps the creator the creator, whoever asks', async () => {
    const { home, alice, bob } = await group('conv-p6', MANAGED);
    await alice.setPolicy('conv-p6', { ...alice.policyOf('conv-p6'), creator: '@b:h', admins: ['@b:h'] });
    await bob.sync('conv-p6', home.frames.get('conv-p6'));
    expect(bob.errorFor('conv-p6')).toBeUndefined();
    expect(bob.policyOf('conv-p6').creator).toBe('@a:h');
  });

  it('leaves a group made without a policy as open as groups always were', async () => {
    const { home, alice, bob, carol, users, built } = await group('conv-p5', null);
    expect(built.policy).toBe(false);
    expect(bob.policyOf('conv-p5')).toBeNull();
    expect(carol.permits('conv-p5', 'add')).toBe(true);
    await carol.addMembers('conv-p5', ['@d:h']);
    await alice.sync('conv-p5', home.frames.get('conv-p5'));
    await bob.sync('conv-p5', home.frames.get('conv-p5'));
    expect(alice.errorFor('conv-p5')).toBeUndefined();
    expect(users(bob).has('@d:h')).toBe(true);
  });
});
