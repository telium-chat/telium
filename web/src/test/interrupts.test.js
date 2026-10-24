import { describe, expect, it } from 'vitest';
import dispatchSource from '../lib/store/dispatch.js?raw';
import {
  BOOKKEEPING,
  EVENT_INTENT,
  FRAME_INTENT,
  INTERRUPT,
  frameMayInterrupt,
  isClassified,
  mayInterrupt,
} from '../lib/interrupts.js';
import { freshStore } from './fake-server.js';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';

const kindsWith = (intent) => Object.entries(EVENT_INTENT)
  .filter(([, value]) => value === intent)
  .map(([t]) => t);

const SAMPLE = {
  id: 'x1',
  user_id: CAROL,
  guild_id: 'g1',
  channel_id: 'c1',
  message_id: 'm1',
  conversation_id: 'dm1',
  parent_id: 'c1',
  emoji: '👍',
  sender: CAROL,
  sender_device: 'd-carol',
  kind: 'application',
  content: `hey ${ME}, look at this`,
  ops: [],
  channels: [],
};

function quietStore() {
  const store = freshStore();
  store.me = { user_id: ME };
  store.conversations = [{ id: 'dm1', kind: 'dm', unread: false }];
  store.channels.set('c1', { id: 'c1', guild_id: 'g1', name: 'general' });
  store.guilds.set('g1', { id: 'g1', name: 'A guild' });
  for (const method of [
    'loadRoles', 'refreshMe', 'loadReadState', 'loadExpressions',
    'refreshConversations', 'onVerification', 'persist',
  ]) {
    store[method] = async () => {};
  }

  const heard = [];
  for (const event of ['unread', 'mention', 'dm-notify']) {
    store.on(event, (payload) => heard.push({ event, payload }));
  }
  return { store, heard };
}

