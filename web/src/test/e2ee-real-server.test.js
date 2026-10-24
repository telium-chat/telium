import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Mls, wipe } from '../lib/mls.js';
import { dmMethods } from '../lib/store/dms.js';
import { forgetDeviceSecrets, heldRecoveryKeyring } from '../lib/device-secrets.js';
import { load as loadVault, setMode } from '../lib/vault.js';
import { registerOpaque } from '../lib/opaque-auth.js';
import { recoveryVaultWrapper } from '../lib/account-recovery.js';
import { sessionMethods } from '../lib/store/session.js';
import { RealHome, haveServer, lossy } from './real-home.js';

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
