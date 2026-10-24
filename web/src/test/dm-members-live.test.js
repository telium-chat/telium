import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshStore } from './fake-server.js';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';

function groupStore(kind = 'gc') {
  const store = freshStore();
  store.me = { user_id: ME };
  store.conversations = [{ id: 'g1', kind, unread: false }];
  store.refreshConversations = vi.fn(async () => {});
  store.mls = {
    sync: async () => [],
    payloadTypeOf: () => undefined,
    isSignal: () => false,
    isMine: () => false,
    textOf: () => undefined,
    takeRejoins: () => [],
    flushSignals: async () => null,
    joined: () => true,
  };
  return store;
}

const commit = (id, seq) => ({
  id, conversation_id: 'g1', seq, epoch: seq, kind: 'commit',
  sender: CAROL, sender_device: 'd-carol', ciphertext: 'x', created_at: seq,
});

describe('a group member list kept live', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('re-reads once after a burst of commits', async () => {
    const store = groupStore();
    store.onDmFrame(commit('c1', 1));
    store.onDmFrame(commit('c2', 2));
    store.onDmFrame(commit('c3', 3));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.refreshConversations).toHaveBeenCalledTimes(1);
  });

  it('leaves a one-to-one alone', async () => {
    const store = groupStore('dm');
    store.onDmFrame(commit('c1', 1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.refreshConversations).not.toHaveBeenCalled();
  });

  it('does not re-read for a message', async () => {
    const store = groupStore();
    store.onDmFrame({ ...commit('m1', 1), kind: 'application' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.refreshConversations).not.toHaveBeenCalled();
  });
});
