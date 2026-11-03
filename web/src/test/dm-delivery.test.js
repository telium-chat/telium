import { describe, expect, it, vi } from 'vitest';
import { dmMethods } from '../lib/store/dms.js';
import { timelineMethods } from '../lib/store/timeline.js';
import { friendMethods } from '../lib/store/friends.js';
import { signalMethods } from '../lib/store/signals.js';
import { KEYS } from '../lib/sync.js';

function fakeStore() {
  const store = {
    ...dmMethods,
    ...timelineMethods,
    ...friendMethods,
    ...signalMethods,
    conversations: [{ id: 'c1', kind: 'dm', members: [], last_activity_at: 0 }],
    dmFrames: new Map(),
    dmOldest: new Map(),
    dmHistoryEnd: new Set(),
    dmLoadingOlder: new Map(),
    dmPending: new Map(),
    dmPendingFull: new Set(),
    dmOutbox: new Map(),
    dmOutboxTimers: new Map(),
    dmOutboxPumping: new Set(),
    dmOpened: new Map(),
    dmLoading: new Map(),
    dmUnread: new Map(),
    signalFlushes: new Map(),
    dmServerUnread: new Map(),
    dmReadCleared: new Set(),
    dmDeliveredTimers: new Map(),
    dmDeliveredPending: new Map(),
    sending: new Set(),
    mls: null,
    vault: null,
    route: { view: 'dms', conversationId: null },
    events: [],
    emit(name) { this.events.push(name); },
    notifyTypingStop() {},
    sync: {
      store: {},
      get(key) { return this.store[key]; },
      set(key, value) { this.store[key] = JSON.parse(JSON.stringify(value)); },
    },
  };
  return store;
}

const QUEUED_BODY = { kind: 'application', ciphertext: 'ct1', epoch: 3, frame_id: 'fid-1' };

describe('the DM outbox', () => {
  it('a refused send waits in the outbox and lands as the identical frame', async () => {
    const store = fakeStore();
    store.dmFrames.set('c1', []);
    const noted = vi.fn(async () => {});
    store.mls = {
      joined: () => true,
      notedSent: noted,
      payloadTypeOf: () => 'message',
      send: vi.fn(async (id, text, attachments, reply, { queued } = {}) => {
        queued(QUEUED_BODY, 'plain-one');
        throw Object.assign(new Error('the wire is down'), { status: 503 });
      }),
    };
    const sent = [];
    store.home = { sendFrame: vi.fn(async (id, body) => {
      sent.push(body);
      if (sent.length === 1) throw Object.assign(new Error('still down'), { status: 503 });
      return { id: 'f1', seq: 5 };
    }) };

    await expect(store.sendDm('c1', 'hello')).resolves.toBeNull();
    expect(store.dmOutboxIn('c1')).toHaveLength(1);

    // First pump: the server is still down; the entry waits, it is not dropped or failed.
    await store.pumpDmOutbox('c1');
    let entry = store.dmOutboxIn('c1')[0];
    expect(entry.attempts).toBe(1);
    expect(entry.failed).toBe(false);
    expect(noted).not.toHaveBeenCalled();

    // Second pump: the server takes it, the very body that was queued, and the row completes.
    entry.nextAt = 0;
    await store.pumpDmOutbox('c1');
    expect(store.dmOutboxIn('c1')).toHaveLength(0);
    expect(sent[0]).toBe(QUEUED_BODY);
    expect(sent[1]).toBe(QUEUED_BODY);
    expect(noted).toHaveBeenCalledWith('c1', { id: 'f1', seq: 5 }, 'plain-one');
    const landed = store.dmFrames.get('c1').find((f) => f.id === 'f1');
    expect(landed.nonce).toBeUndefined();
    expect(store.events).toContain('outbox');
  });

  it('a refusal the server means stops the retries; resending builds a fresh frame', async () => {
    const store = fakeStore();
    store.dmFrames.set('c1', []);
    store.mls = {
      joined: () => true,
      notedSent: vi.fn(async () => {}),
      payloadTypeOf: () => 'message',
      send: vi.fn(async (id, text, attachments, reply, { queued } = {}) => {
        if (store.mls.send.mock.calls.length === 1) {
          queued(QUEUED_BODY, 'plain-one');
          throw Object.assign(new Error('the wire is down'), { status: 503 });
        }
        return { id: 'f2', seq: 6 };
      }),
    };
    store.home = { sendFrame: vi.fn(async () => {
      throw Object.assign(new Error('no'), { status: 403 });
    }) };

    await store.sendDm('c1', 'hello');
    await store.pumpDmOutbox('c1');
    const entry = store.dmOutboxIn('c1')[0];
    expect(entry.failed).toBe(true);
    expect(store.home.sendFrame).toHaveBeenCalledTimes(1);

    // A person-directed resend goes out as a new frame, not the aged one.
    const again = await store.resendQueuedDm('c1', entry.key);
    expect(again).toEqual({ id: 'f2', seq: 6 });
    expect(store.dmOutboxIn('c1')).toHaveLength(0);
    expect(store.dmFrames.get('c1').some((f) => f.id === 'f2')).toBe(true);
  });

  it('the queue is written down and re-armed on the next start', async () => {
    const store = fakeStore();
    store.mls = {
      joined: () => true,
      notedSent: vi.fn(async () => {}),
      payloadTypeOf: () => 'message',
      send: vi.fn(async (id, text, attachments, reply, { queued } = {}) => {
        queued(QUEUED_BODY, 'plain-one');
        throw Object.assign(new Error('the wire is down'), { status: 503 });
      }),
    };
    store.home = { sendFrame: vi.fn(async () => {
      throw Object.assign(new Error('still down'), { status: 503 });
    }) };
    await store.sendDm('c1', 'hello');
    expect(store.sync.store[KEYS.outbox].c1).toHaveLength(1);

    // A fresh start reads the queue back, re-arms it, and pumps once the wire answers.
    const restarted = fakeStore();
    restarted.sync.store = store.sync.store;
    restarted.mls = store.mls;
    let tries = 0;
    restarted.home = { sendFrame: vi.fn(async () => {
      tries += 1;
      if (tries === 1) throw Object.assign(new Error('still down'), { status: 503 });
      return { id: 'f1', seq: 5 };
    }) };
    restarted.adoptDmOutbox();
    const entry = restarted.dmOutboxIn('c1')[0];
    expect(entry.body).toEqual(QUEUED_BODY);
    await restarted.pumpDmOutbox('c1');
    expect(restarted.dmOutboxIn('c1')).toHaveLength(1);
    entry.nextAt = 0;
    await restarted.pumpDmOutbox('c1');
    expect(restarted.dmOutboxIn('c1')).toHaveLength(0);
    // What landed here is gone from the written queue, so a slower device cannot repeat it.
    expect(restarted.sync.store[KEYS.outbox].c1).toBeUndefined();
  });
});

