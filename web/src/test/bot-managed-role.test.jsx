import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RolesPopover } from '../views/profile/RolesPopover.jsx';
import { createFakeServer, GUILD } from './fake-server.js';
import { signedInApp } from './harness.jsx';

describe('the role picker offers only roles a person can be given', () => {
  it('leaves out @everyone and the role an installed bot owns', () => {
    const roles = [
      { id: 'g1', name: '@everyone', color: 0, position: 0 },
      { id: 'r1', name: 'Moderator', color: 0, position: 1 },
      { id: 'rb', name: 'Ping Bot', color: 0, position: 2, managed: true },
    ];
    const store = {
      roleList: () => roles,
      myMember: () => ({ is_owner: true, top_role_position: 0 }),
    };

    const anchor = document.createElement('button');
    document.body.appendChild(anchor);

    render(
      <RolesPopover
        store={store}
        guildId="g1"
        anchor={anchor}
        held={[]}
        busy={null}
        onToggle={vi.fn()}
        close={vi.fn()}
        leaving={false}
        onLeft={vi.fn()}
      />,
    );

    const rows = screen.getAllByRole('switch').map((el) => el.textContent);
    expect(rows).toEqual(['Moderator']);
    expect(screen.queryByRole('switch', { name: 'Ping Bot' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '@everyone' })).toBeNull();
  });
});

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
          { user_id: '@ada:home.example', display_name: 'Ada', roles: [], presence: { status: 'online' } },
          {
            user_id: '@ping:bots.example',
            display_name: 'Ping Bot',
            roles: [],
            is_bot: true,
            presence: { status: 'online' },
          },
        ],
      }],
    });
  });

  const members = await screen.findByRole('complementary', { name: 'Members' });
  const rowFor = async (name) => (await within(members).findByText(name)).closest('button');
  return { server, store, user, members, rowFor };
}

const menuLabels = async () => (await screen.findAllByRole('menuitem')).map((el) => el.textContent);

const dismissMenu = async (user) => {
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));
};

describe('the member menu treats a bot as an installation, not as somebody to moderate', () => {
  it('drops Kick and Ban for a bot and offers the route to its settings instead', async () => {
    const { user, members, rowFor } = await boot();

    const bot = await rowFor('Ping Bot');
    expect(within(bot).getByText('BOT')).toBeTruthy();
    expect(within(await rowFor('Ada')).queryByText('BOT')).toBeNull();

    fireEvent.contextMenu(await rowFor('Ada'));
    const forPerson = await menuLabels();
    expect(forPerson).toContain('Kick member');
    expect(forPerson).toContain('Ban member');
    expect(forPerson).not.toContain('Manage this bot');
    await dismissMenu(user);

    fireEvent.contextMenu(await rowFor('Ping Bot'));
    const forBot = await menuLabels();
    expect(forBot).not.toContain('Kick member');
    expect(forBot).not.toContain('Ban member');
    expect(forBot).toContain('Manage this bot');

    await user.click(await screen.findByRole('menuitem', { name: 'Manage this bot' }));
    const settings = await screen.findByRole('dialog', {}, { timeout: 5000 });
    await within(settings).findByText('Install bot', {}, { timeout: 5000 });
    expect(members).toBeTruthy();
  });
});
