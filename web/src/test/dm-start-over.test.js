import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { HttpError } from '../lib/api.js';
import { Mls, wipe } from '../lib/mls.js';
import { dmMethods } from '../lib/store/dms.js';
import { FakeHome } from './mls-home.js';

function api(home, userId, deviceId, extra = {}, sent = []) {
  const base = home.for(userId, deviceId);
  return {
    ...base,
    async sendFrame(conversationId, body) {
      sent.push(body);
      if (extra.before) await extra.before(body);
      try {
        return await base.sendFrame(conversationId, body);
      } catch (e) {
        if (e.status) throw new HttpError(e.status, { message: e.message, ...(e.body || {}) });
        throw e;
      }
    },
    ...extra,
  };
}

async function engine(home, userId, deviceId) {
  const mls = new Mls(api(home, userId, deviceId), { userId, deviceId });
  await mls.start();
  return mls;
}

function storeFor(home, mls, userId, deviceId, conversation, hooks = {}) {
  const sent = [];
  const store = Object.assign(Object.create(dmMethods), {
    home: api(home, userId, deviceId, {
      conversation: async (id) => conversation(id),
      createConversation: async () => conversation(),
      ...hooks,
    }, sent),
    mls,
    me: { user_id: userId },
    conversations: [conversation()],
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
    refreshConversations: async () => {},
  });
  return { store, sent };
}

function row(home, id, creator, members) {
  return () => ({
    id,
    kind: 'dm',
    creator,
    epoch: home.epochs.get(id) || 0,
    generation: home.generations.get(id) || 0,
    last_seq: (home.frames.get(id) || []).length,
    members: members.map((u) => ({ user_id: u, state: 'joined' })),
  });
}

const frames = (home, id) => home.frames.get(id) || [];
const read = (mls, home, id) => frames(home, id)
  .filter((f) => f.kind === 'application')
  .map((f) => mls.textOf(f.id))
  .filter(Boolean);

async function pair() {
  const home = new FakeHome();
  const alice = await engine(home, '@a:h', 'd-alice');
  const bob = await engine(home, '@b:h', 'd-bob');
  const convo = row(home, 'dm-1', '@a:h', ['@a:h', '@b:h']);
  const a = storeFor(home, alice, '@a:h', 'd-alice', convo);
  const b = storeFor(home, bob, '@b:h', 'd-bob', convo);
  await a.store.loadConversationNow('dm-1');
  await b.store.loadConversationNow('dm-1');
  expect(alice.joined('dm-1')).toBe(true);
  expect(bob.joined('dm-1')).toBe(true);
  return { home, alice, bob, convo, a, b };
}

