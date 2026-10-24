import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer, freshStore } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import { participants } from '../lib/util.js';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';
const NADIA = '@nadia:elsewhere.example';

const group = (memberIds) => ({
  id: 'gc1',
  kind: 'gc',
  sequencer: 'home.example',
  creator: ME,
  epoch: 1,
  last_seq: 0,
  members: memberIds.map((user_id) => ({ user_id, state: 'joined' })),
});

const departure = (userId, conversationId = 'gc1') => ({
  domain: 'home.example',
  t: 'DM_MEMBER_LEAVE',
  d: { conversation_id: conversationId, user_id: userId },
});

async function boot({ conversations = [group([ME, CAROL, NADIA])] } = {}) {
  const server = createFakeServer({ conversations });
  const { store, user } = await signedInApp(server);
  await user.click(await screen.findByTitle('Direct messages'));
  await waitFor(() => expect(store.conversations.length).toBe(conversations.length));
  const asked = vi.spyOn(store.home, 'conversations');
  return { server, store, user, asked };
}

describe('somebody else leaves a conversation you are looking at', () => {
  it('takes them off the member list without asking the server again', async () => {
    const { store, user, asked } = await boot();
    await user.click(await screen.findByText('carol, nadia'));
    await user.click(await screen.findByTitle('Conversation details'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(NADIA)).toBeTruthy();

    act(() => store.onDispatch(departure(NADIA)));

    await waitFor(() => expect(within(dialog).queryByText(NADIA)).toBeNull());
    expect(within(dialog).getByText(CAROL)).toBeTruthy();
    expect(asked).not.toHaveBeenCalled();
  });

  it('redraws the participant count everywhere it is shown', async () => {
    const { store, user } = await boot();
    await user.click(await screen.findByText('carol, nadia'));
    expect(await screen.findByText('Group - 3 people')).toBeTruthy();

    act(() => store.onDispatch(departure(NADIA)));

    await waitFor(() => expect(screen.getByText('Group - 2 people')).toBeTruthy());
    expect(screen.getByText('carol')).toBeTruthy();
    expect(screen.queryByText('carol, nadia')).toBeNull();
  });

  it('keeps the row, marked with how they went, rather than forgetting them', () => {
    const store = freshStore();
    store.me = { user_id: ME };
    store.conversations = [group([ME, CAROL, NADIA])];

    store.onDmLeave({ conversation_id: 'gc1', user_id: NADIA });

    const convo = store.conversations[0];
    expect(convo.members.find((m) => m.user_id === NADIA).state).toBe('left');
    expect(participants(convo).map((m) => m.user_id)).toEqual([ME, CAROL]);
  });

  it('does not turn a member a commit removed into one who walked out', () => {
    const store = freshStore();
    store.me = { user_id: ME };
    store.conversations = [{
      ...group([ME, CAROL]),
      members: [
        { user_id: ME, state: 'joined' },
        { user_id: CAROL, state: 'removed' },
      ],
    }];
    const heard = vi.fn();
    store.on('conversations', heard);

    store.onDmLeave({ conversation_id: 'gc1', user_id: CAROL });

    expect(store.conversations[0].members[1].state).toBe('removed');
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('you leave on one device', () => {
  it('takes the conversation off this device too, without a refetch', async () => {
    const { store, user, asked } = await boot();
    await user.click(await screen.findByText('carol, nadia'));
    await waitFor(() => expect(store.route.conversationId).toBe('gc1'));

    act(() => store.onDispatch(departure(ME)));

    await waitFor(() => expect(screen.queryByText('carol, nadia')).toBeNull());
    expect(store.conversations).toEqual([]);
    expect(store.route.conversationId).toBe(null);
    expect(asked).not.toHaveBeenCalled();
  });

  it('forgets the group keys the departed conversation held', () => {
    const store = freshStore();
    store.me = { user_id: ME };
    store.conversations = [group([ME, CAROL])];
    store.dmUnread.set('gc1', 3);
    const forget = vi.fn(async () => {});
    store.mls = { forget };

    store.onDmLeave({ conversation_id: 'gc1', user_id: ME });

    expect(forget).toHaveBeenCalledWith('gc1');
    expect(store.dmUnread.has('gc1')).toBe(false);
  });

  it('ignores a departure from a conversation it does not have', () => {
    const store = freshStore();
    store.me = { user_id: ME };
    store.conversations = [];
    const heard = vi.fn();
    store.on('conversations', heard);

    store.onDmLeave({ conversation_id: 'nope', user_id: CAROL });

    expect(store.conversations).toEqual([]);
    expect(heard).not.toHaveBeenCalled();
  });
});
