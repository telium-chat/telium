import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Store } from '../lib/store.js';
import { MobileDmPanel } from '../views/mobile/MobileDmPanel.jsx';
import { Sidebar } from '../views/Sidebar.jsx';
import { ME, mount, signedInStore } from './harness.jsx';

const STRANGER = '@stranger:else.example';
const CAROL = '@carol:other.example';

const dm = (id, peer, extra = {}) => ({
  id,
  kind: 'dm',
  sequencer: 'home.example',
  epoch: 1,
  last_seq: 0,
  members: [{ user_id: ME, state: 'joined' }, { user_id: peer, state: 'joined' }],
  ...extra,
});
const pending = () => dm('req-1', STRANGER, { request_state: 'pending' });

const peersOf = (convo) => (convo.members || []).map((m) => m.user_id || m).filter((id) => id && id !== ME);

function world({ conversations = [], friends = [] } = {}) {
  let rows = conversations;
  const calls = { accept: [], decline: [], block: [], listed: 0 };
  const store = signedInStore({ conversations: rows, friends, route: { view: 'dms' } });
  store.home = {
    conversations: async () => { calls.listed += 1; return { conversations: rows }; },
    conversation: async () => { throw new Error('no transport in this test'); },
    userProfile: async () => { throw new Error('no transport in this test'); },
    acceptMessageRequest: async (id) => {
      calls.accept.push(id);
      rows = rows.map((c) => (c.id === id ? { ...c, request_state: undefined } : c));
      return {};
    },
    declineMessageRequest: async (id) => {
      calls.decline.push(id);
      rows = rows.filter((c) => c.id !== id);
      return {};
    },
    blockUser: async (userId) => {
      calls.block.push(userId);
      rows = rows.filter((c) => !peersOf(c).includes(userId));
      return { user_id: userId, domain: userId.split(':')[1], state: 'blocked' };
    },
  };
  return { store, calls };
}

