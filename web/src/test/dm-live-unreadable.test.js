import { describe, expect, it } from 'vitest';
import { freshStore } from './fake-server.js';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';

function partialEngine(openedIds = [], walkedToSeq = 0) {
  const walked = [];
  const text = new Map();
  for (const id of openedIds) text.set(id, 'hello');
  return {
    walked,
    sync: async (conversationId, frames) => {
      walked.push(frames.map((f) => f.id));
      for (const frame of frames) {
        if (openedIds.includes(frame.id)) text.set(frame.id, 'hello');
      }
      return [];
    },
    payloadTypeOf: (frameId) => (text.has(frameId) ? 'message' : undefined),
    isSignal: () => false,
    isMine: () => false,
    isDeleted: () => false,
    currentText: (_conversationId, frameId) => text.get(frameId),
    textOf: (frameId) => text.get(frameId),
    replyOf: () => null,
    attachmentsOf: () => [],
    reactionsTo: () => [],
    pinsIn: () => [],
    walkedTo: () => walkedToSeq,
    takeRejoins: () => [],
    flushSignals: async () => null,
    joined: () => true,
    epochOf: () => 1,
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

function retryStore({ mls, history = [] } = {}) {
  const store = freshStore();
  store.me = { user_id: ME };
  store.conversations = [{ id: 'dm1', kind: 'dm', unread: false }];
  store.refreshConversations = async () => {};
  store.mls = mls;
  store.home = {
    conversation: async () => ({ id: 'dm1', kind: 'dm' }),
    dmHistory: async () => ({ messages: history.slice() }),
  };
  store.dmFrames.set('dm1', []);
  store.dmOpened.set('dm1', { id: 'dm1', kind: 'dm' });
  return store;
}

async function settle() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

describe('a live frame that the first sync could not decrypt', () => {
  it('retries by re-fetching history when the first sync leaves it undecrypted', async () => {
    const mls = partialEngine([], 3);
    const store = retryStore({
      mls,
      history: [frame('new', 5)],
    });

    let historyCalls = 0;
    const origHistory = store.home.dmHistory;
    store.home.dmHistory = async (...args) => {
      historyCalls += 1;
      return origHistory(...args);
    };

    store.onDmFrame(frame('new', 5), true);
    await settle();

    expect(historyCalls).toBeGreaterThanOrEqual(1);
    expect(mls.walked.length).toBeGreaterThanOrEqual(2);
  });

  it('does not retry more than once per conversation', async () => {
    const mls = partialEngine([], 3);
    const store = retryStore({
      mls,
      history: [frame('stuck', 5)],
    });

    let historyCalls = 0;
    const origHistory = store.home.dmHistory;
    store.home.dmHistory = async (...args) => {
      historyCalls += 1;
      return origHistory(...args);
    };

    store.onDmFrame(frame('stuck', 5), true);
    await settle();

    expect(historyCalls).toBe(1);
  });

  it('does not retry for signal frames', async () => {
    const mls = partialEngine([], 3);
    mls.isSignal = (id) => id === 'sig';
    const store = retryStore({
      mls,
      history: [frame('sig', 5)],
    });

    let historyCalls = 0;
    store.home.dmHistory = async () => {
      historyCalls += 1;
      return { messages: [frame('sig', 5)] };
    };

    store.onDmFrame(frame('sig', 5), true);
    await settle();

    expect(historyCalls).toBe(0);
  });

  it('does not retry for non-application frames', async () => {
    const mls = partialEngine([], 3);
    const store = retryStore({
      mls,
      history: [],
    });

    let historyCalls = 0;
    store.home.dmHistory = async () => {
      historyCalls += 1;
      return { messages: [] };
    };

    store.onDmFrame(frame('c1', 5, { kind: 'commit' }), false);
    await settle();

    expect(historyCalls).toBe(0);
  });

  it('does not retry when the first sync already decrypted the frame', async () => {
    const mls = partialEngine(['new'], 3);
    const store = retryStore({
      mls,
      history: [frame('new', 5)],
    });

    let historyCalls = 0;
    store.home.dmHistory = async () => {
      historyCalls += 1;
      return { messages: [frame('new', 5)] };
    };

    store.onDmFrame(frame('new', 5), true);
    await settle();

    expect(historyCalls).toBe(0);
  });
});

describe('a walk that stopped on a frame it could not process', () => {
  it('does not throw the group state away', async () => {
    let forgot = false;
    const mls = partialEngine([], 3);
    mls.errorFor = () => new Error('epoch 7 does not follow epoch 4');
    mls.forget = async () => { forgot = true; };

    const store = retryStore({ mls, history: [frame('msg', 5)] });
    await store.openConversation('dm1');

    expect(forgot).toBe(false);
    expect(mls.joined('dm1')).toBe(true);
  });

  it('leaves the reason where the banner can say it', async () => {
    const mls = partialEngine([], 3);
    mls.errorFor = () => new Error('epoch 7 does not follow epoch 4');
    mls.forget = async () => { throw new Error('must not be called'); };

    const store = retryStore({ mls, history: [frame('msg', 5)] });
    await store.openConversation('dm1');

    expect(store.mls.errorFor('dm1').message).toBe('epoch 7 does not follow epoch 4');
  });

  it('re-reads the tail on retry without disturbing the window', async () => {
    const mls = partialEngine([], 3);
    mls.errorFor = () => new Error('epoch 7 does not follow epoch 4');
    mls.forget = async () => { throw new Error('must not be called'); };

    const oldest = [frame('o1', 1, { kind: 'welcome' }), frame('o2', 2)];
    const newest = [frame('n8', 8), frame('n9', 9), frame('n10', 10)];
    const asked = [];
    const store = retryStore({ mls, history: [] });
    store.home.dmHistory = async (_id, opts = {}) => {
      asked.push(opts);
      return { messages: (opts.tail ? newest : oldest).slice() };
    };

    await store.openConversation('dm1');

    expect(asked.some((a) => a.tail)).toBe(true);
    expect(store.dmFrames.get('dm1').map((f) => f.id)).toEqual(['n8', 'n9', 'n10']);
  });

  it('redraws in onDmFrame when sync throws, without repairing destructively', async () => {
    let forgot = false;
    const mls = partialEngine([], 3);
    mls.sync = async () => { throw new Error('epoch 7 does not follow epoch 4'); };
    mls.forget = async () => { forgot = true; };

    const store = retryStore({ mls, history: [] });
    const drawn = [];
    store.on('dm', (e) => drawn.push(e?.conversation_id));

    store.onDmFrame(frame('bad', 5), true);
    await settle();

    expect(forgot).toBe(false);
    expect(drawn).toContain('dm1');
  });

  it('keeps whatever was already readable', async () => {
    const mls = partialEngine(['old1', 'old2'], 3);
    mls.errorFor = () => new Error('epoch 7 does not follow epoch 4');
    mls.forget = async () => { throw new Error('must not be called'); };

    const store = retryStore({
      mls,
      history: [frame('old1', 2), frame('old2', 3), frame('new', 5)],
    });

    expect(mls.currentText('dm1', 'old1')).toBe('hello');
    await store.openConversation('dm1');
    expect(mls.currentText('dm1', 'old1')).toBe('hello');
    expect(mls.currentText('dm1', 'old2')).toBe('hello');
  });
});
