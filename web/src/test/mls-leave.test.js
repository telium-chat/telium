import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  createGroupInfoWithExternalPubAndRatchetTree, defaultLifetime,
  generateKeyPackageWithKey, joinGroupExternal,
} from 'ts-mls';
import { defaultClientConfig } from 'ts-mls/clientConfig.js';
import { capabilities, encode64, judgeCommit, wipe, wire } from '../lib/mls.js';
import { FakeHome, device } from './mls-home.js';

const MANAGED = { add: 'admins', remove: 'admins', policy: 'creator', admins: [] };

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  await wipe();
});

async function group(conv, policy = MANAGED) {
  const home = new FakeHome();
  const alice = await device(home, '@a:h', 'd-alice');
  const bob = await device(home, '@b:h', 'd-bob');
  const carol = await device(home, '@c:h', 'd-carol');
  const built = await alice.establish(conv, ['@b:h', '@c:h'], { policy });
  await home.for('@a:h', 'd-alice').sendFrame(conv, {
    kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
  });
  await bob.sync(conv, home.frames.get(conv));
  await carol.sync(conv, home.frames.get(conv));
  const users = (mls) => mls.devicesIn(conv).map((d) => d.userId).sort();
  return { home, alice, bob, carol, users };
}

describe('leaving a conversation', () => {
  it('sends a Remove for the leaver’s leaf, which a member without the remove right may commit', async () => {
    const { home, alice, bob, carol, users } = await group('conv-leave');
    expect(carol.permits('conv-leave', 'remove')).toBe(false);

    const { proposed } = await bob.proposeLeave('conv-leave');
    expect(proposed).toBe(1);
    const proposals = home.frames.get('conv-leave').filter((f) => f.kind === 'proposal');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].sender).toBe('@b:h');

    await carol.sync('conv-leave', home.frames.get('conv-leave'));
    expect(carol.errorFor('conv-leave')).toBeUndefined();
    const sent = [];
    const post = carol.home.sendFrame;
    carol.home.sendFrame = async (id, body) => { sent.push(body); return post(id, body); };
    const { removed } = await carol.removeDeparted('conv-leave', ['@b:h']);
    expect(removed).toBe(1);
    const commit = home.frames.get('conv-leave').filter((f) => f.kind === 'commit').at(-1);
    expect(commit.sender).toBe('@c:h');
    expect(sent.find((b) => b.kind === 'commit').change).toEqual({ op: 'remove', user_ids: ['@b:h'] });

    await alice.sync('conv-leave', home.frames.get('conv-leave'));
    expect(alice.errorFor('conv-leave')).toBeUndefined();
    expect(users(alice)).toEqual(['@a:h', '@c:h']);
    expect(users(carol)).toEqual(['@a:h', '@c:h']);

    const said = await alice.send('conv-leave', 'after bob left');
    await carol.sync('conv-leave', home.frames.get('conv-leave'));
    expect(carol.textOf(said.id)).toBe('after bob left');
  });

  it('commits a held leave before the next message, so nobody is stuck unable to send', async () => {
    const { home, alice, bob, carol, users } = await group('conv-held');
    await bob.proposeLeave('conv-held');
    await carol.sync('conv-held', home.frames.get('conv-held'));

    const said = await carol.send('conv-held', 'still here');
    const kinds = home.frames.get('conv-held').slice(-2).map((f) => f.kind);
    expect(kinds).toEqual(['commit', 'application']);
    await alice.sync('conv-held', home.frames.get('conv-held'));
    expect(alice.errorFor('conv-held')).toBeUndefined();
    expect(alice.textOf(said.id)).toBe('still here');
    expect(users(alice)).toEqual(['@a:h', '@c:h']);
  });

  it('steps over a proposal to remove somebody else, rather than holding it', async () => {
    const { home, alice, bob, carol, users } = await group('conv-oust');
    const entry = bob.groups.get('conv-oust');
    const carolLeaf = entry.state.ratchetTree.findIndex(
      (n, i) => i % 2 === 0 && n?.leaf && new TextDecoder().decode(n.leaf.credential.identity).startsWith('@c:h'),
    ) / 2;
    const { createProposal } = await import('ts-mls');
    const { wire } = await import('../lib/mls.js');
    const made = await createProposal(entry.state, false, { proposalType: 'remove', remove: { removed: carolLeaf } }, bob.cs);
    await home.for('@b:h', 'd-bob').sendFrame('conv-oust', {
      kind: 'proposal',
      ciphertext: btoa(String.fromCharCode(...wire.privateMessage(made.message.privateMessage))),
      epoch: Number(made.newState.groupContext.epoch),
    });

    await alice.sync('conv-oust', home.frames.get('conv-oust'));
    expect(alice.errorFor('conv-oust')).toBeUndefined();
    const said = await alice.send('conv-oust', 'nothing changed');
    await carol.sync('conv-oust', home.frames.get('conv-oust'));
    expect(carol.errorFor('conv-oust')).toBeUndefined();
    expect(carol.textOf(said.id)).toBe('nothing changed');
    expect(users(alice)).toEqual(['@a:h', '@b:h', '@c:h']);
  });

  it('leaves leaves the leaver did not propose to a member with the remove right', async () => {
    const { home, alice, carol, users } = await group('conv-ghost');
    expect((await carol.removeDeparted('conv-ghost', ['@b:h'])).removed).toBe(0);
    expect((await alice.removeDeparted('conv-ghost', ['@b:h'])).removed).toBe(1);
    await carol.sync('conv-ghost', home.frames.get('conv-ghost'));
    expect(carol.errorFor('conv-ghost')).toBeUndefined();
    expect(users(carol)).toEqual(['@a:h', '@c:h']);
  });
});