describe('DM scrollback', () => {
  function historyOf(from, to) {
    return Array.from({ length: to - from + 1 }, (_, n) => ({
      id: `f${from + n}`, seq: from + n, kind: 'application', ciphertext: `m${from + n}`,
    }));
  }

  function pagingStore(frames) {
    const store = fakeStore();
    store.syncedWalk = vi.fn(async () => {});
    store.mls = { sync: store.syncedWalk };
    store.home = {
      dmHistory: vi.fn(async (id, { before, limit }) => {
        const below = frames.filter((f) => f.seq < (before ?? Infinity));
        const page = below.slice(-limit);
        return { messages: page };
      }),
    };
    return store;
  }

  it('a page below the window merges in order and the walk sees the whole range', async () => {
    const frames = historyOf(1, 600);
    const store = pagingStore(frames);
    store.loadFrames('c1', frames.slice(400));
    expect(store.dmOldest.get('c1')).toBe(401);

    await expect(store.loadOlderDm('c1')).resolves.toBe(true);
    let held = store.dmFrames.get('c1');
    expect(held).toHaveLength(600 - 200);
    expect(held[0].seq).toBe(201);
    expect(held[399].seq).toBe(600);
    expect(store.dmOldest.get('c1')).toBe(201);
    // A full page means more may exist below, so nothing claims the beginning yet.
    expect(store.dmHistoryEnd.has('c1')).toBe(false);
    expect(store.syncedWalk).toHaveBeenCalledWith('c1', expect.any(Array), { backfill: true });

    // The next page fills down to seq 1. That page is full (200 frames), so the end is not
    // claimed; the following ask hits the floor guard and settles the end without a fetch.
    await expect(store.loadOlderDm('c1')).resolves.toBe(true);
    held = store.dmFrames.get('c1');
    expect(held).toHaveLength(600);
    expect(held[0].seq).toBe(1);
    expect(store.dmOldest.get('c1')).toBe(1);
    expect(store.dmHistoryEnd.has('c1')).toBe(false);
    await expect(store.loadOlderDm('c1')).resolves.toBe(false);
    expect(store.dmHistoryEnd.has('c1')).toBe(true);
    await expect(store.loadOlderDm('c1')).resolves.toBe(false);
    expect(store.home.dmHistory).toHaveBeenCalledTimes(2);
  });

  it('live frames are kept when an older page lands under them', async () => {
    const frames = historyOf(1, 300);
    const store = pagingStore(frames);
    store.loadFrames('c1', frames.slice(200));
    const live = { id: 'flive', seq: 301, kind: 'application', ciphertext: 'mlive' };
    store.dmFrames.get('c1').push(live);

    await store.loadOlderDm('c1');
    const held = store.dmFrames.get('c1');
    expect(held.some((f) => f.id === 'flive')).toBe(true);
    expect(held[held.length - 1].seq).toBe(301);
    expect(store.dmPending.has('c1')).toBe(false);
  });

  it('a short page is the beginning; an incomplete one stops where the hole is', async () => {
    const frames = historyOf(1, 120);
    const store = pagingStore(frames);
    store.loadFrames('c1', frames.slice(100));
    await expect(store.loadOlderDm('c1')).resolves.toBe(true);
    expect(store.dmFrames.get('c1')).toHaveLength(120);
    expect(store.dmHistoryEnd.has('c1')).toBe(true);

    const gapped = pagingStore(historyOf(1, 300));
    gapped.dmFrames.set('c2', historyOf(201, 300));
    gapped.dmOldest.set('c2', 201);
    gapped.home.dmHistory = vi.fn(async () => ({ messages: historyOf(190, 200), incomplete: true }));
    await gapped.loadOlderDm('c2');
    expect(gapped.dmHistoryEnd.has('c2')).toBe(true);
  });
});

