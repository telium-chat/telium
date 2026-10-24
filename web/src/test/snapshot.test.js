import { describe, expect, it } from 'vitest';
import { apply, capture } from '../lib/snapshot.js';

function storeWith({ guilds = [], channels = [], messages = [], me = { user_id: '@a:h' } } = {}) {
  return {
    me,
    guilds: new Map(guilds.map((g) => [g.id, g])),
    channels: new Map(channels.map((c) => [c.id, c])),
    roles: new Map(),
    emojis: new Map(),
    readState: new Map(),
    messages: new Map(messages),
    hasMore: new Map(),
    conversations: [],
  };
}

function msgs(n, at) {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i}`, created_at: at + i }));
}

describe('capture', () => {
  it('keeps only the tail of the channels most recently spoken in', () => {
    const messages = Array.from({ length: 40 }, (_, i) => [`c${i}`, msgs(80, i * 1000)]);
    const snap = capture(storeWith({ messages }));

    expect(snap.messages).toHaveLength(30);
    expect(snap.messages.map(([id]) => id)).toContain('c39');
    expect(snap.messages.map(([id]) => id)).not.toContain('c0');
    for (const [, list] of snap.messages) expect(list).toHaveLength(50);
    const [, kept] = snap.messages.find(([id]) => id === 'c39');
    expect(kept[kept.length - 1].id).toBe('m79');
  });

  it('does not carry state that describes only this instant', () => {
    const snap = capture(storeWith());
    expect(snap).not.toHaveProperty('presence');
    expect(snap).not.toHaveProperty('typing');
    expect(snap).not.toHaveProperty('voice');
  });
});

describe('apply', () => {
  it('fills an empty store', () => {
    const store = storeWith({ me: null });
    const ok = apply(store, {
      version: 1,
      saved_at: 1234,
      me: { user_id: '@a:h' },
      guilds: [{ id: 'g1' }],
      channels: [{ id: 'c1' }],
      roles: [['g1', [{ id: 'r1' }]]],
      messages: [['c1', msgs(3, 0)]],
      conversations: [{ id: 'd1' }],
    });

    expect(ok).toBe(true);
    expect(store.guilds.get('g1')).toEqual({ id: 'g1' });
    expect(store.roles.get('g1').get('r1')).toEqual({ id: 'r1' });
    expect(store.me.user_id).toBe('@a:h');
    expect(store.cachedAt).toBe(1234);
  });

  it('marks every restored channel as having more above it', () => {
    const store = storeWith({ me: null });
    apply(store, { version: 1, guilds: [{ id: 'g1' }], messages: [['c1', msgs(3, 0)]] });
    expect(store.hasMore.get('c1')).toBe(true);
  });

  it('refuses to overwrite a store a READY already landed in', () => {
    const store = storeWith({ guilds: [{ id: 'live' }] });
    const ok = apply(store, { version: 1, guilds: [{ id: 'cached' }] });

    expect(ok).toBe(false);
    expect(store.guilds.has('cached')).toBe(false);
    expect(store.guilds.has('live')).toBe(true);
  });

  it('ignores a snapshot from a version that is not this one', () => {
    const store = storeWith({ me: null });
    expect(apply(store, { version: 99, guilds: [{ id: 'g1' }] })).toBe(false);
    expect(apply(store, null)).toBe(false);
    expect(store.guilds.size).toBe(0);
  });
});
