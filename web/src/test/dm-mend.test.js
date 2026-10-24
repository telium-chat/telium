import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { HttpError } from '../lib/api.js';
import { Mls, wipe } from '../lib/mls.js';
import { dmMethods } from '../lib/store/dms.js';
import { FakeHome } from './mls-home.js';

function api(home, userId, deviceId, extra = {}) {
  const base = home.for(userId, deviceId);
  return {
    ...base,
    async sendFrame(conversationId, body) {
      try {
        return await base.sendFrame(conversationId, body);
      } catch (e) {
        if (e.status) throw new HttpError(e.status, { message: e.message });
        throw e;
      }
    },
    ...extra,
  };
}

async function engine(home, userId, deviceId, recoveryKey = null) {
  const mls = new Mls(api(home, userId, deviceId), { userId, deviceId, recoveryKey });
  await mls.start();
  return mls;
}

function storeFor(home, mls, userId, deviceId, conversation) {
  const store = Object.assign(Object.create(dmMethods), {
    home: api(home, userId, deviceId, {
      conversation: async (id) => conversation(id),
      createConversation: async () => conversation(),
    }),
    mls,
    me: { user_id: userId },
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
    refreshConversations: async () => {},
  });
  return store;
}

function row(home, id, creator, members) {
  return () => ({
    id,
    kind: 'dm',
    creator,
    epoch: home.epochs.get(id) || 0,
    last_seq: (home.frames.get(id) || []).length ? home.seq : 0,
    members: members.map((u) => ({ user_id: u, state: 'joined' })),
  });
}

const read = (mls, home, id) => (home.frames.get(id) || [])
  .filter((f) => f.kind === 'application')
  .map((f) => mls.textOf(f.id));

describe('a conversation nobody holds keys for', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  it('builds the group even when the list already names the new conversation', async () => {
    const home = new FakeHome();
    const alice = await engine(home, '@a:h', 'd-alice');
    const bob = await engine(home, '@b:h', 'd-bob');
    const convo = row(home, 'dm-1', '@a:h', ['@a:h', '@b:h']);
    const store = storeFor(home, alice, '@a:h', 'd-alice', convo);
    store.conversations = [convo()];

    await store.mintConversation(['@b:h'], 'dm', null);

    expect(alice.joined('dm-1')).toBe(true);
    expect((home.frames.get('dm-1') || []).some((f) => f.kind === 'welcome')).toBe(true);
    await alice.send('dm-1', 'hello');
    await bob.sync('dm-1', home.frames.get('dm-1'));
    expect(read(bob, home, 'dm-1')).toEqual(['hello']);
  });

  it('does not build over a group the other person already founded', async () => {
    const home = new FakeHome();
    const alice = await engine(home, '@a:h', 'd-alice');
    await engine(home, '@b:h', 'd-bob');
    const convo = row(home, 'dm-1', '@b:h', ['@a:h', '@b:h']);
    const store = storeFor(home, alice, '@a:h', 'd-alice', convo);

    await store.mintConversation(['@b:h'], 'dm', null);

    expect(alice.joined('dm-1')).toBe(false);
    expect(home.frames.get('dm-1') || []).toEqual([]);
  });

  it('lets the creator build a group nobody ever built, on open', async () => {
    const home = new FakeHome();
    const alice = await engine(home, '@a:h', 'd-alice');
    const bob = await engine(home, '@b:h', 'd-bob');
    const convo = row(home, 'dm-1', '@a:h', ['@a:h', '@b:h']);
    const bobStore = storeFor(home, bob, '@b:h', 'd-bob', convo);
    const aliceStore = storeFor(home, alice, '@a:h', 'd-alice', convo);

    await bobStore.loadConversationNow('dm-1');
    expect(bob.joined('dm-1')).toBe(false);

    await aliceStore.loadConversationNow('dm-1');
    expect(alice.joined('dm-1')).toBe(true);

    await bobStore.loadConversationNow('dm-1');
    expect(bob.joined('dm-1')).toBe(true);
    await alice.send('dm-1', 'there you are');
    await bob.sync('dm-1', home.frames.get('dm-1'));
    expect(read(bob, home, 'dm-1')).toEqual(['there you are']);
  });

  it('adds the other person when the group was built before they had a key', async () => {
    const home = new FakeHome();
    const alice = await engine(home, '@a:h', 'd-alice');
    const convo = row(home, 'dm-1', '@a:h', ['@a:h', '@b:h']);
    const aliceStore = storeFor(home, alice, '@a:h', 'd-alice', convo);
    await aliceStore.mintConversation(['@b:h'], 'dm', null);
    expect(alice.joined('dm-1')).toBe(true);
    expect((home.frames.get('dm-1') || []).some((f) => f.kind === 'welcome')).toBe(false);

    const bob = await engine(home, '@b:h', 'd-bob');
    const bobStore = storeFor(home, bob, '@b:h', 'd-bob', convo);
    await bobStore.loadConversationNow('dm-1');
    expect(bob.joined('dm-1')).toBe(false);

    await aliceStore.loadConversationNow('dm-1');
    await bobStore.loadConversationNow('dm-1');
    expect(bob.joined('dm-1')).toBe(true);

    await alice.send('dm-1', 'hi bob');
    await bob.send('dm-1', 'hi alice');
    await alice.sync('dm-1', home.frames.get('dm-1'));
    await bob.sync('dm-1', home.frames.get('dm-1'));
    expect(read(bob, home, 'dm-1')).toEqual(['hi bob', 'hi alice']);
    expect(read(alice, home, 'dm-1')).toEqual(['hi bob', 'hi alice']);
  });
});

