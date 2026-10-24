import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { freshStore } from './fake-server.js';
import { FakeHome, device } from './mls-home.js';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';

const frame = (seq, extra = {}) => ({
  id: `f${seq}`,
  conversation_id: 'dm1',
  seq,
  epoch: 1,
  kind: 'application',
  sender: CAROL,
  sender_device: 'd-carol',
  ciphertext: 'x',
  created_at: seq,
  ...extra,
});

const ids = (frames) => (frames || []).map((f) => f.id);

function fakeHome(frames) {
  const asked = [];
  return {
    asked,
    conversation: async () => ({ id: 'dm1', kind: 'dm' }),
    dmHistory: async (id, { after = 0, limit = 100, tail = 0 } = {}) => {
      asked.push({ after, limit, tail });
      const above = frames.filter((f) => f.seq > after);
      return { messages: tail ? above.slice(-tail) : above.slice(0, limit) };
    },
  };
}

function fakeEngine() {
  const walked = [];
  return {
    walked,
    sync: async (conversationId, frames, options = {}) => {
      walked.push({ ids: ids(frames), ...options });
      return [];
    },
    payloadTypeOf: () => 'message',
    isSignal: () => false,
    isMine: () => false,
    textOf: () => 'hello',
    takeRejoins: () => [],
    flushSignals: async () => null,
    joined: () => true,
  };
}

function longStore(count = 250) {
  const frames = Array.from({ length: count }, (_, i) => frame(i + 1));
  const store = freshStore();
  store.me = { user_id: ME };
  store.conversations = [{ id: 'dm1', kind: 'dm', unread: false, members: [ME, CAROL] }];
  store.refreshConversations = async () => {};
  store.mls = fakeEngine();
  store.home = fakeHome(frames);
  return { store, frames };
}

describe('the window a long conversation opens on', () => {
  it('is the end of the conversation, not the beginning', async () => {
    const { store } = longStore(250);

    await store.openConversation('dm1');

    const shown = ids(store.dmFrames.get('dm1'));
    expect(shown).toHaveLength(100);
    expect(shown[0]).toBe('f151');
    expect(shown[99]).toBe('f250');
  });

  it('is what a read watermark is taken from', async () => {
    const { store } = longStore(250);

    await store.openConversation('dm1');

    expect(store.lastReadable('dm1')).toBe('f250');
  });

  it('is the whole of a conversation that fits in it', async () => {
    const { store } = longStore(12);

    await store.openConversation('dm1');

    expect(ids(store.dmFrames.get('dm1'))).toHaveLength(12);
    expect(ids(store.dmFrames.get('dm1'))[0]).toBe('f1');
  });

  it('is offered to the walk as a window and not as the conversation', async () => {
    const { store } = longStore(250);

    await store.openConversation('dm1');

    expect(store.mls.walked[0].backfill).toBe(true);
    expect(store.mls.walked[0].ids[0]).toBe('f151');
  });

  it('takes in a frame that arrived while it was being fetched', async () => {
    const { store } = longStore(250);

    store.onDmFrame(frame(251), true);
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    await store.openConversation('dm1');

    const shown = ids(store.dmFrames.get('dm1'));
    expect(shown[shown.length - 1]).toBe('f251');
    expect(shown[0]).toBe('f151');
  });
});

describe('starting a conversation over', () => {
  it('starts the new group above the newest frame, not the hundredth', async () => {
    const { store } = longStore(250);
    let startedFrom = null;
    store.mls = {
      ...fakeEngine(),
      forget: async () => {},
      install: async () => {},
      establish: async (id, members, { from } = {}) => {
        startedFrom = from;
        return { welcome: 'welcome-blob', epoch: 1, missing: [], rejected: [] };
      },
    };
    store.home.sendFrame = async () => ({});

    await store.resetConversation('dm1');

    expect(startedFrom).toBe(250);
  });
});

const HOME = 'home.example';
const ALICE = '@alice:home.example';
const BOB = '@bob:home.example';

