import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store.js';
import { KEYS, MAX_DRAFT_LENGTH, MAX_DRAFTS, SyncStore, draftText } from '../lib/sync.js';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function draftStore() {
  const store = Object.create(Store.prototype);
  store.session = { home: { user_id: '@alice:test' } };
  store.sync = new SyncStore();
  store.emit = vi.fn();
  return store;
}

describe('drafts', () => {
  it('bounds draft text and never sends it anywhere without a key to seal it', async () => {
    const sync = new SyncStore();
    const api = { syncPut: vi.fn(async () => ({ ok: true })) };
    sync.api = api;

    sync.set(KEYS.drafts, {
      'channel:abc': { text: 'hello from a channel', at: 1 },
      empty: '',
      oversized: 'x'.repeat(MAX_DRAFT_LENGTH + 50),
    });
    await sync.push();

    const drafts = sync.get(KEYS.drafts);
    expect(draftText(drafts, 'channel:abc')).toBe('hello from a channel');
    expect(drafts.empty).toBeUndefined();
    expect(draftText(drafts, 'oversized')).toHaveLength(MAX_DRAFT_LENGTH);
    expect(api.syncPut).not.toHaveBeenCalled();
  });

  it('keeps the newest drafts when there are too many', () => {
    const sync = new SyncStore();
    const many = {};
    for (let i = 0; i < MAX_DRAFTS + 20; i++) many[`channel:${i}`] = { text: `draft ${i}`, at: i + 1 };
    sync.set(KEYS.drafts, many);
    const kept = sync.get(KEYS.drafts);
    expect(Object.keys(kept)).toHaveLength(MAX_DRAFTS);
    expect(draftText(kept, `channel:${MAX_DRAFTS + 19}`)).toBe(`draft ${MAX_DRAFTS + 19}`);
    expect(kept['channel:0']).toBeUndefined();
  });

  it('keeps channel and conversation drafts in one map, and remembers a cleared one', () => {
    const store = draftStore();
    store.saveDraft('channel:abc', 'guild words');
    store.saveDraft('conversation:def', 'unsent text');
    expect(store.draftFor('channel:abc')).toBe('guild words');
    expect(store.draftFor('conversation:def')).toBe('unsent text');

    store.saveDraft('conversation:def', '');
    expect(store.draftFor('conversation:def')).toBe('');
    expect(store.sync.get(KEYS.drafts)['conversation:def']).toEqual({ text: '', at: expect.any(Number) });
  });

  it("moves the previous release's device-local conversation drafts into the map", () => {
    localStorage.setItem('telium.dm-drafts.local.v1', JSON.stringify({
      '@alice:test': { def: 'kept on this device' },
      '@bob:test': { xyz: 'not alice' },
    }));
    const store = draftStore();
    store.adoptLocalDmDrafts();
    expect(store.draftFor('conversation:def')).toBe('kept on this device');
    expect(store.draftFor('conversation:xyz')).toBe('');
    expect(JSON.parse(localStorage.getItem('telium.dm-drafts.local.v1'))).toEqual({
      '@bob:test': { xyz: 'not alice' },
    });
  });

  it('restores drafts from the local mirror before the server is reachable', () => {
    const first = new SyncStore();
    first.set(KEYS.drafts, { 'channel:abc': { text: 'survives navigation', at: 1 } });

    const second = new SyncStore();
    expect(draftText(second.get(KEYS.drafts), 'channel:abc')).toBe('survives navigation');
  });

  it('does not lose what was typed during an outage when the socket comes back', () => {
    const sync = new SyncStore();
    sync.keys = { kid: 'k1', byKid: new Map([['k1', {}]]) };
    sync.set(KEYS.drafts, { 'channel:abc': { text: 'typed while it was down', at: 200 } });

    sync.adoptSealed(KEYS.drafts, {
      kid: 'k1',
      doc: {
        v: {
          'channel:xyz': { text: 'written on the laptop', at: 100 },
          'channel:abc': { text: 'what this room held before', at: 100 },
        },
        t: 100,
        n: 7,
      },
    });

    const drafts = sync.get(KEYS.drafts);
    expect(draftText(drafts, 'channel:abc')).toBe('typed while it was down');
    expect(draftText(drafts, 'channel:xyz')).toBe('written on the laptop');
    expect(sync.pending.has(KEYS.drafts)).toBe(true);
  });
});
