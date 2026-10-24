import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';
const NADIA = '@nadia:elsewhere.example';

const friend = (userId, extra = {}) => ({
  user_id: userId,
  domain: userId.split(':')[1],
  state: 'accepted',
  presence: { user_id: userId, status: 'online' },
  display_name: null,
  avatar_ref: null,
  ...extra,
});

const convo = (id, kind, memberIds) => ({
  id,
  kind,
  sequencer: 'home.example',
  epoch: 1,
  last_seq: 0,
  members: memberIds.map((user_id) => ({ user_id, state: 'joined' })),
});

async function boot({ friends = [], conversations = [], profiles = {} } = {}) {
  const server = createFakeServer({ friends, conversations, profiles });
  const { store, user } = await signedInApp(server);
  await user.click(await screen.findByTitle('Direct messages'));
  await waitFor(() => expect(store.friends.size).toBe(friends.length));
  return { server, store, user };
}

const rail = () => within(screen.getByText('Conversations').parentElement);

describe('presence for non-friends in the DM rail', () => {
  it('asks a non-friend\'s profile once and draws what it carries', async () => {
    const { server } = await boot({
      conversations: [convo('dm1', 'dm', [ME, NADIA])],
      profiles: {
        [NADIA]: {
          user_id: NADIA,
          display_name: 'Nadia',
          presence: { user_id: NADIA, status: 'idle', custom_status: 'brewing coffee' },
        },
      },
    });

    const row = (await screen.findByText('Nadia')).closest('button');
    expect(within(row).getByRole('img', { name: 'Idle' })).toBeTruthy();
    expect(within(row).getByText('brewing coffee')).toBeTruthy();
    expect(server.state.profileHits).toEqual([NADIA]);
  });

  it('still draws friends off their list row without any profile ask', async () => {
    const { server } = await boot({
      friends: [friend(CAROL, {
        display_name: 'Carol',
        presence: { user_id: CAROL, status: 'dnd', custom_status: 'on call' },
      })],
      conversations: [convo('dm1', 'dm', [ME, CAROL])],
    });

    const row = rail().getByText('Carol').closest('button');
    expect(within(row).getByRole('img', { name: 'Do not disturb' })).toBeTruthy();
    expect(within(row).getByText('on call')).toBeTruthy();
    expect(server.state.profileHits).toEqual([]);
  });

  it('draws detected activity the way the member list does', async () => {
    await boot({
      friends: [friend(CAROL, {
        display_name: 'Carol',
        presence: { user_id: CAROL, status: 'online', activity: 'Minecraft' },
      })],
      conversations: [convo('dm1', 'dm', [ME, CAROL])],
    });

    const row = rail().getByText('Carol').closest('button');
    const verb = within(row).getByText('Playing');
    expect(verb.className).toContain('activity-note__verb');
    expect(within(row).getByText('Minecraft')).toBeTruthy();
  });

  it('re-renders without asking again', async () => {
    const { server, store } = await boot({
      conversations: [convo('dm1', 'dm', [ME, NADIA])],
      profiles: {
        [NADIA]: { user_id: NADIA, display_name: 'Nadia', presence: { user_id: NADIA, status: 'online' } },
      },
    });
    await screen.findByText('Nadia');
    expect(server.state.profileHits).toEqual([NADIA]);

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        store.navigate({ view: 'dms', conversationId: null });
        store.emit('conversations');
        store.emit('friends');
        store.navigate({ view: 'dms' });
      });
    }

    expect(server.state.profileHits).toEqual([NADIA]);
  });

  it('records a refused ask instead of retrying it on every redraw', async () => {
    const { server, store } = await boot({
      conversations: [convo('dm1', 'dm', [ME, NADIA])],
      profiles: { [NADIA]: null },
    });

    await waitFor(() => expect(server.state.profileHits).toEqual([NADIA]));

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        store.navigate({ view: 'dms', conversationId: null });
        store.emit('conversations');
        store.emit('friends');
        store.navigate({ view: 'dms' });
      });
    }

    expect(server.state.profileHits).toEqual([NADIA]);
    const row = screen.getByText('nadia').closest('button');
    expect(within(row).queryByRole('img', { name: /Online|Idle|Offline/ })).toBeNull();
  });
});
