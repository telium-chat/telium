import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { createFakeServer, GUILD } from './fake-server.js';
import { signedInApp } from './harness.jsx';

async function boot() {
  const server = createFakeServer();
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  await screen.findByText('first');

  act(() => {
    server.dispatch(GUILD, 'MEMBER_LIST_UPDATE', {
      guild_id: 'g1',
      member_count: 1,
      online_count: 1,
      ops: [{
        op: 'SYNC',
        range: [0, 99],
        items: [{
          user_id: '@bob:home.example', display_name: 'Bob', roles: [],
          joined_at: 1_542_492_000_000,
        }],
      }],
    });
  });

  const members = await screen.findByRole('complementary', { name: 'Members' });
  const row = async () => (await within(members).findByText('Bob')).closest('button');
  return { store, user, row };
}

describe('View profile off a member rail row', () => {
  it('opens the whole profile rather than the card on the way to it', async () => {
    const { user, row } = await boot();

    fireEvent.contextMenu(await row());
    await user.click(await screen.findByRole('menuitem', { name: 'View profile' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.closest('.popover')).toBeNull();
    expect(within(dialog).getByRole('tablist', { name: 'Profile sections' })).toBeTruthy();
    expect(within(dialog).getByText(/Member since/)).toBeTruthy();
  });
});