let space = 0;
function server() {
  const home = new FakeHome();
  space += 1;
  home.seq = space * 1000;
  return home;
}

function storeFor(home, mls, conversationId) {
  const store = freshStore();
  store.me = { user_id: BOB };
  store.conversations = [{ id: conversationId, kind: 'dm', members: [ALICE, BOB] }];
  store.refreshConversations = async () => {};
  store.home = home.for(BOB, `d-bob-${conversationId}`);
  store.mls = mls;
  store.navigate({ view: 'dms', conversationId });
  return store;
}

async function conversation(home, conversationId, { kept = 0 } = {}) {
  const alice = await device(home, ALICE, `d-alice-${conversationId}`);
  const bob = await device(home, BOB, `d-bob-${conversationId}`);
  const built = await alice.establish(conversationId, [BOB]);
  await home.for(ALICE, `d-alice-${conversationId}`).sendFrame(conversationId, {
    kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
  });
  await bob.sync(conversationId, home.frames.get(conversationId));
  for (let i = 0; i < kept; i += 1) await alice.send(conversationId, `kept ${i}`);
  if (kept) await bob.sync(conversationId, home.frames.get(conversationId));
  return { alice, bob };
}

async function unheard(home, alice, conversationId, { said = 0, joining }) {
  await device(home, joining, `d-joining-${conversationId}`);
  for (let i = 0; i < Math.floor(said / 2); i += 1) {
    await alice.send(conversationId, `unheard ${i}`);
  }
  await alice.addMembers(conversationId, [joining]);
  for (let i = 0; i < Math.ceil(said / 2); i += 1) {
    await alice.send(conversationId, `unheard late ${i}`);
  }
}

describe('a device that has fallen behind the window', () => {
  it('reads the newest messages once it opens the conversation', async () => {
    const home = server();
    const { alice, bob } = await conversation(home, 'conv-far');
    await unheard(home, alice, 'conv-far', { said: 240, joining: '@dave:home.example' });
    const newest = await alice.send('conv-far', 'the newest thing said');
    expect(newest.seq - bob.walkedTo('conv-far')).toBeGreaterThan(200);
    expect(bob.textOf(newest.id)).toBeUndefined();

    const store = storeFor(home, bob, 'conv-far');
    await store.openConversation('conv-far');

    expect(bob.textOf(newest.id)).toBe('the newest thing said');
    expect(store.dmFrames.get('conv-far')).toHaveLength(100);
  });

  it('re-reads the conversation on screen when a dropped socket comes back', async () => {
    const home = server();
    const { alice, bob } = await conversation(home, 'conv-drop', { kept: 2 });
    const store = storeFor(home, bob, 'conv-drop');
    await store.openConversation('conv-drop');

    await unheard(home, alice, 'conv-drop', { said: 2, joining: '@dave:home.example' });

    const after = await alice.send('conv-drop', 'said after the socket came back');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(bob.textOf(after.id)).toBeUndefined();

    const reread = new Promise((resolve) => {
      const off = store.on('dm', (e) => {
        if (e?.conversation_id === 'conv-drop') { off(); resolve(); }
      });
    });
    store.onReady({ domain: HOME, data: { d: {} } });
    await Promise.race([reread, new Promise((resolve) => { setTimeout(resolve, 2000); })]);

    expect(bob.textOf(after.id)).toBe('said after the socket came back');
  });

  it('re-reads nothing when the reader is somewhere else', async () => {
    const home = server();
    const { bob } = await conversation(home, 'conv-away', { kept: 1 });
    const store = storeFor(home, bob, 'conv-away');
    await store.openConversation('conv-away');

    let reads = 0;
    const real = store.home.dmHistory;
    store.home.dmHistory = (...args) => { reads += 1; return real(...args); };

    store.onReady({ domain: 'guilds.example', data: { d: {} } });
    store.navigate({ view: 'chat', channelId: 'c1' });
    store.onReady({ domain: HOME, data: { d: {} } });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(reads).toBe(0);
  });
});
