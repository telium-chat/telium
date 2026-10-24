import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer, HOME } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';
const BOB = '@bob:home.example';

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

async function boot({ friends = [], conversations = [] } = {}) {
  const server = createFakeServer({ friends, conversations });
  const { store, user } = await signedInApp(server);
  await user.click(await screen.findByTitle('Direct messages'));
  await waitFor(() => expect(store.friends.size).toBe(friends.length));
  return { server, store, user };
}

const rail = () => within(screen.getByText('Conversations').parentElement);

describe('the DM rail', () => {
  it('draws a one-to-one as the person: avatar, bubble, and custom status', async () => {
    await boot({
      friends: [friend(CAROL, {
        display_name: 'Carol',
        presence: { user_id: CAROL, status: 'online', custom_status: 'playing chess' },
      })],
      conversations: [convo('dm1', 'dm', [ME, CAROL])],
    });

    const row = rail().getByText('Carol').closest('button');
    expect(within(row).getByRole('img', { name: 'Online' })).toBeTruthy();
    expect(within(row).getByText('playing chess')).toBeTruthy();
  });

  it('takes View profile from a one-to-one rail context menu to the full profile', async () => {
    const { user } = await boot({
      friends: [friend(CAROL, { display_name: 'Carol' })],
      conversations: [convo('dm1', 'dm', [ME, CAROL])],
    });

    const row = rail().getByText('Carol').closest('button');
    fireEvent.contextMenu(row, { clientX: 120, clientY: 120 });
    await user.click(await screen.findByRole('menuitem', { name: 'View profile' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.closest('.popover')).toBeNull();
    expect(within(dialog).getByRole('tablist', { name: 'Profile sections' })).toBeTruthy();
  });

  it('keeps the glyph for a group, with no status line to misread', async () => {
    await boot({
      friends: [
        friend(BOB, { presence: { user_id: BOB, status: 'online', custom_status: 'busy' } }),
        friend(CAROL),
      ],
      conversations: [convo('gc1', 'gc', [ME, BOB, CAROL])],
    });

    const row = screen.getByText('bob, carol').closest('button');
    expect(row).toBeTruthy();
    expect(within(row).queryByText('busy')).toBeNull();
  });

  it('degrades to a bare avatar for someone the store knows nothing about', async () => {
    await boot({
      conversations: [convo('dm1', 'dm', [ME, '@stranger:elsewhere.example'])],
    });

    const row = rail().getByText('stranger').closest('button');
    expect(row).toBeTruthy();
    expect(within(row).queryByRole('img', { name: /Online|Idle|Offline/ })).toBeNull();
  });

  it('gives offline a mark of its own rather than one idle could be read as', async () => {
    await boot({
      friends: [
        friend(BOB, { display_name: 'Bob', presence: { user_id: BOB, status: 'offline' } }),
        friend(CAROL, { display_name: 'Carol', presence: { user_id: CAROL, status: 'idle' } }),
      ],
      conversations: [convo('dm1', 'dm', [ME, BOB]), convo('dm2', 'dm', [ME, CAROL])],
    });

    const bob = rail().getByText('Bob').closest('button');
    expect(within(bob).getByRole('img', { name: 'Offline' })).toBeTruthy();
    const carol = rail().getByText('Carol').closest('button');
    expect(within(carol).getByRole('img', { name: 'Idle' })).toBeTruthy();
    expect(within(carol).queryByRole('img', { name: 'Offline' })).toBeNull();
  });
});

describe('typing in the DM rail', () => {
  let server = null;
  const typingEvent = (op, conversationId, userId) => act(() => {
    server.dispatch(HOME, op, {
      conversation_id: conversationId, user_id: userId, timestamp: Date.now(),
    });
  });

  it('says typing in the status line, leaves the face alone, and goes back', async () => {
    ({ server } = await boot({
      friends: [friend(CAROL, { display_name: 'Carol' })],
      conversations: [convo('dm1', 'dm', [ME, CAROL])],
    }));

    const row = rail().getByText('Carol').closest('button');
    expect(within(row).getByRole('img', { name: 'Online' })).toBeTruthy();

    typingEvent('DM_TYPING_START', 'dm1', CAROL);

    expect(await within(row).findByText('typing')).toBeTruthy();
    expect(within(row).getByRole('img', { name: 'Online' })).toBeTruthy();
    expect(within(row).queryByRole('img', { name: /typing/ })).toBeNull();

    typingEvent('DM_TYPING_STOP', 'dm1', CAROL);
    await waitFor(() => expect(within(row).queryByText('typing')).toBeNull());
  });

  it('says so even when nobody has told us whether they are here', async () => {
    ({ server } = await boot({
      conversations: [convo('dm1', 'dm', [ME, '@stranger:elsewhere.example'])],
    }));

    const row = rail().getByText('stranger').closest('button');
    expect(within(row).queryByRole('img', { name: /Online|Idle|Offline/ })).toBeNull();

    typingEvent('DM_TYPING_START', 'dm1', '@stranger:elsewhere.example');

    expect(await within(row).findByText('typing')).toBeTruthy();
  });

  it('lights the row the typing was in and no other', async () => {
    ({ server } = await boot({
      friends: [
        friend(BOB, { display_name: 'Bob' }),
        friend(CAROL, { display_name: 'Carol' }),
      ],
      conversations: [convo('dm1', 'dm', [ME, BOB]), convo('dm2', 'dm', [ME, CAROL])],
    }));

    typingEvent('DM_TYPING_START', 'dm1', BOB);

    const bob = rail().getByText('Bob').closest('button');
    const carol = rail().getByText('Carol').closest('button');
    expect(await within(bob).findByText('typing')).toBeTruthy();
    expect(within(carol).queryByText('typing')).toBeNull();
  });
});
