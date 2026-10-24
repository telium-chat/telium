import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer, GUILD } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const HELD = 'bg-accent-soft';

const held = (row) => row.className.includes(HELD);

async function boot() {
  const server = createFakeServer();
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  await screen.findByText('first');

  act(() => {
    server.dispatch(GUILD, 'MEMBER_LIST_UPDATE', {
      guild_id: 'g1',
      member_count: 2,
      online_count: 2,
      ops: [{
        op: 'SYNC',
        range: [0, 99],
        items: [
          { user_id: '@bob:home.example', display_name: 'Bob', roles: [], presence: { status: 'online' } },
          { user_id: '@ada:home.example', display_name: 'Ada', roles: [], presence: { status: 'online' } },
        ],
      }],
    });
  });

  const members = await screen.findByRole('complementary', { name: 'Members' });
  const rowFor = async (name) => (await within(members).findByText(name)).closest('button');
  return {
    server, store, user, members, rowFor,
  };
}

describe('the member rail holds the row whose card is open', () => {
  it('lights the row it opened, and only that row', async () => {
    const { user, rowFor } = await boot();
    const bob = await rowFor('Bob');
    const ada = await rowFor('Ada');

    expect(held(bob)).toBe(false);
    expect(bob.getAttribute('aria-haspopup')).toBe('dialog');
    expect(bob.getAttribute('aria-expanded')).toBe('false');

    await user.click(bob);
    await screen.findByRole('dialog');
    await waitFor(() => expect(held(bob)).toBe(true));
    expect(held(ada)).toBe(false);
    expect(bob.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes the card and lets go of the row when the same row is clicked again', async () => {
    const { user, rowFor } = await boot();
    const bob = await rowFor('Bob');

    await user.click(bob);
    await screen.findByRole('dialog');
    await waitFor(() => expect(held(bob)).toBe(true));

    fireEvent.pointerDown(bob);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeNull());
    fireEvent.pointerUp(bob);
    fireEvent.click(bob);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(held(bob)).toBe(false);
    expect(bob.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves both the card and the highlight when a different row is clicked', async () => {
    const { user, rowFor } = await boot();
    const bob = await rowFor('Bob');
    const ada = await rowFor('Ada');

    await user.click(bob);
    await waitFor(() => expect(held(bob)).toBe(true));

    await user.click(ada);
    await waitFor(() => expect(held(ada)).toBe(true));
    expect(held(bob)).toBe(false);
    const card = await screen.findByRole('dialog');
    expect(within(card).queryByText('Bob')).toBeNull();
  });

  it('lets go of the row when Escape takes the card away', async () => {
    const { user, rowFor } = await boot();
    const bob = await rowFor('Bob');

    await user.click(bob);
    await screen.findByRole('dialog');
    await waitFor(() => expect(held(bob)).toBe(true));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(held(bob)).toBe(false);
  });

  it('toggles from the keyboard the same way it toggles from the pointer', async () => {
    const { user, rowFor } = await boot();
    const bob = await rowFor('Bob');

    bob.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog');
    await waitFor(() => expect(held(bob)).toBe(true));

    bob.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(held(bob)).toBe(false);
  });
});
