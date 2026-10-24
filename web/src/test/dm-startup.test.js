import { describe, expect, it } from 'vitest';
import { freshStore } from './fake-server.js';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';

function recordingEngine() {
  const walked = [];
  const text = new Map();
  return {
    walked,
    text,
    sync: async (conversationId, frames) => {
      walked.push({ conversationId, ids: frames.map((f) => f.id) });
      for (const frame of frames) text.set(frame.id, 'hello');
      return frames.map((f) => f.id);
    },
    payloadTypeOf: (frameId) => (text.has(frameId) ? 'message' : undefined),
    isSignal: () => false,
    isMine: () => false,
    isDeleted: () => false,
    currentText: (_c, frameId) => text.get(frameId),
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

function bootStore({ history = [] } = {}) {
  const store = freshStore();
  store.me = { user_id: ME };
  store.conversations = [{ id: 'dm1', kind: 'dm', unread: false }];
  store.refreshConversations = async () => {};
  store.home = {
    conversation: async () => ({ id: 'dm1', kind: 'dm' }),
    dmHistory: async () => ({ messages: history.slice() }),
  };
  return store;
}

async function settle() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

describe('a frame that lands before the engine can do crypto', () => {
  it('is held rather than walked against a half-built engine', async () => {
    const store = bootStore();
    expect(store.mls).toBeFalsy();

    store.onDmFrame(frame('f1', 7), true);
    await settle();

    expect(store.dmPending.get('dm1').map((f) => f.id)).toEqual(['f1']);
    expect(store.dmUnreadFor('dm1')).toBe(1);
  });

  it('is walked by the drain once the engine lands', async () => {
    const store = bootStore();
    store.onDmFrame(frame('f1', 7), true);
    await settle();

    const mls = recordingEngine();
    store.mls = mls;
    await store.drainStartup();

    expect(mls.walked.map((w) => w.ids)).toEqual([['f1']]);
    expect(mls.textOf('f1')).toBe('hello');
  });

  it('walks a conversation that was already open, as a window', async () => {
    const store = bootStore({ history: [frame('old', 1)] });
    await store.openConversation('dm1');
    expect(store.dmFrames.get('dm1').map((f) => f.id)).toEqual(['old']);

    const mls = recordingEngine();
    store.mls = mls;
    await store.drainStartup();

    expect(mls.walked).toHaveLength(1);
    expect(mls.walked[0].ids).toEqual(['old']);
    expect(mls.textOf('old')).toBe('hello');
  });

  it('walks loaded conversations and buffered ones alike', async () => {
    const store = bootStore({ history: [frame('old', 1)] });
    await store.openConversation('dm1');
    store.onDmFrame({ ...frame('other', 4), conversation_id: 'dm2' }, true);
    await settle();

    const mls = recordingEngine();
    store.mls = mls;
    await store.drainStartup();

    const ids = mls.walked.flatMap((w) => w.ids).sort();
    expect(ids).toEqual(['old', 'other']);
  });

  it('does nothing when no frames arrived during startup', async () => {
    const store = bootStore();
    const mls = recordingEngine();
    store.mls = mls;

    await store.drainStartup();

    expect(mls.walked).toEqual([]);
  });

  it('carries on past a conversation that throws', async () => {
    const store = bootStore();
    store.onDmFrame(frame('f1', 7), true);
    store.onDmFrame({ ...frame('f2', 8), conversation_id: 'dm2' }, true);
    await settle();

    const mls = recordingEngine();
    const seen = [];
    mls.sync = async (conversationId, frames) => {
      seen.push(conversationId);
      if (conversationId === 'dm1') throw new Error('no group for this device');
      for (const f of frames) mls.text.set(f.id, 'hello');
      return [];
    };
    store.mls = mls;
    await store.drainStartup();

    expect(seen).toEqual(['dm1', 'dm2']);
    expect(mls.textOf('f2')).toBe('hello');
  });

  it('is a no-op while there is still no engine', async () => {
    const store = bootStore();
    store.onDmFrame(frame('f1', 7), true);
    await settle();

    await store.drainStartup();

    expect(store.dmPending.get('dm1').map((f) => f.id)).toEqual(['f1']);
  });
});
