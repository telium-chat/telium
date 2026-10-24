import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeServer } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';

const URL = 'guilds.example/invite/INVITE1';

const friend = (userId, extra = {}) => ({
  user_id: userId,
  domain: userId.split(':')[1],
  state: 'accepted',
  presence: { user_id: userId, status: 'online' },
  display_name: null,
  avatar_ref: null,
  ...extra,
});

const dmWith = (id, other) => ({
  id,
  kind: 'dm',
  sequencer: 'home.example',
  epoch: 1,
  last_seq: 0,
  members: [
    { user_id: ME, state: 'joined' },
    { user_id: other, state: 'joined' },
  ],
});

async function boot({ conversations = [] } = {}) {
  const server = createFakeServer({ friends: [friend(CAROL)], conversations });
  const { store, user } = await signedInApp(server);
  await waitFor(() => expect(store.mls).toBeTruthy());
  await act(async () => { await store.addServer('guilds.example'); });
  const tile = await screen.findByRole('button', { name: 'Telium on guilds.example' });
  await user.click(tile);
  fireEvent.contextMenu(tile);
  await user.click(await screen.findByRole('menuitem', { name: 'Invite people' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Create invite' }));
  await within(dialog).findByDisplayValue(URL);
  return { server, store, user, dialog };
}

describe('one DM per person', () => {
  it('invites into the DM that already exists instead of opening another', async () => {
    const { store, dialog } = await boot({ conversations: [dmWith('dm-carol', CAROL)] });
    const create = vi.spyOn(store.home, 'createConversation');
    vi.spyOn(store, 'sendDm').mockResolvedValue({});

    await userEvent.click(await within(dialog).findByRole('button', { name: 'Invite' }));

    await waitFor(() => expect(store.sendDm)
      .toHaveBeenCalledWith('dm-carol', URL));
    expect(create).not.toHaveBeenCalled();
    await screen.findByText('Invite sent.');
  });

  it('still opens a first DM for a friend who has none yet', async () => {
    const { store, dialog } = await boot();
    vi.spyOn(store.home, 'createConversation')
      .mockResolvedValue(dmWith('dm-new', CAROL));
    vi.spyOn(store.mls, 'establish').mockResolvedValue({ welcome: null, missing: [] });
    vi.spyOn(store, 'sendDm').mockResolvedValue({});

    await userEvent.click(await within(dialog).findByRole('button', { name: 'Invite' }));

    await waitFor(() => expect(store.sendDm).toHaveBeenCalledWith('dm-new', URL));
    expect(store.home.createConversation).toHaveBeenCalledTimes(1);
    expect(store.home.createConversation).toHaveBeenCalledWith(
      { kind: 'dm', members: [CAROL] },
    );
  });

  it('joins the DM already being created instead of starting a second', async () => {
    const { store } = await boot();
    let answer;
    const held = new Promise((resolve) => { answer = resolve; });
    const create = vi.spyOn(store.home, 'createConversation').mockReturnValue(held);
    vi.spyOn(store.mls, 'establish').mockResolvedValue({ welcome: null, missing: [] });

    const first = store.startConversation([CAROL]);
    const second = store.startConversation([CAROL]);
    answer(dmWith('dm-new', CAROL));
    const [one, two] = await Promise.all([first, second]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(one.id).toBe('dm-new');
    expect(two).toBe(one);
    expect(store.startingDms.size).toBe(0);
  });

  it('forgets a DM that failed to start so the next press is a real attempt', async () => {
    const { store } = await boot();
    vi.spyOn(store.home, 'createConversation').mockRejectedValue(new Error('offline'));

    await expect(store.startConversation([CAROL])).rejects.toThrow('offline');

    expect(store.startingDms.size).toBe(0);
  });
});
