import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer, HOME } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const row = (userId, state, presence = null) => ({
  user_id: userId,
  domain: userId.split(':')[1],
  state,
  presence,
  display_name: null,
  avatar_ref: null,
});

const BOB = '@bob:home.example';
const CAROL = '@carol:other.example';

async function boot(friends = []) {
  const server = createFakeServer({ friends });
  const { store, user } = await signedInApp(server);
  await user.click(await screen.findByTitle('Direct messages'));
  await user.click(await screen.findByRole('button', { name: /^Friends/ }));
  return { server, store, user };
}

const tab = (user, name) => user.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));

const pane = () => within(screen.getByLabelText('Add friend').closest('form').parentElement);

describe('the friends list', () => {
  it('sorts one list into four tabs and badges only what is waiting on you', async () => {
    const { user } = await boot([
      row(BOB, 'accepted', { user_id: BOB, status: 'online' }),
      row('@dan:home.example', 'accepted'),
      row(CAROL, 'pending_in'),
      row('@erin:home.example', 'pending_out'),
      row('@mallory:home.example', 'blocked'),
    ]);

    expect(await pane().findByText('bob')).toBeTruthy();
    expect(pane().queryByText('dan')).toBeNull();

    await tab(user, 'All');
    expect(await pane().findByText('dan')).toBeTruthy();
    expect(pane().getByText('bob')).toBeTruthy();
    expect(pane().queryByText('carol')).toBeNull();

    await tab(user, 'Pending');
    expect(await pane().findByText('carol')).toBeTruthy();
    expect(pane().getByText('erin')).toBeTruthy();
    expect(pane().getByText('Waiting on you - 1')).toBeTruthy();
    expect(pane().getByText('Waiting on them - 1')).toBeTruthy();

    await tab(user, 'Blocked');
    expect(await pane().findByText('mallory')).toBeTruthy();

    const friends = screen.getByRole('button', { name: /^Friends/ });
    expect(friends.textContent).toBe('Friends1');
  });

  it('says which tab is selected rather than only shading it', async () => {
    const { user } = await boot([row(BOB, 'accepted')]);
    const pressed = () => screen.getAllByRole('button', { pressed: true })
      .map((b) => b.textContent);

    expect(pressed()).toEqual(['Online']);

    await tab(user, 'All');
    await waitFor(() => expect(pressed()).toEqual(['All']));
    expect(screen.getByRole('button', { name: 'Online' }).getAttribute('aria-pressed'))
      .toBe('false');
  });

  it('adds someone on another server by their full id', async () => {
    const { server, store, user } = await boot();
    expect(await screen.findByText('None of your friends are online right now.')).toBeTruthy();

    await user.type(screen.getByLabelText('Add friend'), CAROL);
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => expect(store.friends.get(CAROL)?.state).toBe('pending_out'));
    expect(await screen.findByText('Request sent.')).toBeTruthy();
    expect(server.state.friends).toEqual([
      expect.objectContaining({ user_id: CAROL, domain: 'other.example', state: 'pending_out' }),
    ]);

    await tab(user, 'Pending');
    expect(await screen.findByText('carol')).toBeTruthy();
  });

  it('turns a crossing pair of requests into a friendship rather than a duplicate', async () => {
    const { server, store, user } = await boot([row(CAROL, 'pending_in')]);

    await user.type(screen.getByLabelText('Add friend'), CAROL);
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => expect(store.friends.get(CAROL)?.state).toBe('accepted'));
    expect(await screen.findByText('You and carol are now friends.')).toBeTruthy();
    expect(store.friends.size).toBe(1);
    expect(server.state.friends).toHaveLength(1);
  });

  it('accepts a request from the row it arrived on', async () => {
    const { server, store, user } = await boot([row(CAROL, 'pending_in')]);

    await tab(user, 'Pending');
    await user.click(await screen.findByTitle('Accept'));

    await waitFor(() => expect(store.friends.get(CAROL)?.state).toBe('accepted'));
    expect(server.state.friends[0].state).toBe('accepted');
    await tab(user, 'All');
    expect(await pane().findByText('carol')).toBeTruthy();
  });

  it('withdraws an outgoing request through the row menu', async () => {
    const { server, store, user } = await boot([row(CAROL, 'pending_out')]);

    await tab(user, 'Pending');
    fireEvent.contextMenu(await screen.findByText('carol'));
    await user.click(await screen.findByRole('menuitem', { name: 'Withdraw request' }));
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));

    await waitFor(() => expect(store.friends.has(CAROL)).toBe(false));
    expect(server.state.friends).toEqual([]);
  });

  it('blocks from the row and lets the block be lifted', async () => {
    const { server, store, user } = await boot([row(BOB, 'accepted', { status: 'online' })]);

    await user.click(await screen.findByTitle('Block'));
    await waitFor(() => expect(store.friends.get(BOB)?.state).toBe('blocked'));
    expect(screen.queryByText('bob')).toBeNull();

    await tab(user, 'Blocked');
    await user.click(await screen.findByTitle('Unblock'));
    await waitFor(() => expect(store.friends.has(BOB)).toBe(false));
    expect(server.state.friends).toEqual([]);
  });

  it('shows a friend coming online with no guild in common', async () => {
    const { server, store, user } = await boot([row(BOB, 'accepted')]);

    expect(await pane().findByText('None of your friends are online right now.')).toBeTruthy();
    await tab(user, 'All');
    expect(await pane().findByText('bob')).toBeTruthy();

    act(() => {
      server.dispatch(HOME, 'PRESENCE_UPDATE', {
        user_id: BOB, status: 'online', custom_status: 'writing tests', activity: null,
      });
    });
    await waitFor(() => expect(store.statusOf(BOB)).toBe('online'));

    await tab(user, 'Online');
    expect(await pane().findByText('bob')).toBeTruthy();
    expect(pane().getByText('writing tests')).toBeTruthy();
  });

  it('takes a row away when another device ends the friendship', async () => {
    const { server, store, user } = await boot([row(BOB, 'accepted', { status: 'online' })]);
    expect(await pane().findByText('bob')).toBeTruthy();

    act(() => { server.dispatch(HOME, 'FRIEND_REMOVE', { user_id: BOB }); });
    await waitFor(() => expect(store.friends.has(BOB)).toBe(false));
    expect(pane().queryByText('bob')).toBeNull();

    act(() => {
      server.dispatch(HOME, 'FRIEND_UPDATE', { user_id: CAROL, state: 'pending_in' });
    });
    await waitFor(() => expect(store.pendingFriendCount()).toBe(1));
    await tab(user, 'Pending');
    expect(await pane().findByText('carol')).toBeTruthy();
  });

  it('opens the card of somebody whose request is still waiting on you', async () => {
    const { user } = await boot([row(CAROL, 'pending_in')]);

    await tab(user, 'Pending');
    await user.click(pane().getByText('carol'));

    const card = await screen.findByRole('dialog');
    expect(within(card).getByRole('heading', { name: 'carol' })).toBeTruthy();
  });

  it('opens a conversation through the same call the DM sidebar uses', async () => {
    const { store, user } = await boot([row(BOB, 'accepted', { status: 'online' })]);
    const start = vi.spyOn(store, 'startConversation')
      .mockResolvedValue({ id: 'dm1', kind: 'dm' });

    await user.click(await screen.findByTitle('Message'));

    await waitFor(() => expect(start).toHaveBeenCalledWith([BOB]));
    expect(store.route).toMatchObject({ view: 'dms', conversationId: 'dm1' });
  });
});
