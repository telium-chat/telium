import { describe, expect, it, vi } from 'vitest';
import { MAX_PINNED_CONVERSATIONS, prefsMethods } from '../lib/store/prefs.js';

function store(pinned) {
  const s = Object.create(prefsMethods);
  s.prefs = pinned ? { pinnedConversations: pinned } : {};
  s.savePrefs = vi.fn();
  return s;
}

const convos = [
  { id: 'a', last_activity_at: 30 },
  { id: 'b', last_activity_at: 20 },
  { id: 'c', last_activity_at: 10 },
];

describe('pinned conversations', () => {
  it('lists pinned ones first and keeps activity order inside each group', () => {
    const s = store(['c', 'b']);
    expect(s.orderConversations(convos).map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not change the order when nothing is pinned, or mutate its input', () => {
    const s = store();
    const input = [convos[2], convos[0], convos[1]];
    expect(s.orderConversations(input).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(input[0].id).toBe('c');
  });

  it('pins and unpins through the synced prefs', () => {
    const s = store();
    expect(s.setConversationPinned('b', true)).toBe(true);
    expect(s.isConversationPinned('b')).toBe(true);
    s.setConversationPinned('b', false);
    expect(s.isConversationPinned('b')).toBe(false);
    expect(s.savePrefs).toHaveBeenCalledTimes(2);
  });

  it('refuses a pin past the limit and leaves the list alone', () => {
    const full = Array.from({ length: MAX_PINNED_CONVERSATIONS }, (_, i) => `x${i}`);
    const s = store(full);
    expect(s.setConversationPinned('new', true)).toBe(false);
    expect(s.pinnedConversationIds()).toEqual(full);
  });

  it('tolerates a malformed synced value', () => {
    expect(store('nope').pinnedConversationIds()).toEqual([]);
  });
});
