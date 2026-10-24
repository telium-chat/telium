import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer } from './fake-server.js';
import { signedInApp } from './harness.jsx';

async function boot() {
  const server = createFakeServer();
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  return { server, store, user };
}

const rail = () => within(document.querySelector('[class*="w-[248px]"]'));

const row = (name) => rail().getByRole('button', { name: new RegExp(`^${name}(?! settings)`) });

async function closeDialog(user) {
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

async function fromMenu(user, channel, item) {
  fireEvent.contextMenu(row(channel));
  await user.click(await screen.findByRole('menuitem', { name: item }));
  return screen.findByRole('dialog');
}

describe('the channel editor', () => {
  it('shows what the channel is, and sends only what changed', async () => {
    const { server, user } = await boot();

    await fromMenu(user, 'general', 'Edit channel');

    const name = screen.getByLabelText('Name');
    expect(name.value).toBe('general');
    expect(screen.getByLabelText('Topic').value).toBe('The first channel');

    await user.clear(name);
    await user.type(name, 'general-chat');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(
      server.state.guild.channels.find((c) => c.id === 'c1').name,
    ).toBe('general-chat'));
    expect(server.state.channelPatches).toEqual([{ name: 'general-chat' }]);
    await waitFor(() => expect(row('general-chat')).toBeTruthy());
  });

  it('makes a channel private by taking the view away from @everyone', async () => {
    const { server, store, user } = await boot();

    await fromMenu(user, 'general', 'Edit permissions');
    await user.click(screen.getByRole('switch', { name: 'Private channel' }));

    await waitFor(() => {
      const [over] = server.state.guild.channels.find((c) => c.id === 'c1').permission_overwrites;
      expect(over).toMatchObject({ target_type: 'role', target_id: 'g1', deny: '1' });
    });

    await closeDialog(user);
    await waitFor(() => expect(within(row('general')).getByText('Private')).toBeTruthy());

    await fromMenu(user, 'general', 'Edit permissions');
    await user.click(screen.getByRole('switch', { name: 'Private channel' }));
    await waitFor(() => {
      const [over] = server.state.guild.channels.find((c) => c.id === 'c1').permission_overwrites;
      expect(over.deny).toBe('0');
    });
    expect(store.channels.get('c1').permission_overwrites).toHaveLength(1);
    await closeDialog(user);
    await waitFor(() => expect(within(row('general')).queryByText('Private')).toBeNull());
  });

  it('offers the chat permissions on a voice channel, and the call ones', async () => {
    const { user } = await boot();

    await fromMenu(user, 'lounge', 'Edit permissions');

    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Send Messages' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Speak' })).toBeTruthy();
  });
});
