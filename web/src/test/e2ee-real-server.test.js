import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Mls, decodeMessage, wipe } from '../lib/mls.js';
import { dmMethods } from '../lib/store/dms.js';
import { forgetDeviceSecrets, heldRecoveryKeyring } from '../lib/device-secrets.js';
import { load as loadVault, setMode } from '../lib/vault.js';
import { loginOpaque, registerOpaque } from '../lib/opaque-auth.js';
import { Trust } from '../lib/verify.js';
import { trustMethods } from '../lib/store/trust.js';
import { recoveryVaultWrapper } from '../lib/account-recovery.js';
import { sessionMethods } from '../lib/store/session.js';
import { RealHome, haveServer, lossy } from './real-home.js';
import { b64 } from '../lib/util.js';

const realFetch = globalThis.fetch;

let server;
let n = 0;
const name = (who) => `${who}${n += 1}`;

async function engine(account, api = account.api, recoveryKey = null) {
  const mls = new Mls(api, { userId: account.userId, deviceId: account.deviceId, recoveryKey });
  await mls.start();
  return mls;
}

function storeFor(account, mls, api = account.api) {
  return Object.assign(Object.create(dmMethods), {
    home: api,
    mls,
    me: { user_id: account.userId },
    conversations: [],
    rejoinBlocked: new Map(),
    dmMended: new Set(),
    dmFrames: new Map(),
    dmPending: new Map(),
    dmPendingFull: new Map(),
    dmLoading: new Map(),
    dmOpened: new Map(),
    dmUnread: new Map(),
    trust: null,
    vault: null,
    emit() {},
    scheduleSignals() {},
    async refreshConversations() {
      this.conversations = (await api.conversations()).conversations || [];
    },
  });
}

async function history(api, id) {
  const out = [];
  let after = 0;
  for (;;) {
    const page = (await api.dmHistory(id, { after, limit: 500 })).messages || [];
    out.push(...page);
    if (page.length < 500) return out;
    after = page.at(-1).seq;
  }
}

async function catchUp(mls, api, id) {
  await mls.sync(id, await history(api, id));
}

async function dm() {
  const alice = await server.register(name('alice'));
  const bob = await server.register(name('bob'));
  const am = await engine(alice);
  const bm = await engine(bob);
  const convo = await alice.api.createConversation({ kind: 'dm', members: [bob.userId] });
  const built = await am.establish(convo.id, [bob.userId], { generation: 0 });
  await alice.api.sendFrame(convo.id, {
    kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch, start_over: true, generation: 0,
  });
  await catchUp(am, alice.api, convo.id);
  await catchUp(bm, bob.api, convo.id);
  expect(bm.joined(convo.id)).toBe(true);
  return { id: convo.id, alice, bob, am, bm };
}

async function says(from, fromApi, to, toApi, id, text) {
  await from.send(id, text);
  const frames = await history(toApi, id);
  await to.sync(id, frames);
  const last = frames.findLast((f) => f.kind === 'application');
  return to.textOf(last.id);
}

