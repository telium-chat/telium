import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer, GUILD } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import {
  mayDropAt, mayHold, moveRole, rankedRoles, rolePlacements, roleMoves,
} from '../lib/roles.js';
import { PERMISSIONS, PERMISSION_GROUPS, permissionInfo } from '../lib/perms.js';

const G = 'GUILD';
const at = (position, id) => ({ id, position, name: id });
const ids = (list) => list.map((r) => r.id).join('');

describe('the hierarchy is one list, and @everyone is its floor', () => {
  const roles = [at(0, G), at(2, 'b'), at(3, 'a'), at(1, 'c')];

  it('ranks the movable roles highest first and leaves @everyone out of them', () => {
    const list = rankedRoles(roles, G);
    expect(ids(list)).toBe('abc');
    expect(list.some((r) => r.id === G)).toBe(false);
  });

  it('numbers a rearranged list down to the step above @everyone', () => {
    const list = rankedRoles(roles, G);
    expect(rolePlacements(list)).toEqual([
      { id: 'a', position: 3 }, { id: 'b', position: 2 }, { id: 'c', position: 1 },
    ]);
    expect(rolePlacements(list).every((p) => p.position >= 1)).toBe(true);
  });

  it('moves a role to the gap that was aimed at, not the one that opened up', () => {
    const list = rankedRoles(roles, G);
    expect(ids(moveRole(list, 'c', 0))).toBe('cab');
    expect(ids(moveRole(list, 'a', 3))).toBe('bca');
    expect(ids(moveRole(list, 'a', 1))).toBe('abc');
    expect(ids(moveRole(list, 'a', 2))).toBe('bac');
  });

  it('sends only the roles that are not already where the guild thinks they are', () => {
    const list = rankedRoles(roles, G);
    expect(roleMoves(list)).toEqual([]);
    expect(roleMoves(moveRole(list, 'c', 0))).toEqual([
      { id: 'c', position: 3 }, { id: 'a', position: 2 }, { id: 'b', position: 1 },
    ]);
  });

  it('lets nobody but the owner reach over their own head', () => {
    const list = rankedRoles(roles, G);
    const me = { top_role_position: 2 };
    expect([mayHold(me, list[0]), mayHold(me, list[1]), mayHold(me, list[2])])
      .toEqual([false, false, true]);

    expect([0, 1, 2, 3].map((gap) => mayDropAt(me, list, 'c', gap)))
      .toEqual([false, false, true, true]);

    const owner = { is_owner: true };
    expect([0, 1, 2, 3].map((gap) => mayDropAt(owner, list, 'c', gap)))
      .toEqual([true, true, true, true]);
  });
});

describe('every permission says what it is', () => {
  it('gives all of them a human name, a sentence and a group that is drawn', () => {
    const groups = new Set(PERMISSION_GROUPS.map(([key]) => key));
    for (const name of PERMISSIONS) {
      const info = permissionInfo(name);
      expect(info.label, name).toBeTruthy();
      expect(info.label, name).not.toBe(name);
      expect(info.hint, name).toBeTruthy();
      expect(groups.has(info.group), `${name} in ${info.group}`).toBe(true);
    }
  });

  it('falls back to the bit-s own name rather than crashing on one it has never heard of', () => {
    const info = permissionInfo('SUMMON_KRAKEN');
    expect(info.label).toBe('SUMMON_KRAKEN');
    expect(PERMISSION_GROUPS.some(([key]) => key === info.group)).toBe(true);
  });
});

async function openGuild() {
  const server = createFakeServer();
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  await user.click(await screen.findByRole('button', { name: 'general' }));
  await screen.findByRole('button', { name: 'Guild menu' });
  return { server, store, user };
}