function fakeEngine(opened = {}) {
  const walked = [];
  return {
    walked,
    sync: async (conversationId, frames) => {
      walked.push(frames.map((f) => f.id));
      return [];
    },
    payloadTypeOf: (frameId) => opened[frameId],
    isSignal: (frameId) => opened[frameId] !== undefined && opened[frameId] !== 'message',
    isMine: () => false,
    textOf: () => undefined,
    takeRejoins: () => [],
    flushSignals: async () => null,
  };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const arriving = (id, sender = CAROL) => ({
  id,
  conversation_id: 'dm1',
  seq: 7,
  epoch: 1,
  kind: 'application',
  sender,
  sender_device: sender === ME ? 'd-alice' : 'd-carol',
  ciphertext: 'EEEE',
  created_at: Date.now(),
});

describe('what is worth interrupting for', () => {
  it('classifies the three the user named as bookkeeping', () => {
    expect(FRAME_INTENT.receipt).toBe(BOOKKEEPING);
    expect(FRAME_INTENT.delivered).toBe(BOOKKEEPING);
    expect(FRAME_INTENT.reaction).toBe(BOOKKEEPING);
    expect(mayInterrupt('MESSAGE_REACTION_ADD')).toBe(false);
    expect(mayInterrupt('MESSAGE_REACTION_REMOVE')).toBe(false);
    expect(mayInterrupt('MESSAGE_REACTION_CLEAR')).toBe(false);
  });

  it('lets a message through on both wires and nothing else', () => {
    expect(mayInterrupt('MESSAGE_CREATE')).toBe(true);
    expect(FRAME_INTENT.message).toBe(INTERRUPT);
    expect(kindsWith(INTERRUPT).filter((t) => t.startsWith('MESSAGE_')))
      .toEqual(['MESSAGE_CREATE']);
    expect(Object.entries(FRAME_INTENT)
      .filter(([, intent]) => intent === INTERRUPT)
      .map(([type]) => type)).toEqual(['message']);
  });

  it('treats an edit as bookkeeping, deliberately and both ways', () => {
    expect(mayInterrupt('MESSAGE_UPDATE')).toBe(false);
    expect(FRAME_INTENT.edit).toBe(BOOKKEEPING);
  });

  it('answers no for an event this build has never heard of', () => {
    expect(mayInterrupt('MESSAGE_SHOUTED')).toBe(false);
    expect(mayInterrupt(undefined)).toBe(false);
  });

  it('counts a DM frame it could not open, and only that one', () => {
    expect(frameMayInterrupt(undefined)).toBe(true);
    expect(frameMayInterrupt('message')).toBe(true);
    expect(frameMayInterrupt('receipt')).toBe(false);
    expect(frameMayInterrupt('unknown')).toBe(false);
  });

  it('has an opinion about every event the dispatcher handles', () => {
    const arms = [...dispatchSource.matchAll(/case '([A-Z_]+)':/g)].map((m) => m[1]);
    expect(arms.length).toBeGreaterThan(30);
    expect(arms.filter((t) => !isClassified(t))).toEqual([]);
  });
});

describe('the dispatcher, on a bookkeeping event', () => {
  it.each(kindsWith(BOOKKEEPING))('stays silent for %s', (t) => {
    const { store, heard } = quietStore();
    store.onDispatch({ domain: 'home.example', t, d: { ...SAMPLE } });
    expect(heard).toEqual([]);
  });

  it('still counts a message, so the silence above means something', () => {
    const { store, heard } = quietStore();
    store.messages.set('c1', []);
    store.onDispatch({
      domain: 'home.example',
      t: 'MESSAGE_CREATE',
      d: { id: 'm2', channel_id: 'c1', author: CAROL, content: `hi ${ME}` },
    });
    expect(heard.map((h) => h.event)).toEqual(['unread', 'mention']);
    expect(store.unreadFor('c1')).toMatchObject({ unread: 1, mentions: 1 });
  });

  it('does not count this account talking to itself', () => {
    const { store, heard } = quietStore();
    store.messages.set('c1', []);
    store.onDispatch({
      domain: 'home.example',
      t: 'MESSAGE_CREATE',
      d: { id: 'm3', channel_id: 'c1', author: ME, content: `note to self ${ME}` },
    });
    expect(heard).toEqual([]);
    expect(store.unreadFor('c1').unread).toBeFalsy();
  });
});

describe('a dm frame nobody has opened the conversation for', () => {
  it.each([
    ['a read receipt', 'receipt'],
    ['a delivery receipt', 'delivered'],
    ['a reaction', 'reaction'],
    ['a typing signal', 'typing'],
    ['an edit', 'edit'],
    ['a delete', 'delete'],
  ])('asks the engine, and says nothing for %s', async (_name, type) => {
    const { store, heard } = quietStore();
    const engine = fakeEngine({ f9: type });
    store.mls = engine;
    expect(store.dmFrames.has('dm1')).toBe(false);

    store.onDmFrame(arriving('f9'), true);
    await settle();

    expect(engine.walked).toEqual([['f9']]);
    expect(heard).toEqual([]);
    expect(store.dmUnreadFor('dm1')).toBe(0);
    expect(store.conversations[0].unread).toBeFalsy();
  });

  it('still announces a message', async () => {
    const { store, heard } = quietStore();
    store.mls = fakeEngine({ f10: 'message' });

    store.onDmFrame(arriving('f10'), true);
    await settle();

    expect(heard.map((h) => h.event)).toEqual(['unread', 'dm-notify']);
    expect(store.dmUnreadFor('dm1')).toBe(1);
  });

  it('keeps a pending message request out of unread and notifications', async () => {
    const { store, heard } = quietStore();
    store.conversations[0].request_state = 'pending';
    store.mls = fakeEngine({ f10r: 'message' });

    store.onDmFrame({ ...arriving('f10r'), request_state: 'pending' }, true);
    await settle();

    expect(heard).toEqual([]);
    expect(store.dmUnreadFor('dm1')).toBe(0);
    expect(store.conversations[0].unread).toBeFalsy();
  });

  it('still announces a frame it walked and could not open', async () => {
    const { store, heard } = quietStore();
    store.mls = fakeEngine();

    store.onDmFrame(arriving('f11'), true);
    await settle();

    expect(heard.map((h) => h.event)).toEqual(['unread', 'dm-notify']);
  });

  it('says nothing about this account’s own frame', async () => {
    const { store, heard } = quietStore();
    store.mls = fakeEngine({ f12: 'message' });

    store.onDmFrame(arriving('f12', ME), true);
    await settle();

    expect(heard).toEqual([]);
    expect(store.dmUnreadFor('dm1')).toBe(0);
  });
});