describe.skipIf(!haveServer)('against the real server', () => {
  beforeAll(async () => { server = await RealHome.start(); });
  afterAll(async () => { await server?.stop(); });
  beforeEach(async () => {
    globalThis.fetch = realFetch;
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  it('founds a DM both members can read', async () => {
    const { id, alice, bob, am, bm } = await dm();
    expect(await says(am, alice.api, bm, bob.api, id, 'hello')).toBe('hello');
    expect(await says(bm, bob.api, am, alice.api, id, 'and back')).toBe('and back');
  });

  it('makes one group of two start-overs pressed at once', async () => {
    const { id, alice, bob, am, bm } = await dm();
    const a = storeFor(alice, am);
    const b = storeFor(bob, bm);
    await a.refreshConversations();
    await b.refreshConversations();

    const [mine, theirs] = await Promise.all([a.resetConversation(id), b.resetConversation(id)]);
    expect([mine.superseded, theirs.superseded].filter(Boolean)).toHaveLength(1);
    expect(mine.generation).toBe(2);
    expect(theirs.generation).toBe(2);
    const frames = await history(alice.api, id);
    const beginnings = frames.filter((f) => f.kind === 'welcome' && f.generation === 2);
    expect(beginnings).toHaveLength(1);
    expect((await alice.api.conversation(id)).generation).toBe(2);

    await catchUp(am, alice.api, id);
    await catchUp(bm, bob.api, id);
    expect(am.epochOf(id)).toBe(bm.epochOf(id));
    expect(await says(am, alice.api, bm, bob.api, id, 'one group')).toBe('one group');
    expect(await says(bm, bob.api, am, alice.api, id, 'this one')).toBe('this one');
  });

  it('lets go of a group a start-over replaced, and never rejoins through its GroupInfo', async () => {
    const alice = await server.register(name('alice'));
    const bob = await server.register(name('bob'));
    const key = () => crypto.getRandomValues(new Uint8Array(32));
    const am = await engine(alice, alice.api, key());
    const bm = await engine(bob, bob.api, key());
    const convo = await alice.api.createConversation({ kind: 'dm', members: [bob.userId] });
    const id = convo.id;
    const built = await am.establish(id, [bob.userId], { generation: 0 });
    await alice.api.sendFrame(id, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch, start_over: true, generation: 0,
    });
    await catchUp(am, alice.api, id);
    await catchUp(bm, bob.api, id);
    const a = storeFor(alice, am);
    await a.refreshConversations();
    await a.resetConversation(id);

    // The new group's Welcome does not let Bob's device in.
    bm.join = async () => { throw new Error('not addressed to this device'); };
    await am.send(id, 'after the start-over');
    await catchUp(bm, bob.api, id);
    expect(bm.errorFor(id)).toBeUndefined();
    expect(bm.joined(id)).toBe(false);

    // Bob's only GroupInfo is the replaced group's, at an epoch the restarted count would accept.
    expect(await bm.selfJoin(id, await history(bob.api, id))).toBe(false);
    const frames = await history(alice.api, id);
    expect(frames.some((f) => f.kind === 'commit' && f.sender === bob.userId)).toBe(false);
    await catchUp(am, alice.api, id);
    expect(am.errorFor(id)).toBeUndefined();
  });

  it('lets a device back in that a start-over did not reach, with nobody pressing anything', async () => {
    const { id, alice, bob, am, bm } = await dm();
    const a = storeFor(alice, am);
    const b = storeFor(bob, bm);
    a.trust = { authorizedRejoinDevice: async () => true };
    await a.refreshConversations();
    await b.refreshConversations();
    await a.resetConversation(id);
    const never = (await history(bob.api, id)).findLast((f) => f.kind === 'welcome').ciphertext;
    const mark = (m) => String(m?.welcome?.encryptedGroupInfo?.slice?.(0, 16));
    const blocked = mark(decodeMessage(never));
    const join = bm.join.bind(bm);
    bm.join = async (message) => {
      if (mark(message) === blocked) throw new Error('not addressed to this device');
      return join(message);
    };
    await am.send(id, 'one');
    await b.loadConversationNow(id);
    expect(bm.joined(id)).toBe(false);
    expect(bm.errorFor(id)).toBeUndefined();

    await a.loadConversationNow(id);
    await b.loadConversationNow(id);
    expect(bm.joined(id)).toBe(true);
    expect(await says(am, alice.api, bm, bob.api, id, 'two')).toBe('two');
    expect(await says(bm, bob.api, am, alice.api, id, 'back')).toBe('back');
    expect(am.errorFor(id)).toBeUndefined();
  });

  it('publishes a GroupInfo for the group a start-over made, though its epoch restarted', async () => {
    const alice = await server.register(name('alice'));
    const bob = await server.register(name('bob'));
    const key = () => crypto.getRandomValues(new Uint8Array(32));
    const am = await engine(alice, alice.api, key());
    const bm = await engine(bob, bob.api, key());
    const convo = await alice.api.createConversation({ kind: 'dm', members: [bob.userId] });
    const id = convo.id;
    const built = await am.establish(id, [bob.userId], { generation: 0 });
    await alice.api.sendFrame(id, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch, start_over: true, generation: 0,
    });
    await catchUp(bm, bob.api, id);
    const a = storeFor(alice, am);
    await a.refreshConversations();
    await a.resetConversation(id);
    await catchUp(bm, bob.api, id);
    expect(bm.groups.get(id).generation).toBe(2);
    const infos = (await history(bob.api, id)).filter((f) => f.kind === 'groupinfo' && f.sender === bob.userId);
    expect(infos.map((f) => f.generation)).toEqual([1, 2]);
  });

  it('adopts a commit whose answer was lost, and sends it once', async () => {
    const { id, alice, bob, bm } = await dm();
    const api = lossy(alice.api);
    const am = await engine(alice, api);
    await catchUp(am, api, id);
    const before = am.epochOf(id);
    api.lose((method, [, body]) => method === 'sendFrame' && body.kind === 'commit');
    await expect(am.setPolicy(id, { add: 'anyone', remove: 'anyone', policy: 'anyone', admins: [] }))
      .rejects.toMatchObject({ status: 503 });
    expect(am.epochOf(id)).toBe(before);

    await catchUp(am, api, id);
    expect(am.epochOf(id)).toBe(before + 1);
    const commits = (await history(alice.api, id)).filter((f) => f.kind === 'commit');
    expect(commits).toHaveLength(1);
    expect(await says(am, alice.api, bm, bob.api, id, 'after the lost answer')).toBe('after the lost answer');
  });

  it('takes a start-over whose answer was lost as the one the sequencer ordered', async () => {
    const { id, alice, bob, am, bm } = await dm();
    const api = lossy(alice.api);
    const a = storeFor(alice, am, api);
    am.home = api;
    await a.refreshConversations();
    api.lose((method, [, body]) => method === 'sendFrame' && body.start_over);

    const done = await a.resetConversation(id);
    expect(done.generation).toBe(2);
    expect(done.superseded).toBeUndefined();
    const beginnings = (await history(alice.api, id)).filter((f) => f.kind === 'welcome' && f.generation === 2);
    expect(beginnings).toHaveLength(1);

    await catchUp(bm, bob.api, id);
    expect(bm.epochOf(id)).toBe(am.epochOf(id));
    expect(await says(am, alice.api, bm, bob.api, id, 'started over')).toBe('started over');
    expect(await says(bm, bob.api, am, alice.api, id, 'heard')).toBe('heard');
  });

  it('finds its own start-over when every answer to it was lost', async () => {
    const { id, alice, bob, am, bm } = await dm();
    const api = lossy(alice.api);
    const a = storeFor(alice, am, api);
    am.home = api;
    await a.refreshConversations();
    for (let i = 0; i < 3; i += 1) api.lose((method, [, body]) => method === 'sendFrame' && body.start_over);

    const done = await a.resetConversation(id);
    expect(done.generation).toBe(2);
    const beginnings = (await history(alice.api, id)).filter((f) => f.kind === 'welcome' && f.generation === 2);
    expect(beginnings).toHaveLength(1);
    await catchUp(bm, bob.api, id);
    await catchUp(am, api, id);
    expect(am.errorFor(id)).toBeFalsy();
    expect(await says(bm, bob.api, am, alice.api, id, 'are you there')).toBe('are you there');
    expect(await says(am, alice.api, bm, bob.api, id, 'yes')).toBe('yes');
  });

  it('adopts a join whose answer was lost, and joins once', async () => {
    const alice = await server.register(name('alice'));
    const bob = await server.register(name('bob'));
    const key = crypto.getRandomValues(new Uint8Array(32));
    const am = await engine(alice, alice.api, key);
    const bm = await engine(bob);
    const { id } = await alice.api.createConversation({ kind: 'dm', members: [bob.userId] });
    const built = await am.establish(id, [bob.userId], { generation: 0 });
    await alice.api.sendFrame(id, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch, start_over: true, generation: 0,
    });
    await catchUp(am, alice.api, id);
    await catchUp(bm, bob.api, id);
    expect(await says(am, alice.api, bm, bob.api, id, 'before')).toBe('before');

    await am.forget(id);
    const again = await server.login(alice.userId);
    const api = lossy(again.api);
    const am2 = await engine(again, api, key);
    api.lose((method, [, body]) => method === 'sendFrame' && body.kind === 'commit');
    await expect(am2.selfJoin(id, await history(api, id))).rejects.toMatchObject({ status: 503 });

    await catchUp(am2, api, id);
    expect(am2.joined(id)).toBe(true);
    expect(am2.errorFor(id)).toBeFalsy();
    const joins = (await history(alice.api, id)).filter((f) => f.kind === 'commit');
    expect(joins).toHaveLength(1);

    await catchUp(bm, bob.api, id);
    const keys = bm.devicesIn(id).filter((d) => d.userId === alice.userId).map((d) => d.signatureKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(bm.epochOf(id)).toBe(am2.epochOf(id));
    expect(await says(am2, api, bm, bob.api, id, 'back in')).toBe('back in');
    expect(await says(bm, bob.api, am2, api, id, 'welcome back')).toBe('welcome back');
  });

  it('keeps the ring of a first vault write whose answer was lost', async () => {
    const alice = await server.register(name('alice'));
    const api = lossy(alice.api);
    api.lose((method) => method === 'putVault');
    await expect(loadVault(api, null, alice.userId)).rejects.toMatchObject({ status: 503 });
    const { version } = await alice.api.vault();

    const loaded = await loadVault(alice.api, null, alice.userId);
    expect(loaded.locked).toBeFalsy();
    expect(loaded.raw).toEqual((await heldRecoveryKeyring(alice.userId)).raw);
    expect(loaded.created).toBeFalsy();
    expect((await alice.api.vault()).version).toBe(version);
  });

  it('keeps the ring of a passphrase vault write whose answer was lost', async () => {
    const alice = await server.register(name('alice'));
    const passphrase = `pp-${crypto.randomUUID()}`;
    const api = lossy(alice.api);
    api.lose((method) => method === 'putVault');
    await expect(loadVault(api, passphrase, alice.userId)).rejects.toMatchObject({ status: 503 });
    const loaded = await loadVault(alice.api, passphrase, alice.userId);
    expect(loaded.locked).toBeFalsy();
    expect(loaded.raw).toEqual((await heldRecoveryKeyring(alice.userId)).raw);
  });

  it('lets a member who left be added back on the same profile', async () => {
    const alice = await server.register(name('alice'));
    const bob = await server.register(name('bob'));
    const carol = await server.register(name('carol'));
    const am = await engine(alice);
    let bm = await engine(bob);
    const cm = await engine(carol);
    const { id } = await alice.api.createConversation({ kind: 'gc', members: [bob.userId, carol.userId] });
    const built = await am.establish(id, [bob.userId, carol.userId], { generation: 0 });
    await alice.api.sendFrame(id, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch, start_over: true, generation: 0,
    });
    for (const [m, who] of [[am, alice], [bm, bob], [cm, carol]]) await catchUp(m, who.api, id);
    expect(await says(am, alice.api, bm, bob.api, id, 'all three')).toBe('all three');

    await storeFor(bob, bm).leaveConversation(id);
    expect(bm.joined(id)).toBe(false);
    const a = storeFor(alice, am);
    await catchUp(am, alice.api, id);
    await a.refreshConversations();
    await a.settleDepartures(id);
    expect(am.devicesIn(id).some((d) => d.userId === bob.userId)).toBe(false);
    await catchUp(cm, carol.api, id);
    expect(cm.epochOf(id)).toBe(am.epochOf(id));

    await a.addToConversation(id, bob.userId);
    bm = await engine(bob);
    await catchUp(bm, bob.api, id);
    expect(bm.joined(id)).toBe(true);
    expect(bm.errorFor(id)).toBeFalsy();
    await catchUp(cm, carol.api, id);
    expect(bm.epochOf(id)).toBe(am.epochOf(id));
    expect(await says(am, alice.api, bm, bob.api, id, 'welcome back')).toBe('welcome back');
    expect(await says(bm, bob.api, cm, carol.api, id, 'glad to be')).toBe('glad to be');
  });

  it('a device that signs in to a password account after the one that made it can sign itself', async () => {
    const password = `pw-${crypto.randomUUID()}`;
    const reg = await registerOpaque(server.base, name('alice'), password, 'web');
    const first = server.wrap(reg.session);
    const ring = await loadVault(
      first.api, null, first.userId, reg.recoveryWrapper, reg.accountRecovery.vaultWrapper,
    );
    expect(ring.mode).toBe('opaque_custody');
    // As at sign-up: custody was read before this device created the vault.
    const mode = trustMethods.custodyMode.call({ custody: { mode: 'none' }, vault: ring });
    expect(mode).toBe('opaque_custody');
    const m1 = await engine(first, first.api, ring.key);
    const t1 = new Trust(first.api, { userId: first.userId, deviceId: first.deviceId, recovery: ring });
    await t1.start(m1.cs, ring.key, await m1.leafKey(), mode);
    expect(t1.canSign).toBe(true);

    // Another app on another machine: nothing of the first device's on disk.
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
    await forgetDeviceSecrets(first.userId);
    const login = await loginOpaque(server.base, first.userId, password, 'desktop');
    const second = server.wrap(login.session);
    const again = await loadVault(second.api, null, second.userId, login.recoveryWrapper);
    expect(again.raw).toEqual(ring.raw);
    const m2 = await engine(second, second.api, again.key);
    const t2 = new Trust(second.api, { userId: second.userId, deviceId: second.deviceId, recovery: again });
    await t2.start(m2.cs, again.key, await m2.leafKey(), trustMethods.custodyMode.call({ vault: again }));
    expect(t2.canSign).toBe(true);
    expect(t2.identityMismatch).toBeFalsy();
    // What another person's device checks before adding this one to a group.
    const bob = await server.register(name('bob'));
    const bm = await engine(bob, bob.api, crypto.getRandomValues(new Uint8Array(32)));
    const tb = new Trust(bob.api, { userId: bob.userId, deviceId: bob.deviceId });
    await tb.start(bm.cs, null, await bm.leafKey(), 'device_custody');
    expect(await tb.verifyClaimedPackage(second.userId, second.deviceId, await m2.leafKey())).toBe(true);
  });

  it('an account made before the custody fix heals once the device that made it opens again', async () => {
    const password = `pw-${crypto.randomUUID()}`;
    const reg = await registerOpaque(server.base, name('alice'), password, 'web');
    const first = server.wrap(reg.session);
    const ring = await loadVault(
      first.api, null, first.userId, reg.recoveryWrapper, reg.accountRecovery.vaultWrapper,
    );
    // The old bug: identity sealed under a throwaway key.
    const m1 = await engine(first, first.api, ring.key);
    const t1 = new Trust(first.api, { userId: first.userId, deviceId: first.deviceId, recovery: ring });
    await t1.start(m1.cs, ring.key, await m1.leafKey(), 'device_custody');
    expect(String((await first.api.crossSigning()).sealed_secret)).toMatch(/^device-v1:/);

    // The second device signs in while the account is broken.
    const firstDb = globalThis.indexedDB;
    const firstStorage = Object.fromEntries(
      Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).map((k) => [k, localStorage.getItem(k)]),
    );
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    const login = await loginOpaque(server.base, first.userId, password, 'desktop');
    const second = server.wrap(login.session);
    const again = await loadVault(second.api, null, second.userId, login.recoveryWrapper);
    const m2 = await engine(second, second.api, again.key);
    const broken = new Trust(second.api, { userId: second.userId, deviceId: second.deviceId, recovery: again });
    await broken.start(m2.cs, again.key, await m2.leafKey(), trustMethods.custodyMode.call({ vault: again }));
    expect(broken.canSign).toBe(false);
    const secondDb = globalThis.indexedDB;

    // The making device reopens on new code from a restored session: no password typed.
    globalThis.indexedDB = firstDb;
    localStorage.clear();
    for (const [k, v] of Object.entries(firstStorage)) localStorage.setItem(k, v);
    const reopened = await loadVault(first.api, null, first.userId);
    const mode = trustMethods.custodyMode.call({ custody: { mode: reopened.mode }, vault: reopened });
    const t1b = new Trust(first.api, { userId: first.userId, deviceId: first.deviceId, recovery: reopened });
    await t1b.start(m1.cs, reopened.key, await m1.leafKey(), mode);
    expect(t1b.canSign).toBe(true);

    // The second device restarts and can now sign itself.
    globalThis.indexedDB = secondDb;
    const healed = new Trust(second.api, { userId: second.userId, deviceId: second.deviceId, recovery: again });
    await healed.start(m2.cs, again.key, await m2.leafKey(), trustMethods.custodyMode.call({ vault: again }));
    expect(healed.canSign).toBe(true);
  });

  it('a second tab open during sign-up does not cost the new recovery key its copy', async () => {
    const password = `pw-${crypto.randomUUID()}`;
    const reg = await registerOpaque(server.base, name('alice'), password, 'web');
    expect(reg.session.recovery_key_enrolled).toBe(true);
    const first = server.wrap(reg.session);
    // The other tab restores the session (no password, no recovery wrappers) and makes the vault first.
    const otherTab = await loadVault(first.api, null, first.userId);
    expect(otherTab.mode).toBe('device_custody');

    const signingUp = await loadVault(
      first.api, null, first.userId, reg.recoveryWrapper, reg.accountRecovery.vaultWrapper,
    );
    expect(signingUp.mode).toBe('opaque_custody');
    expect(signingUp.recoveryKey).toBe(true);
    const custody = await first.api.vaultMode();
    expect(custody.recovery_copy_missing).toBe(false);
  });

  it('two starts at once on a new account leave this device holding the key it published', async () => {
    const password = `pw-${crypto.randomUUID()}`;
    const reg = await registerOpaque(server.base, name('alice'), password, 'web');
    const first = server.wrap(reg.session);
    const ring = await loadVault(
      first.api, null, first.userId, reg.recoveryWrapper, reg.accountRecovery.vaultWrapper,
    );
    const m1 = await engine(first, first.api, ring.key);
    const leaf = await m1.leafKey();
    const make = (api = first.api) => new Trust(api, { userId: first.userId, deviceId: first.deviceId, recovery: ring });
    // The second start's requests are slower, as a second tab's can be.
    const slow = new Proxy(first.api, {
      get(target, key) {
        const v = target[key];
        if (typeof v !== 'function') return v;
        return async (...args) => {
          if (key !== 'crossSigning') await new Promise((r) => setTimeout(r, 30));
          return v.apply(target, args);
        };
      },
    });
    const [a, b] = [make(), make(slow)];
    await Promise.allSettled([
      a.start(m1.cs, ring.key, leaf, 'opaque_custody'),
      b.start(m1.cs, ring.key, leaf, 'opaque_custody'),
    ]);
    const later = make();
    await later.start(m1.cs, ring.key, leaf, 'opaque_custody');
    expect(later.identityMismatch).toBeFalsy();
    expect(later.canSign).toBe(true);
  });

  // Each simulated device keeps its own IndexedDB and localStorage (pins live there).
  function devices() {
    const saved = new Map();
    let current = null;
    const snapshot = () => Object.fromEntries(
      Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).map((k) => [k, localStorage.getItem(k)]),
    );
    return (label) => {
      if (current) saved.set(current, { db: globalThis.indexedDB, storage: snapshot() });
      current = label;
      const next = saved.get(label);
      globalThis.indexedDB = next?.db || new IDBFactory();
      localStorage.clear();
      for (const [k, v] of Object.entries(next?.storage || {})) localStorage.setItem(k, v);
    };
  }

  // An OPAQUE account whose root lives only on its first device (device custody), plus a contact who verified it.
  async function lostRootAccount(on) {
    const password = `pw-${crypto.randomUUID()}`;
    on('alice-1');
    const reg = await registerOpaque(server.base, name('alice'), password, 'web');
    const first = server.wrap(reg.session);
    const ring = await loadVault(first.api, null, first.userId, reg.recoveryWrapper, reg.accountRecovery.vaultWrapper);
    const m1 = await engine(first, first.api, ring.key);
    const t1 = new Trust(first.api, { userId: first.userId, deviceId: first.deviceId, recovery: ring });
    await t1.start(m1.cs, ring.key, await m1.leafKey(), 'device_custody');
    expect(t1.canSign).toBe(true);

    on('bob');
    const bob = await server.register(name('bob'));
    const bm = await engine(bob);
    const tb = new Trust(bob.api, { userId: bob.userId, deviceId: bob.deviceId });
    await tb.start(bm.cs, crypto.getRandomValues(new Uint8Array(32)), await bm.leafKey(), 'device_custody');
    await tb.vouchForUser(first.userId, b64(t1.identityKey));
    tb.peers.clear();
    await tb.refresh(first.userId);
    expect(tb.statusFor(first.userId, first.deviceId, null)).toBe('verified');

    // Alice's only device is gone; she signs in somewhere new.
    on('alice-2');
    const login = await loginOpaque(server.base, first.userId, password, 'desktop');
    const second = server.wrap(login.session);
    const again = await loadVault(second.api, null, second.userId, login.recoveryWrapper);
    const m2 = await engine(second, second.api, again.key);
    const t2 = new Trust(second.api, { userId: second.userId, deviceId: second.deviceId, recovery: again });
    await t2.start(m2.cs, again.key, await m2.leafKey(), 'device_custody');
    expect(t2.canSign).toBe(false);
    return { reg, first, m1, t1, bob, bm, tb, second, m2, t2 };
  }

  it('a recovery-key reset starts a new identity that contacts must verify again', async () => {
    const on = devices();
    const { reg, first, m1, tb, second, m2, t2 } = await lostRootAccount(on);

    on('alice-2');
    const outcome = await t2.recoverWithRecoveryKey(reg.accountRecovery.text, { mlsKey: await m2.leafKey() });
    expect(outcome.reset).toBe(true);
    expect(t2.canSign).toBe(true);
    expect(t2.continuity.valid).toBe(true);
    // The next start on this device takes the new identity as its own.
    const reopened = new Trust(second.api, { userId: second.userId, deviceId: second.deviceId });
    await reopened.start(m2.cs, null, await m2.leafKey(), 'device_custody');
    expect(reopened.canSign).toBe(true);
    expect(reopened.identityMismatch).toBe(false);

    // Bob pinned the old identity: changed, until he compares emoji with Alice again.
    on('bob');
    tb.peers.clear();
    expect(tb.statusFor(first.userId, second.deviceId, null)).not.toBe('verified');
    await tb.refresh(first.userId);
    expect(tb.statusFor(first.userId, second.deviceId, null)).toBe('changed');
    // Without a finished comparison the changed identity stays refused.
    await tb.vouchForUser(first.userId, b64(t2.identityKey)).catch(() => {});
    tb.peers.clear();
    await tb.refresh(first.userId);
    expect(tb.statusFor(first.userId, second.deviceId, null)).toBe('changed');
    await tb.vouchForUser(first.userId, b64(t2.identityKey), { comparedNow: true });
    tb.peers.clear();
    await tb.refresh(first.userId);
    expect(tb.statusFor(first.userId, second.deviceId, null)).toBe('verified');

    // Alice's old device comes back: changed for itself too, until it takes the key from the device that reset.
    on('alice-1');
    const back = new Trust(first.api, { userId: first.userId, deviceId: first.deviceId });
    await back.start(m1.cs, null, await m1.leafKey(), 'device_custody');
    expect(back.identityMismatch).toBe(true);
    await back.adoptSecret(t2.signKey, b64(t2.identityKey));
    expect(back.canSign).toBe(true);
    expect(back.identityMismatch).toBe(false);
  });

  it('a reset whose answer was lost is taken up when the device reopens', async () => {
    const on = devices();
    const { reg, second, m2, t2 } = await lostRootAccount(on);
    on('alice-2');
    const dropped = new Proxy(second.api, {
      get(target, key) {
        if (key !== 'identityResetFinish') return target[key];
        return async (body) => {
          await target.identityResetFinish(body);
          throw new Error('connection dropped');
        };
      },
    });
    const cut = new Trust(dropped, { userId: second.userId, deviceId: second.deviceId, recovery: t2.recovery });
    await cut.start(m2.cs, null, await m2.leafKey(), 'device_custody');
    await expect(cut.recoverWithRecoveryKey(reg.accountRecovery.text, { mlsKey: await m2.leafKey() })).rejects.toThrow();

    const reopened = new Trust(second.api, { userId: second.userId, deviceId: second.deviceId });
    await reopened.start(m2.cs, null, await m2.leafKey(), 'device_custody');
    expect(reopened.canSign).toBe(true);
    expect(reopened.identityMismatch).toBe(false);
    expect(reopened.continuity.valid).toBe(true);
  });

  it('replaces a recovery key so the new one opens the vault, and a failed try keeps the old', async () => {
    const password = `pw-${crypto.randomUUID()}`;
    const reg = await registerOpaque(server.base, name('alice'), password, 'test');
    const account = server.wrap(reg.session);
    const opened = await loadVault(
      account.api, null, account.userId, reg.recoveryWrapper, reg.accountRecovery.vaultWrapper,
    );
    expect(opened.recoveryKey).toBe(true);
    const store = Object.assign(Object.create(sessionMethods), {
      home: account.api,
      opaqueAuth: true,
      authRecoveryWrapper: reg.recoveryWrapper,
      accountRecoveryWrapper: reg.accountRecovery.vaultWrapper,
      vault: opened,
      emit() {},
      async refreshCustody() {},
    });
    const fresh = async (wrapper) => {
      globalThis.indexedDB = new IDBFactory();
      await wipe();
      return loadVault(account.api, null, account.userId, null, wrapper);
    };

    await expect(store.enrollRecoveryKey(`not-${password}`, { replace: true })).rejects.toThrow();
    expect((await fresh(reg.accountRecovery.vaultWrapper)).raw).toEqual(opened.raw);

    const text = await store.enrollRecoveryKey(password, { replace: true });
    const next = await fresh(recoveryVaultWrapper(text));
    expect(next.locked).toBeFalsy();
    expect(next.raw).toEqual(opened.raw);
    const old = await fresh(reg.accountRecovery.vaultWrapper);
    expect(old.raw).toBeNull();
    expect(old.needs_recovery_key).toBe(true);
  });

  it('lets a new profile of an escrowed account join from the server-held ring', async () => {
    const alice = await server.register(name('alice'));
    const bob = await server.register(name('bob'));
    const held = await loadVault(alice.api, null, alice.userId);
    const escrowed = await setMode(alice.api, held, 'escrowed', null, alice.userId);
    expect((await alice.api.vault()).escrow_key).toBeTruthy();
    const am = await engine(alice, alice.api, escrowed.raw);
    const bm = await engine(bob);
    const { id } = await alice.api.createConversation({ kind: 'dm', members: [bob.userId] });
    const built = await am.establish(id, [bob.userId], { generation: 0 });
    await alice.api.sendFrame(id, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch, start_over: true, generation: 0,
    });
    await catchUp(am, alice.api, id);
    await catchUp(bm, bob.api, id);
    expect(await says(am, alice.api, bm, bob.api, id, 'before')).toBe('before');

    await am.forget(id);
    await forgetDeviceSecrets(alice.userId);
    const again = await server.login(alice.userId);
    const ring = await loadVault(again.api, null, alice.userId);
    expect(ring.mode).toBe('escrowed');
    expect(ring.raw).toEqual(escrowed.raw);
    const am2 = await engine(again, again.api, ring.raw);
    await am2.selfJoin(id, await history(again.api, id));
    await catchUp(am2, again.api, id);
    expect(am2.joined(id)).toBe(true);
    expect(am2.errorFor(id)).toBeFalsy();

    await catchUp(bm, bob.api, id);
    expect(bm.epochOf(id)).toBe(am2.epochOf(id));
    expect(await says(am2, again.api, bm, bob.api, id, 'from escrow')).toBe('from escrow');
    expect(await says(bm, bob.api, am2, again.api, id, 'heard')).toBe('heard');
  });
});