async function openGuildSettings(user) {
  await user.click(await screen.findByRole('button', { name: 'Guild menu' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Server settings' }));
}

async function openRoles() {
  const opened = await openGuild();
  await openGuildSettings(opened.user);
  const dialog = await screen.findByRole('dialog');
  await opened.user.click(
    await within(dialog).findByRole('button', { name: 'Roles' }, { timeout: 5000 }),
  );
  return { ...opened, dialog };
}

describe('the roles pane', () => {
  it('draws the hierarchy with what each rung means and who is standing on it', async () => {
    const { dialog } = await openRoles();

    await within(dialog).findByText('Default Permissions');
    await within(dialog).findByText('@everyone');
    await within(dialog).findByText('Moderator');
    await within(dialog).findByText('2 members');
    expect(within(dialog).getByText('Roles - 1')).toBeTruthy();
  });

  it('names the permissions in the editor instead of quoting the constant', async () => {
    const { user, dialog } = await openRoles();
    await user.click(await within(dialog).findByText('Moderator'));

    await within(dialog).findByRole('tab', { name: 'Permissions' });
    await user.click(within(dialog).getByRole('tab', { name: 'Permissions' }));

    const manage = await within(dialog).findByText('Manage Messages');
    expect(manage).toBeTruthy();
    expect(within(dialog).getByText('Delete and pin anyone’s messages.')).toBeTruthy();
    expect(within(dialog).getByText('General Server Permissions')).toBeTruthy();
    expect(within(dialog).queryByText('MANAGE_MESSAGES')).toBeNull();
  });

  it('says there is something unsaved, and sends only what was changed', async () => {
    const { server, user, dialog } = await openRoles();
    await user.click(await within(dialog).findByText('Moderator'));
    await user.click(await within(dialog).findByRole('tab', { name: 'Permissions' }));

    expect(within(dialog).queryByText(/unsaved changes/)).toBeNull();

    await user.click(await within(dialog).findByRole('switch', { name: 'Kick Members' }));
    await within(dialog).findByText(/unsaved changes/);

    await user.click(within(dialog).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(within(dialog).queryByText(/unsaved changes/)).toBeNull());

    await user.click(await within(dialog).findByRole('switch', { name: 'Kick Members' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(server.state.rolePatches.length).toBe(1));
    const [patch] = server.state.rolePatches;
    expect(patch.id).toBe('r1');
    expect(patch.permissions).toContain('KICK_MEMBERS');
    expect(patch.permissions).toContain('MANAGE_MESSAGES');
  });

  it('turns off every other switch once Administrator is on, because it already grants them', async () => {
    const { user, dialog } = await openRoles();
    await user.click(await within(dialog).findByText('Moderator'));
    await user.click(await within(dialog).findByRole('tab', { name: 'Permissions' }));

    const kick = await within(dialog).findByRole('switch', { name: 'Kick Members' });
    expect(kick.disabled).toBe(false);

    await user.click(await within(dialog).findByRole('switch', { name: 'Administrator' }));
    await within(dialog).findByText(/Administrator is every permission/);
    await waitFor(() => expect(
      within(dialog).getByRole('switch', { name: 'Kick Members' }).disabled,
    ).toBe(true));
  });

  it('asks the guild who holds a role rather than filtering whatever it had loaded', async () => {
    const { user, dialog } = await openRoles();
    await user.click(await within(dialog).findByText('Moderator'));
    await user.click(await within(dialog).findByRole('tab', { name: 'Manage Members' }));

    await within(dialog).findByText('Holding Moderator - 1');
    await within(dialog).findByText('@bob:home.example');
    expect(within(dialog).queryByText('@alice:home.example')).toBeNull();

    await user.type(within(dialog).getByLabelText('Search members to add'), 'alice');
    await within(dialog).findByText('@alice:home.example');
    await user.click(await within(dialog).findByRole('button', { name: 'Add' }));
    await within(dialog).findByText('Holding Moderator - 2');
  });
});

describe('the roles on a profile card', () => {
  async function openCard(user, server, roles) {
    act(() => {
      server.dispatch(GUILD, 'MEMBER_LIST_UPDATE', {
        guild_id: 'g1',
        member_count: 2,
        online_count: 1,
        ops: [{
          op: 'SYNC',
          range: [0, 99],
          items: [{ user_id: '@bob:home.example', display_name: 'Bob', roles }],
        }],
      });
    });
    const members = await screen.findByRole('complementary', { name: 'Members' });
    await user.click(await within(members).findByText('Bob'));
    return screen.findByRole('dialog');
  }

  it('offers the way in to a role even when the member holds none', async () => {
    const { server, user } = await openGuild();
    const card = await openCard(user, server, ['g1']);

    expect(within(card).queryByText('No roles yet.')).toBeNull();
    const add = within(card).getByRole('button', { name: 'Add a role to Bob' });
    expect(add.textContent).toContain('Add role');
    await user.click(add);

    const picker = await screen.findByRole('dialog', { name: 'Add a role' });
    await within(picker).findByRole('switch', { name: /Moderator/ });
    expect(within(picker).queryByText('@everyone')).toBeNull();
  });

  it('hands a role over and shows it as worn', async () => {
    const { server, user } = await openGuild();
    const card = await openCard(user, server, ['g1']);
    await user.click(await within(card).findByRole('button', { name: 'Add a role to Bob' }));

    const row = await screen.findByRole('switch', { name: /Moderator/ });
    expect(row.getAttribute('aria-checked')).toBe('false');
    await user.click(row);
    await waitFor(() => expect(
      screen.getByRole('switch', { name: /Moderator/ }).getAttribute('aria-checked'),
    ).toBe('true'));

    expect(server.state.members.find((m) => m.user_id === '@bob:home.example').roles)
      .toContain('r1');
  });

  it('wears a role it already holds as a coloured pill', async () => {
    const { server, user } = await openGuild();
    const card = await openCard(user, server, ['g1', 'r1']);
    const chip = (await within(card).findByText('Moderator')).closest('.pc__role');
    expect(chip.getAttribute('data-coloured')).toBe('true');
    expect(within(card).queryByText('No roles yet.')).toBeNull();
    expect(within(card).getByRole('button', { name: 'Add a role to Bob' })).toBeTruthy();
  });
});
