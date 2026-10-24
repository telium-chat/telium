import { describe, expect, it } from 'vitest';
import { freshStore } from './fake-server.js';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';

function fakeEngine(opened = {}) {
  const walked = [];
  const text = new Map();
  return {
    walked,
    sync: async (conversationId, frames) => {
      walked.push(frames.map((f) => f.id));
      for (const frame of frames) {
        if (opened[frame.id] === 'message') text.set(frame.id, 'hello');
      }
      return [];
    },
    payloadTypeOf: (frameId) => opened[frameId],
    isSignal: (frameId) => opened[frameId] !== undefined && opened[frameId] !== 'message',
    isMine: () => false,
    textOf: (frameId) => text.get(frameId),
    takeRejoins: () => [],
    flushSignals: async () => null,
    joined: () => true,
  };
}

const frame = (id, seq, extra = {}) => ({
  id,
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

function quietStore({ history = [], mls = fakeEngine() } = {}) {
  const store = freshStore();
  store.me = { user_id: ME };
  store.conversations = [{ id: 'dm1', kind: 'dm', unread: false }];
  store.refreshConversations = async () => {};
  store.mls = mls;
  store.home = {
    conversation: async () => ({ id: 'dm1', kind: 'dm' }),
    dmHistory: async () => ({ messages: history.slice() }),
  };
  return store;
}

async function settle() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

describe('a frame for a conversation this session has not loaded', () => {
  it('reaches the timeline for a conversation that did not exist a second ago', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message' }) });

    store.onDmFrame(frame('f1', 7), true);
    await settle();

    await store.openConversation('dm1');
    expect(ids(store.dmFrames.get('dm1'))).toEqual(['f1']);
    expect(store.mls.textOf('f1')).toBe('hello');
  });

  it('reaches the timeline for a conversation that is merely unopened', async () => {
    const store = quietStore({
      history: [frame('old', 1)],
      mls: fakeEngine({ f1: 'message' }),
    });

    store.onDmFrame(frame('f1', 7), true);
    await settle();

    await store.openConversation('dm1');
    expect(ids(store.dmFrames.get('dm1'))).toEqual(['old', 'f1']);
  });

  it('does not let the buffer pass for loaded history', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message' }) });

    store.onDmFrame(frame('f1', 7), true);
    await settle();

    expect(store.dmFrames.has('dm1')).toBe(false);
    expect(ids(store.dmPending.get('dm1'))).toEqual(['f1']);
  });

  it('interleaves the buffer into the page instead of appending it', async () => {
    const store = quietStore({
      history: [frame('a', 5), frame('b', 6), frame('d', 8)],
      mls: fakeEngine({ c: 'message' }),
    });

    store.onDmFrame(frame('c', 7), true);
    await settle();

    await store.openConversation('dm1');
    expect(ids(store.dmFrames.get('dm1'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not show the frame twice when the fetch already has it', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message' }) });

    store.onDmFrame(frame('f1', 7), true);
    await settle();

    store.home.dmHistory = async () => ({ messages: [frame('f0', 6), frame('f1', 7)] });
    await store.openConversation('dm1');

    expect(ids(store.dmFrames.get('dm1'))).toEqual(['f0', 'f1']);
  });

  it('keeps every frame that arrives before the drain', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message', f2: 'message' }) });

    store.onDmFrame(frame('f1', 7), true);
    await settle();
    store.onDmFrame(frame('f2', 8), true);
    await settle();

    await store.openConversation('dm1');
    expect(ids(store.dmFrames.get('dm1'))).toEqual(['f1', 'f2']);
  });

  it('keeps a frame that arrives while the fetch is in flight', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const store = quietStore({ mls: fakeEngine({ f1: 'message' }) });

    store.home.dmHistory = async () => {
      await gate;
      return { messages: [frame('f0', 6)] };
    };

    const opening = store.openConversation('dm1');
    await settle();
    store.onDmFrame(frame('f1', 7), true);
    await settle();
    release();
    await opening;

    expect(ids(store.dmFrames.get('dm1'))).toEqual(['f0', 'f1']);
  });

  it('stops buffering rather than growing, and still shows the history on open', async () => {
    const page = [];
    for (let i = 0; i < 260; i += 1) page.push(frame(`f${i}`, i + 1));
    const store = quietStore({ history: page, mls: fakeEngine() });

    for (const f of page) { store.onDmFrame(f, true); }
    await settle();

    expect(store.dmPending.has('dm1')).toBe(false);
    expect(store.dmPendingFull.has('dm1')).toBe(true);

    await store.openConversation('dm1');
    expect(ids(store.dmFrames.get('dm1'))).toEqual(page.map((f) => f.id));
    expect(store.dmPendingFull.has('dm1')).toBe(false);
  });

  it('bounds how many unopened conversations are buffered at once', async () => {
    const store = quietStore({ mls: fakeEngine() });
    for (let i = 0; i < 40; i += 1) {
      store.onDmFrame(frame(`f${i}`, 1, { conversation_id: `c${i}` }), true);
    }
    await settle();
    expect(store.dmPending.size).toBeLessThanOrEqual(32);
  });
});