describe('starting a conversation over', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  it('names the generation it replaces, and the conversation moves to the next', async () => {
    const { home, alice, bob, a, b } = await pair();
    expect(home.generations.get('dm-1')).toBe(1);

    const done = await a.store.resetConversation('dm-1');
    const beginning = a.sent.findLast((f) => f.start_over);
    expect(beginning).toMatchObject({ kind: 'welcome', start_over: true, generation: 1 });
    expect(done.generation).toBe(2);
    expect(done.superseded).toBeUndefined();
    expect(home.generations.get('dm-1')).toBe(2);

    await alice.send('dm-1', 'from the new group');
    await b.store.loadConversationNow('dm-1');
    expect(read(bob, home, 'dm-1')).toContain('from the new group');
    const last = frames(home, 'dm-1').at(-1);
    expect(last.generation).toBe(2);
  });

  it('makes one new group of two pressed at once, and the second keeps its group until it can take the first', async () => {
    const { home, alice, bob, convo } = await pair();
    const bobs = storeFor(home, bob, '@b:h', 'd-bob', convo);
    let once = true;
    const alices = storeFor(home, alice, '@a:h', 'd-alice', convo, {
      before: async (body) => {
        if (body.start_over && once) {
          once = false;
          await bobs.store.resetConversation('dm-1');
        }
      },
    });

    const done = await alices.store.resetConversation('dm-1');
    expect(done.superseded).toBe(true);
    expect(done.generation).toBe(2);
    expect(home.generations.get('dm-1')).toBe(2);
    const beginnings = frames(home, 'dm-1').filter((f) => f.kind === 'welcome' && f.generation === 2);
    expect(beginnings.map((f) => f.sender)).toEqual(['@b:h']);

    expect(alice.joined('dm-1')).toBe(true);
    await bob.send('dm-1', 'one group');
    await alice.sync('dm-1', frames(home, 'dm-1'));
    expect(read(alice, home, 'dm-1')).toContain('one group');
    await alice.send('dm-1', 'and it is this one');
    await bob.sync('dm-1', frames(home, 'dm-1'));
    expect(read(bob, home, 'dm-1')).toContain('and it is this one');
  });

  it('keeps the old group when the start-over is refused', async () => {
    const { home, alice, bob, a } = await pair();
    a.store.home.sendFrame = async () => {
      throw new HttpError(403, { message: 'no' });
    };
    await expect(a.store.resetConversation('dm-1')).rejects.toThrow();
    expect(alice.joined('dm-1')).toBe(true);
    await alice.send('dm-1', 'still here');
    await bob.sync('dm-1', frames(home, 'dm-1'));
    expect(read(bob, home, 'dm-1')).toContain('still here');
  });

  it('refuses a frame of the group it replaced, and the sender catches up', async () => {
    const { home, alice, bob, b } = await pair();
    await b.store.resetConversation('dm-1');

    const refused = await alice.send('dm-1', 'into the old group').then(() => null, (e) => e);
    expect(refused?.status).toBe(409);
    expect(refused?.body).toMatchObject({ code: 'generation_conflict', generation: 2 });
    expect(alice.pendingOutcome(refused, { frameId: 'x' })).toBe('lost');
    expect(frames(home, 'dm-1').some((f) => f.generation === 1 && f.sender === '@a:h'
      && f.kind === 'application' && f.seq > 3)).toBe(false);

    await alice.sync('dm-1', frames(home, 'dm-1'));
    await alice.send('dm-1', 'into the new one');
    await bob.sync('dm-1', frames(home, 'dm-1'));
    expect(read(bob, home, 'dm-1')).toContain('into the new one');
  });

  it('steps over a frame of an older generation instead of stopping on it', async () => {
    const { home, alice, bob, b } = await pair();
    await alice.send('dm-1', 'old');
    const old = frames(home, 'dm-1').at(-1);
    await b.store.resetConversation('dm-1');
    await alice.sync('dm-1', frames(home, 'dm-1'));
    const list = frames(home, 'dm-1');
    list.push({ ...old, id: 'late', seq: list.length + 1, generation: 1 });
    await bob.send('dm-1', 'new');
    await alice.sync('dm-1', frames(home, 'dm-1'));
    expect(alice.failed.has('dm-1')).toBe(false);
    expect(alice.textOf(frames(home, 'dm-1').at(-1).id)).toBe('new');
  });

  it('drops a founding another member beat it to, and takes the one ordered', async () => {
    const home = new FakeHome();
    const alice = await engine(home, '@a:h', 'd-alice');
    const bob = await engine(home, '@b:h', 'd-bob');
    const convo = row(home, 'dm-1', '@a:h', ['@a:h', '@b:h']);
    const a = storeFor(home, alice, '@a:h', 'd-alice', convo, {
      before: async (body) => {
        if (!body.start_over || home.generations.get('dm-1')) return;
        const theirs = await bob.establish('dm-1', ['@a:h']);
        await home.for('@b:h', 'd-bob').sendFrame('dm-1', {
          kind: 'welcome', ciphertext: theirs.welcome, epoch: theirs.epoch,
          start_over: true, generation: 0,
        });
      },
    });

    await a.store.mendConversation('dm-1', convo(), []);
    expect(a.sent.at(-1)).toMatchObject({ start_over: true, generation: 0 });
    expect(frames(home, 'dm-1').filter((f) => f.kind === 'welcome').map((f) => f.sender)).toEqual(['@b:h']);
    expect(alice.joined('dm-1')).toBe(false);

    await alice.sync('dm-1', frames(home, 'dm-1'));
    expect(alice.joined('dm-1')).toBe(true);
    await bob.send('dm-1', 'one group');
    await alice.sync('dm-1', frames(home, 'dm-1'));
    expect(read(alice, home, 'dm-1')).toContain('one group');
  });
});