describe('a join from outside the group', () => {
  it('may only take out the leaf holding its own key', async () => {
    const { alice } = await group('conv-ext');
    const tree = alice.groups.get('conv-ext').state.ratchetTree;
    const leaves = [];
    tree.forEach((n, i) => { if (i % 2 === 0 && n?.leaf) leaves.push({ index: i / 2, key: n.leaf.signaturePublicKey }); });
    const [, victim] = leaves;
    const removeVictim = [{ proposal: { proposalType: 'remove', remove: { removed: victim.index } } }];
    const policy = alice.policyOf('conv-ext');
    expect(judgeCommit(policy, tree, { senderLeafIndex: undefined, proposals: removeVictim, joinerKey: new Uint8Array(32) }))
      .toMatch(/own leaf/);
    expect(judgeCommit(policy, tree, { senderLeafIndex: undefined, proposals: removeVictim, joinerKey: null }))
      .toMatch(/own leaf/);
    expect(judgeCommit(policy, tree, { senderLeafIndex: undefined, proposals: removeVictim, joinerKey: victim.key }))
      .toBeNull();
  });

  it('replaces a leaf this browser left behind instead of being refused as a duplicate', async () => {
    const home = new FakeHome();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const alice = await device(home, '@a:h', 'd-alice', key);
    const bob = await device(home, '@b:h', 'd-bob');
    const built = await alice.establish('conv-resync', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-resync', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-resync', home.frames.get('conv-resync'));
    await alice.sync('conv-resync', home.frames.get('conv-resync'));
    await alice.forget('conv-resync');
    const reloaded = await device(home, '@a:h', 'd-alice-reloaded', key);
    expect(await reloaded.leafKey()).toBe(await alice.leafKey());

    expect(await reloaded.selfJoin('conv-resync', home.frames.get('conv-resync'))).toBe(true);
    await bob.sync('conv-resync', home.frames.get('conv-resync'));
    expect(bob.errorFor('conv-resync')).toBeUndefined();
    const mine = bob.devicesIn('conv-resync').filter((d) => d.userId === '@a:h');
    expect(mine).toHaveLength(1);
    expect(mine[0].signatureKey).toBe(await alice.leafKey());

    const said = await bob.send('conv-resync', 'welcome back');
    await reloaded.sync('conv-resync', home.frames.get('conv-resync'));
    expect(reloaded.textOf(said.id)).toBe('welcome back');
  });
});

describe('a join that keeps the leaf it left behind', () => {
  it('is built and taken, and then blocks every add', async () => {
    const home = new FakeHome();
    const alice = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    const built = await alice.establish('conv-dup', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame('conv-dup', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('conv-dup', home.frames.get('conv-dup'));

    const info = await createGroupInfoWithExternalPubAndRatchetTree(
      alice.groups.get('conv-dup').state, [], alice.cs,
    );
    const self = await generateKeyPackageWithKey(
      alice.credential(), capabilities(), defaultLifetime, [], await alice.signatureKeyPair(), alice.cs,
    );
    const joined = await joinGroupExternal(
      info, self.publicPackage, self.privatePackage, false, alice.cs, undefined, defaultClientConfig,
    );
    await home.for('@a:h', 'd-alice-again').sendFrame('conv-dup', {
      kind: 'commit',
      ciphertext: encode64(wire.publicMessage(joined.publicMessage)),
      epoch: Number(joined.newState.groupContext.epoch),
    });
    await bob.sync('conv-dup', home.frames.get('conv-dup'));
    expect(bob.errorFor('conv-dup')).toBeUndefined();
    const key = await alice.leafKey();
    expect(bob.devicesIn('conv-dup').filter((d) => d.signatureKey === key)).toHaveLength(2);

    await device(home, '@c:h', 'd-carol');
    await expect(bob.addMembers('conv-dup', ['@c:h'])).rejects.toThrow(/signature keys not unique/);
  });
});

describe('two sessions of one browser profile', () => {
  it('are one device: a reload asking back in claims nothing and adds nothing', async () => {
    const { home, alice } = await group('conv-two', null);
    const reloaded = await device(home, '@b:h', 'd-bob-reloaded');
    await reloaded.requestRejoin('conv-two');
    await alice.sync('conv-two', home.frames.get('conv-two'));
    const asking = alice.takeRejoins('conv-two');
    const laptopKey = alice.devicesIn('conv-two').find((d) => d.deviceId === 'd-bob').signatureKey;
    expect(asking).toEqual([{ userId: '@b:h', deviceId: 'd-bob-reloaded', signatureKey: laptopKey }]);

    let claims = 0;
    const claim = alice.home.claimKeyPackages;
    alice.home.claimKeyPackages = async (...args) => { claims += 1; return claim(...args); };
    const before = alice.devicesIn('conv-two').length;
    expect((await alice.catchUp('conv-two', asking)).added).toBe(0);
    expect(claims).toBe(0);
    expect(alice.devicesIn('conv-two').length).toBe(before);
  });
});