describe('the offline badge catch-up', () => {
  function catchUpStore() {
    const store = fakeStore();
    store.route = { view: 'dms', conversationId: null };
    store.conversations = [
      { id: 'c1', kind: 'dm', last_seq: 9, members: [], last_activity_at: 9 },
      { id: 'c2', kind: 'dm', last_seq: 20, members: [], last_activity_at: 20 },
      { id: 'c3', kind: 'dm', last_seq: 6, request_state: 'pending', members: [], last_activity_at: 6 },
      { id: 'c4', kind: 'dm', last_seq: 9, members: [], last_activity_at: 8 },
    ];
    // What a refreshConversations seeding would have left behind. A pending request's count
    // is the server's to gate: it never ships a nonzero one, so the seed mirrors that.
    store.dmServerUnread.set('c1', 4);
    store.dmServerUnread.set('c2', 3);
    store.dmServerUnread.set('c3', 0);
    store.dmServerUnread.set('c4', 2);
    const walked = { c1: 5, c3: 3, c4: 9 };
    const types = {
      f6: 'message', f7: 'receipt', f8: 'message',
      // f9 never opened: no key for it. Still unseen.
    };
    store.mls = {
      walkedTo: (id) => walked[id] || 0,
      payloadTypeOf: (id) => types[id],
      isSignal: () => false,
      // Walking advances the watermark, as the real engine's walk does.
      sync: vi.fn(async (id, frames) => {
        const top = frames.reduce((high, f) => Math.max(high, f.seq || 0), walked[id] || 0);
        walked[id] = top;
      }),
    };
    store.me = { user_id: 'me' };
    const history = {
      c1: [
        { id: 'f1', seq: 1, kind: 'application', sender: 'peer', ciphertext: 'old' },
        { id: 'f6', seq: 6, kind: 'application', sender: 'peer', ciphertext: 'missed-one' },
        { id: 'f7', seq: 7, kind: 'application', sender: 'peer', ciphertext: 'r' },
        { id: 'f8', seq: 8, kind: 'application', sender: 'me', ciphertext: 'mine' },
        { id: 'f9', seq: 9, kind: 'application', sender: 'peer', ciphertext: 'locked' },
      ],
      c3: [{ id: 'g4', seq: 4, kind: 'application', sender: 'peer', ciphertext: 'ask' }],
      c4: historyOfFrames(1, 9),
    };
    store.home = {
      dmHistory: vi.fn(async (id) => ({ messages: history[id] || [] })),
      sendDmDelivered: vi.fn(async () => ({ ok: true })),
    };
    return store;
  }

  function historyOfFrames(from, to) {
    return Array.from({ length: to - from + 1 }, (_, n) => ({
      id: `h${from + n}`, seq: from + n, kind: 'application', sender: 'peer', ciphertext: `h${from + n}`,
    }));
  }

  it('a conversation that moved while away is walked and its cursor settles', async () => {
    vi.useFakeTimers();
    const store = catchUpStore();
    await store.catchUpDmUnread();
    expect(store.home.dmHistory).toHaveBeenCalledWith('c1', { tail: 100 });
    expect(store.dmFrames.get('c1')).toHaveLength(5);
    // The badge was already on the row the server sent; nothing is counted twice here.
    expect(store.dmUnread.has('c1')).toBe(false);
    expect(store.conversations[0].unread).toBe(true);
    // Once the account holds the frames, the cursor tells the home so.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.home.sendDmDelivered).toHaveBeenCalledWith('c1', 9);
    vi.useRealTimers();
  });

  it('a conversation this device has never walked keeps the server badge and waits for its first open', async () => {
    vi.useFakeTimers();
    const store = catchUpStore();
    await store.catchUpDmUnread();
    expect(store.home.dmHistory).not.toHaveBeenCalledWith('c2', { tail: 100 });
    // The badge is the server's word, and it stands before any walk.
    expect(store.dmUnreadFor('c2')).toBe(3);
    vi.useRealTimers();
  });

  it('a cursor the server thinks is behind settles without counting', async () => {
    vi.useFakeTimers();
    const store = catchUpStore();
    await store.catchUpDmUnread();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.home.sendDmDelivered).toHaveBeenCalledWith('c4', 9);
    expect(store.dmUnread.has('c4')).toBe(false);
    vi.useRealTimers();
  });

  it('the conversation on screen is not settled; a pending request never badges', async () => {
    vi.useFakeTimers();
    const store = catchUpStore();
    store.route.conversationId = 'c1';
    store.dmOpened.set('c1', { id: 'c1' });
    await store.catchUpDmUnread();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.home.sendDmDelivered).not.toHaveBeenCalledWith('c1', 9);
    expect(store.dmUnreadFor('c3')).toBe(0);
    // The walk still happened for the request, so opening it shows the message;
    // the badge is what a pending request must never raise.
    expect(store.home.dmHistory).toHaveBeenCalledWith('c3', { tail: 100 });
    vi.useRealTimers();
  });
});

