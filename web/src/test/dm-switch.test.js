import { describe, expect, it, vi } from 'vitest';
import { dmMethods } from '../lib/store/dms.js';

function fakeStore() {
  const store = {
    ...dmMethods,
    conversations: [{ id: 'c1', unread: true }],
    dmFrames: new Map(),
    dmOpened: new Map(),
    dmLoading: new Map(),
    dmUnread: new Map([['c1', 3]]),
    mls: null,
    events: [],
    emit(name) { this.events.push(name); },
  };
  store.loadConversationNow = vi.fn(async (id) => {
    store.dmFrames.set(id, []);
    store.dmOpened.set(id, { id });
    return { id };
  });
  return store;
}

describe('conversation switching', () => {
  it('a hover loads without reading, and the click shares that load', async () => {
    const store = fakeStore();
    store.prefetchConversation('c1');
    expect(store.dmUnread.has('c1')).toBe(true);
    expect(store.conversations[0].unread).toBe(true);
    await store.openConversation('c1');
    expect(store.loadConversationNow).toHaveBeenCalledTimes(1);
    expect(store.dmUnread.has('c1')).toBe(false);
    expect(store.conversations[0].unread).toBe(false);
  });

  it('does not prefetch a conversation already in hand', async () => {
    const store = fakeStore();
    await store.loadConversation('c1');
    store.prefetchConversation('c1');
    expect(store.loadConversationNow).toHaveBeenCalledTimes(1);
  });

  it('a finished load can be run again', async () => {
    const store = fakeStore();
    await store.loadConversation('c1');
    await store.loadConversation('c1');
    expect(store.loadConversationNow).toHaveBeenCalledTimes(2);
    expect(store.dmLoading.size).toBe(0);
  });
});
