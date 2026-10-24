import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer, GUILD } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const BOB = '@bob:home.example';
const CAROL = '@carol:other.example';

const friend = (userId, extra = {}) => ({
  user_id: userId,
  domain: userId.split(':')[1],
  state: 'accepted',
  presence: { user_id: userId, status: 'online' },
  display_name: null,
  avatar_ref: null,
  ...extra,
});

const railTile = () => screen.findByRole('button', { name: 'Telium on guilds.example' });

async function boot({ friends = [], members = [] } = {}) {
  const server = createFakeServer({ friends });
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await user.click(await railTile());
  await screen.findByText('first');

  if (members.length) {
    act(() => {
      server.dispatch(GUILD, 'MEMBER_LIST_UPDATE', {
        guild_id: 'g1',
        member_count: members.length + 1,
        online_count: members.length,
        ops: [{ op: 'SYNC', range: [0, 99], items: members }],
      });
    });
    await waitFor(() => expect(store.members.get('g1')?.size).toBe(members.length));
  }
  return { server, store, user };
}

async function openDialog(user, { create = true } = {}) {
  fireEvent.contextMenu(await railTile());
  await user.click(await screen.findByRole('menuitem', { name: 'Invite people' }));
  const dialog = await screen.findByRole('dialog');
  if (create) {
    await user.click(within(dialog).getByRole('button', { name: 'Create invite' }));
    await within(dialog).findByDisplayValue('guilds.example/invite/INVITE1');
  }
  return dialog;
}

describe('the invite dialog', () => {
  it('lets the quick guild menu choose expiry and use limits before creating', async () => {
    const { server, user } = await boot();
    const dialog = await openDialog(user, { create: false });

    expect(server.state.inviteCreates).toHaveLength(0);
    const expires = within(dialog).getByLabelText('Expires');
    expect(expires.textContent).toContain('1 day');
    expect(expires.textContent).not.toContain('86400');

    await user.type(within(dialog).getByLabelText('Maximum uses'), '5');
    await user.click(expires);
    await user.click(await screen.findByRole('option', { name: '1 week' }));
    expect(expires.textContent).toContain('1 week');
    expect(expires.textContent).not.toContain('604800');

    await user.click(within(dialog).getByRole('button', { name: 'Create invite' }));

    await waitFor(() => expect(server.state.inviteCreates).toHaveLength(1));
    expect(server.state.inviteCreates[0]).toEqual({
      max_uses: 5,
      expires_in_secs: 604800,
    });
    expect(await within(dialog).findByDisplayValue('guilds.example/invite/INVITE1')).toBeTruthy();
  });

  it('lists accepted friends beside the shareable link', async () => {
    const { user } = await boot({
      friends: [friend(BOB), friend(CAROL, { display_name: 'Carol' })],
    });
    const dialog = await openDialog(user);

    expect(within(dialog).getByDisplayValue('guilds.example/invite/INVITE1')).toBeTruthy();
    expect(await within(dialog).findByText('bob')).toBeTruthy();
    expect(within(dialog).getByText('Carol')).toBeTruthy();
    expect(within(dialog).getAllByRole('button', { name: 'Invite' })).toHaveLength(2);
  });

  it('marks friends already in the guild instead of offering them an invite', async () => {
    const { user } = await boot({
      friends: [friend(BOB), friend(CAROL)],
      members: [{ user_id: BOB, display_name: 'Bob', roles: ['g1'] }],
    });
    const dialog = await openDialog(user);

    await within(dialog).findByText('bob');
    expect(within(dialog).getByText('Already here')).toBeTruthy();
    expect(within(dialog).getAllByRole('button', { name: 'Invite' })).toHaveLength(1);
  });

  it('DMs the link once and marks the row invited', async () => {
    const { store, user } = await boot({ friends: [friend(CAROL)] });
    const start = vi.spyOn(store, 'startConversation')
      .mockResolvedValue({ id: 'dm1', kind: 'dm' });
    const dm = vi.spyOn(store, 'sendDm').mockResolvedValue({});

    const dialog = await openDialog(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Invite' }));

    await waitFor(() => expect(start).toHaveBeenCalledWith([CAROL]));
    await waitFor(() => expect(dm).toHaveBeenCalledWith('dm1', 'guilds.example/invite/INVITE1'));
    expect(await screen.findByText('Invite sent.')).toBeTruthy();

    const invited = await within(dialog).findByRole('button', { name: 'Invited' });
    expect(invited.disabled).toBe(true);
    await user.click(invited);
    expect(start).toHaveBeenCalledTimes(1);
    expect(dm).toHaveBeenCalledTimes(1);
  });

  it('says what to do when there is nobody on the friends list', async () => {
    const { user } = await boot();
    const dialog = await openDialog(user);

    expect(within(dialog).getByDisplayValue('guilds.example/invite/INVITE1')).toBeTruthy();
    expect(within(dialog).getByText(/no friends yet/i)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Invite' })).toBeNull();
  });
});