describe('what the engine is asked, and when', () => {
  it('applies group state on arrival rather than at the drain', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message' }) });

    store.onDmFrame(frame('w1', 6, { kind: 'welcome' }), false);
    await settle();
    expect(store.mls.walked).toEqual([['w1']]);

    store.onDmFrame(frame('f1', 7), true);
    await settle();
    expect(store.mls.walked).toEqual([['w1'], ['w1', 'f1']]);
  });

  it('still answers a rejoin without walking it', async () => {
    const store = quietStore({ mls: fakeEngine() });
    const asked = [];
    store.admitSigned = async (id, rows) => { asked.push([id, rows]); };

    store.onDmFrame(frame('r1', 7, { kind: 'rejoin' }), false);
    await settle();

    expect(asked).toEqual([['dm1', [{ userId: CAROL, deviceId: 'd-carol' }]]]);
    expect(store.mls.walked).toEqual([]);
    expect(ids(store.dmPending.get('dm1'))).toEqual(['r1']);
  });
});

describe('the badge, which was already right', () => {
  it('counts an unopened message once', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message' }) });
    const heard = [];
    store.on('dm-notify', (f) => heard.push(f.id));

    store.onDmFrame(frame('f1', 7), true);
    await settle();

    expect(heard).toEqual(['f1']);
    expect(store.dmUnreadFor('dm1')).toBe(1);
  });

  it('stays silent for a read receipt', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'receipt' }) });
    const heard = [];
    store.on('dm-notify', (f) => heard.push(f.id));

    store.onDmFrame(frame('f1', 7), true);
    await settle();

    expect(heard).toEqual([]);
    expect(store.dmUnreadFor('dm1')).toBe(0);
  });

  it('clears the count when the conversation is opened', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message' }) });
    store.onDmFrame(frame('f1', 7), true);
    await settle();
    expect(store.dmUnreadFor('dm1')).toBe(1);

    await store.openConversation('dm1');
    expect(store.dmUnreadFor('dm1')).toBe(0);
  });
});

describe('what the badge adds up', () => {
  it('counts a conversation that has a row', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message' }) });

    store.onDmFrame(frame('f1', 7), true);
    await settle();

    expect(store.dmUnreadTotal()).toBe(1);
  });

  it('does not count a conversation there is no row for', async () => {
    const store = quietStore({ mls: fakeEngine({ f2: 'message' }) });

    store.onDmFrame({ ...frame('f2', 7), conversation_id: 'dm-unknown' }, true);
    await settle();

    expect(store.dmUnreadFor('dm-unknown')).toBe(1);
    expect(store.dmUnreadTotal()).toBe(0);
  });

  it('stops counting a conversation the server has stopped listing', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message' }) });
    store.onDmFrame(frame('f1', 7), true);
    await settle();
    expect(store.dmUnreadTotal()).toBe(1);

    store.conversations = [];

    expect(store.dmUnreadTotal()).toBe(0);
  });

  it('adds up every conversation that does have one', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message', f2: 'message' }) });
    store.conversations = [
      { id: 'dm1', kind: 'dm', unread: false },
      { id: 'dm2', kind: 'dm', unread: false },
    ];

    store.onDmFrame(frame('f1', 7), true);
    store.onDmFrame({ ...frame('f2', 8), conversation_id: 'dm2' }, true);
    await settle();

    expect(store.dmUnreadTotal()).toBe(2);
  });
});

describe('conversation order', () => {
  it('moves a conversation up for a message but not for a receipt or an unopened own frame', async () => {
    const store = quietStore({ mls: fakeEngine({ f1: 'message', f2: 'receipt' }) });
    const convo = store.conversations[0];

    store.noteActivity(frame('f2', 2, { created_at: 50 }));
    expect(convo.last_activity_at).toBeUndefined();

    store.noteActivity(frame('f3', 3, { created_at: 60, sender: ME }));
    expect(convo.last_activity_at).toBeUndefined();

    store.noteActivity(frame('f1', 1, { created_at: 40 }));
    expect(convo.last_activity_at).toBe(40);
  });
});