describe('a commit that loses the race for an epoch', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  it('is built again on the newest epoch instead of reported', async () => {
    const home = new FakeHome();
    const alice = await engine(home, '@a:h', 'd-alice');
    const bob = await engine(home, '@b:h', 'd-bob');
    const carol = await engine(home, '@c:h', 'd-carol');
    await engine(home, '@d:h', 'd-dave');
    const built = await alice.establish('gc-1', ['@b:h']);
    await api(home, '@a:h', 'd-alice').sendFrame('gc-1', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('gc-1', home.frames.get('gc-1'));
    await bob.addMembers('gc-1', ['@d:h']);

    const store = storeFor(home, alice, '@a:h', 'd-alice', () => ({ id: 'gc-1', kind: 'gc' }));
    const done = await store.rebased('gc-1', () => alice.addMembers('gc-1', ['@c:h']));
    expect(done.added).toBe(1);

    await carol.sync('gc-1', home.frames.get('gc-1'));
    await alice.send('gc-1', 'welcome carol');
    await carol.sync('gc-1', home.frames.get('gc-1'));
    expect(read(carol, home, 'gc-1')).toContain('welcome carol');
  });
});

describe('two tabs letting one device in', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    const tails = new Map();
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: {
        async request(name, fn) {
          const before = tails.get(name) || Promise.resolve();
          let release;
          tails.set(name, before.then(() => new Promise((r) => { release = r; })));
          await before;
          try { return await fn({ name }); } finally { release(); }
        },
      },
    });
    localStorage.clear();
    await wipe();
  });

  it('joins once, and neither tab asks to be let in', async () => {
    const home = new FakeHome();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const alice = await engine(home, '@a:h', 'd-alice', key);
    await engine(home, '@b:h', 'd-bob');
    const built = await alice.establish('dm-1', ['@a:h', '@b:h']);
    await api(home, '@a:h', 'd-alice').sendFrame('dm-1', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    globalThis.indexedDB = new IDBFactory();
    await wipe();
    const tabA = await engine(home, '@a:h', 'd-laptop', key);
    const tabB = await engine(home, '@a:h', 'd-laptop', key);
    const convo = row(home, 'dm-1', '@a:h', ['@a:h', '@b:h']);
    const one = storeFor(home, tabA, '@a:h', 'd-laptop', convo);
    const two = storeFor(home, tabB, '@a:h', 'd-laptop', convo);

    const answers = await Promise.all([one.rejoinConversation('dm-1'), two.rejoinConversation('dm-1')]);

    expect(answers).toEqual([true, true]);
    const frames = home.frames.get('dm-1');
    expect(frames.filter((f) => f.kind === 'rejoin')).toEqual([]);
    expect(frames.filter((f) => f.kind === 'commit' && f.sender_device === 'd-laptop')).toHaveLength(1);
  });
});