async function openRequests(user) {
  await user.click(screen.getByText('Message requests').closest('button'));
  return screen.findByRole('list', { name: 'Message requests' });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('message requests in the store', () => {
  it('keeps pending stranger DMs in a separate request list', () => {
    const store = new Store();
    store.me = { user_id: ME };
    store.conversations = [pending(), dm('normal', CAROL)];
    expect(store.messageRequests().map((c) => c.id)).toEqual(['req-1']);
    expect(store.pendingMessageRequestCount()).toBe(1);
  });

  it.each([
    ['the frame is marked', [{ id: 'pending', kind: 'dm', members: [] }], 'pending', { request_state: 'pending' }, false],
    ['the row is marked', [{ id: 'pending', kind: 'dm', members: [], request_state: 'pending' }], 'pending', {}, false],
    ['the row has not arrived', [], 'unlisted', { request_state: 'pending' }, false],
    ['it is an ordinary DM (control)', [{ id: 'pending', kind: 'dm', members: [] }], 'pending', {}, true],
  ])('counts unread only for non-requests: %s', (_, conversations, id, over, counted) => {
    const store = new Store();
    store.me = { user_id: ME };
    store.conversations = conversations;
    const frame = { id: 'f1', kind: 'application', sender: STRANGER, conversation_id: id, ...over };
    expect(store.noteUnseen(frame)).toBe(counted);
    expect(store.dmUnread.get(id)).toBe(counted ? 1 : undefined);
  });
});

describe.each([
  ['the desktop sidebar', (store) => mount(<Sidebar />, store)],
  ['the mobile panel', (store) => mount(<MobileDmPanel onSelectConversation={() => {}} />, store)],
])('message requests, from %s', (_surface, open) => {
  it('hides a pending request from the list, counts it, and draws it in the dialog', async () => {
    const { store } = world({
      conversations: [pending(), dm('dm-1', CAROL)],
      friends: [{
        user_id: CAROL, domain: 'other.example', state: 'accepted',
        presence: { user_id: CAROL, status: 'online' }, display_name: 'Carol', avatar_ref: null,
      }],
    });
    const { user } = open(store);

    expect(await screen.findByText('Carol')).toBeTruthy();
    expect(screen.queryByText('stranger')).toBeNull();
    expect(screen.queryByText(STRANGER)).toBeNull();
    expect(within(screen.getByText('Message requests').closest('button')).getByText('1')).toBeTruthy();

    const list = await openRequests(user);
    expect(within(list).getByText(STRANGER)).toBeTruthy();
    for (const name of ['Accept', 'Decline', 'Block']) {
      expect(within(list).getByRole('button', { name })).toBeTruthy();
    }
  });

  it('accepts a request and opens the conversation', async () => {
    const { store, calls } = world({ conversations: [pending()] });
    const { user } = open(store);
    const list = await openRequests(user);
    await user.click(within(list).getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(calls.accept).toEqual(['req-1']));
    expect(calls.listed).toBe(1);
    await waitFor(() => expect(store.messageRequests()).toEqual([]));
    expect(store.route.conversationId).toBe('req-1');
    expect(await screen.findByText('stranger')).toBeTruthy();
  });

  it('declines a request and says the sender is not told', async () => {
    const { store, calls } = world({ conversations: [pending()] });
    const { user } = open(store);
    const list = await openRequests(user);
    await user.click(within(list).getByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(calls.decline).toEqual(['req-1']));
    await waitFor(() => expect(
      within(screen.getByRole('list', { name: 'Message requests' })).getByText('No message requests.'),
    ).toBeTruthy());
    expect(store.conversations.find((c) => c.id === 'req-1')).toBeUndefined();
    expect(screen.getByText(/Declined the message request from stranger/)).toBeTruthy();
    expect(screen.getByText(/They are not told/)).toBeTruthy();
  });

  it('asks before blocking, and blocks the person rather than the request', async () => {
    const { store, calls } = world({ conversations: [pending()] });
    const { user } = open(store);
    const list = await openRequests(user);
    const rowButton = within(list).getByRole('button', { name: 'Block' });

    await user.click(rowButton);
    expect(await screen.findByText('Block stranger?')).toBeTruthy();
    expect(calls.block).toEqual([]);
    await user.click(screen.getAllByRole('button', { name: 'Block' }).find((b) => b !== rowButton));

    await waitFor(() => expect(calls.block).toEqual([STRANGER]));
    expect(calls.accept).toEqual([]);
    expect(calls.decline).toEqual([]);
    await waitFor(() => expect(store.messageRequests()).toEqual([]));
    expect(store.friends.get(STRANGER)?.state).toBe('blocked');
  });
});

describe('messaging somebody who has already messaged you', () => {
  it('accepts the request rather than minting a second conversation', async () => {
    const { store, calls } = world({ conversations: [pending()] });
    const mint = vi.spyOn(store, 'mintConversation');
    const convo = await store.startConversation([STRANGER]);

    expect(calls.accept).toEqual(['req-1']);
    expect(mint).not.toHaveBeenCalled();
    expect(convo).toBe(store.conversations.find((c) => c.id === 'req-1'));
    expect(store.dmWith(STRANGER)).toBe(convo);
    expect(store.pendingMessageRequestCount()).toBe(0);
  });

  it('answers a request once when two gestures arrive together', async () => {
    const { store, calls } = world({ conversations: [pending()] });
    const [first, second] = await Promise.all([
      store.startConversation([STRANGER]),
      store.startConversation([STRANGER]),
    ]);
    expect(calls.accept).toEqual(['req-1']);
    expect(calls.listed).toBe(1);
    expect(second).toBe(first);
    expect(first).toBe(store.conversations.find((c) => c.id === 'req-1'));
    expect(store.startingDms.size).toBe(0);
  });

  it('asks the server nothing when the one-to-one is already an ordinary DM', async () => {
    const { store, calls } = world({ conversations: [dm('dm-1', CAROL)] });
    const mint = vi.spyOn(store, 'mintConversation');
    expect((await store.startConversation([CAROL])).id).toBe('dm-1');
    expect(calls.accept).toEqual([]);
    expect(calls.listed).toBe(0);
    expect(mint).not.toHaveBeenCalled();
  });
});