describe('the badge and the delivery cursor', () => {
  it('a badge is the server count plus what arrived since; reading zeroes it until the server agrees', () => {
    const store = fakeStore();
    store.conversations = [
      { id: 'c1', kind: 'dm', last_activity_at: 5 },
      { id: 'c2', kind: 'dm', last_activity_at: 4 },
    ];
    store.dmServerUnread.set('c1', 3);
    store.dmUnread.set('c1', 2); // live arrivals since the refresh
    expect(store.dmUnreadFor('c1')).toBe(5);
    expect(store.dmUnreadFor('c2')).toBe(0);
    expect(store.dmUnreadTotal()).toBe(5);

    store.dmReadCleared.add('c1');
    expect(store.dmUnreadFor('c1')).toBe(0);
    expect(store.dmUnreadTotal()).toBe(0);
  });

  it('a refresh hands the live overlay to the server count; a server without counts is left alone', async () => {
    const store = fakeStore();
    store.dmServerUnread.set('c1', 1);
    store.dmUnread.set('c1', 2);
    store.dmReadCleared.add('c1');
    store.home = {
      conversations: async () => ({
        conversations: [
          { id: 'c1', kind: 'dm', unread: 3, last_activity_at: 9 },
          { id: 'c2', kind: 'dm', last_activity_at: 8 },
        ],
      }),
    };
    await store.refreshConversations();
    // The snapshot already includes the two live arrivals, so the overlay hands over.
    expect(store.dmUnreadFor('c1')).toBe(3);
    expect(store.dmUnreadFor('c2')).toBe(0);

    // An older server that names no count changes nothing.
    store.dmUnread.set('c2', 4);
    store.home.conversations = async () => ({
      conversations: [{ id: 'c1', kind: 'dm', last_activity_at: 9 }],
    });
    await store.refreshConversations();
    expect(store.dmUnreadFor('c1')).toBe(3);
    expect(store.dmUnreadFor('c2')).toBe(4);
  });

  it('reading reports the position of the read frame once, and only upward', async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    store.mls = {
      walkedTo: () => 7,
      seqOf: new Map([['last-frame', 9]]),
      noteRead: () => {},
      lastReadableHome: null,
    };
    // `lastReadable` comes from the loaded window.
    store.dmFrames.set('c1', [
      { id: 'sig-1', seq: 7, kind: 'application', ciphertext: 'x' },
      { id: 'last-frame', seq: 9, kind: 'application', ciphertext: 'y' },
    ]);
    store.mls.isSignal = (id) => id === 'sig-1';
    store.home = { sendDmDelivered: vi.fn(async () => ({ ok: true })) };

    store.markConversationRead('c1');
    store.markConversationRead('c1');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.home.sendDmDelivered).toHaveBeenCalledTimes(1);
    expect(store.home.sendDmDelivered).toHaveBeenCalledWith('c1', 9);
    vi.useRealTimers();
  });
});