describe('a way in the conversation has moved past', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  async function movedPast(home, key) {
    const alice = await engine(home, '@a:h', 'd-alice', key);
    const bob = await engine(home, '@b:h', 'd-bob');
    await engine(home, '@d:h', 'd-dave');
    const built = await alice.establish('gc-1', ['@a:h', '@b:h']);
    await api(home, '@a:h', 'd-alice').sendFrame('gc-1', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('gc-1', home.frames.get('gc-1'));
    const frozen = [...home.frames.get('gc-1')];
    await bob.addMembers('gc-1', ['@d:h']);
    globalThis.indexedDB = new IDBFactory();
    await wipe();
    return { bob, frozen };
  }

  it('is refused once, then asked for instead of rebuilt on the same epoch', async () => {
    const home = new FakeHome();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const { frozen } = await movedPast(home, key);
    const laptop = await engine(home, '@a:h', 'd-laptop', key);

    await expect(laptop.selfJoin('gc-1', frozen)).rejects.toMatchObject({ status: 409 });
    expect(await laptop.selfJoin('gc-1', frozen)).toBe(false);
    expect(await laptop.selfJoin('gc-1', home.frames.get('gc-1'))).toBe(false);
    expect(home.frames.get('gc-1').filter((f) => f.sender_device === 'd-laptop')).toEqual([]);
  });

  it('asks to be let in, gets in, and reads what comes next', async () => {
    const home = new FakeHome();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const { bob } = await movedPast(home, key);
    const laptop = await engine(home, '@a:h', 'd-laptop', key);
    let commits = 0;
    const base = api(home, '@a:h', 'd-laptop');
    const store = storeFor(home, laptop, '@a:h', 'd-laptop', row(home, 'gc-1', '@a:h', ['@a:h', '@b:h', '@d:h']));
    store.home = {
      ...store.home,
      async sendFrame(id, body) {
        if (body.kind === 'commit') commits += 1;
        return base.sendFrame(id, body);
      },
    };
    laptop.home = store.home;

    expect(await store.rejoinConversation('gc-1')).toBe(false);
    expect(await store.rejoinConversation('gc-1')).toBe(false);
    expect(commits).toBe(0);
    expect(store.rejoinBlocked.has('gc-1')).toBe(false);
    expect(home.frames.get('gc-1').filter((f) => f.kind === 'rejoin' && f.sender_device === 'd-laptop'))
      .toHaveLength(2);

    const answered = await bob.catchUp('gc-1', [{ userId: '@a:h', deviceId: 'd-laptop' }]);
    expect(answered.added).toBe(1);
    await laptop.sync('gc-1', home.frames.get('gc-1'));
    expect(laptop.joined('gc-1')).toBe(true);
    expect(laptop.epochOf('gc-1')).toBe(bob.epochOf('gc-1'));
    await bob.send('gc-1', 'you are back');
    await laptop.sync('gc-1', home.frames.get('gc-1'));
    expect(read(laptop, home, 'gc-1')).toContain('you are back');
  });

  it('falls back to asking when every retry of the join is refused', async () => {
    const home = new FakeHome();
    const key = crypto.getRandomValues(new Uint8Array(32));
    await movedPast(home, key);
    const laptop = await engine(home, '@a:h', 'd-laptop', key);
    const store = storeFor(home, laptop, '@a:h', 'd-laptop', row(home, 'gc-1', '@a:h', ['@a:h', '@b:h']));
    laptop.selfJoin = async () => { throw new HttpError(409, { message: 'this commit was built on an epoch that has already been replaced' }); };

    expect(await store.rejoinConversation('gc-1')).toBe(false);
    expect(home.frames.get('gc-1').filter((f) => f.kind === 'rejoin')).toHaveLength(1);
  });

  it('stops rebuilding a commit when catching up does not move the epoch', async () => {
    const home = new FakeHome();
    const alice = await engine(home, '@a:h', 'd-alice');
    const bob = await engine(home, '@b:h', 'd-bob');
    await engine(home, '@c:h', 'd-carol');
    await engine(home, '@d:h', 'd-dave');
    const built = await alice.establish('gc-1', ['@b:h']);
    await api(home, '@a:h', 'd-alice').sendFrame('gc-1', {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    await bob.sync('gc-1', home.frames.get('gc-1'));
    await bob.addMembers('gc-1', ['@d:h']);

    const store = storeFor(home, alice, '@a:h', 'd-alice', () => ({ id: 'gc-1', kind: 'gc' }));
    alice.sync = async () => [];
    let tries = 0;
    await expect(store.rebased('gc-1', () => { tries += 1; return alice.addMembers('gc-1', ['@c:h']); }))
      .rejects.toThrow(/could not catch up/);
    expect(tries).toBe(1);
  });
});
