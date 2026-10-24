import { describe, expect, it } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import {
  channelMoves, channelTree, moveCategory, moveChannel, placements,
} from '../lib/channels.js';
import { createFakeServer } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const shape = (tree) => [
  ...tree.loose.map((c) => c.id),
  ...tree.groups.flatMap((g) => [`[${g.category.id}]`, ...g.items.map((c) => `  ${c.id}`)]),
];

const ch = (id, at, parent = null) => ({
  id, name: id, type: 'text', position: at, parent_id: parent, guild_id: 'g1',
});
const cat = (id, at) => ({ ...ch(id, at), type: 'category' });

const sample = () => channelTree([
  ch('a', 0), ch('b', 1), ch('c', 2),
  cat('cat1', 3), ch('d', 4, 'cat1'), ch('e', 5, 'cat1'),
  cat('cat2', 6),
]);

describe('the channel tree', () => {
  it('puts each channel under its category, and keeps a category with none', () => {
    expect(shape(sample())).toEqual(['a', 'b', 'c', '[cat1]', '  d', '  e', '[cat2]']);
  });

  it('leaves a channel at the top level when its category is not there', () => {
    const tree = channelTree([ch('a', 0, 'gone'), cat('cat1', 1), ch('b', 2, 'a')]);
    expect(shape(tree)).toEqual(['a', 'b', '[cat1]']);
  });

  it('moves a channel among its neighbours, counting the gap the pointer was in', () => {
    expect(shape(moveChannel(sample(), 'a', null, 3)).slice(0, 3)).toEqual(['b', 'c', 'a']);
    expect(shape(moveChannel(sample(), 'c', null, 0)).slice(0, 3)).toEqual(['c', 'a', 'b']);
  });

  it('moves a channel into a category, out of one, and between two', () => {
    expect(shape(moveChannel(sample(), 'a', 'cat1', 0)))
      .toEqual(['b', 'c', '[cat1]', '  a', '  d', '  e', '[cat2]']);
    expect(shape(moveChannel(sample(), 'd', null, 1)))
      .toEqual(['a', 'd', 'b', 'c', '[cat1]', '  e', '[cat2]']);
    expect(shape(moveChannel(sample(), 'd', 'cat2', 0)))
      .toEqual(['a', 'b', 'c', '[cat1]', '  e', '[cat2]', '  d']);
  });

  it('refuses to put a category inside anything, including itself', () => {
    expect(shape(moveChannel(sample(), 'cat2', 'cat1', 0))).toEqual(shape(sample()));
    expect(shape(moveChannel(sample(), 'a', 'nosuch', 0))).toEqual(shape(sample()));
  });

  it('moves a category with everything under it -- a heading is its contents', () => {
    expect(shape(moveCategory(sample(), 'cat2', 0)))
      .toEqual(['a', 'b', 'c', '[cat2]', '[cat1]', '  d', '  e']);
  });

  it('numbers the whole list in the order it is drawn', () => {
    expect(placements(sample()).map((p) => `${p.id}@${p.position}:${p.parent_id || '-'}`))
      .toEqual([
        'a@0:-', 'b@1:-', 'c@2:-', 'cat1@3:-', 'd@4:cat1', 'e@5:cat1', 'cat2@6:-',
      ]);
  });

  it('sends only what moved', () => {
    const moved = channelMoves(moveChannel(sample(), 'a', null, 3));
    expect(moved.map((m) => m.id)).toEqual(['b', 'c', 'a']);
    expect(moved.find((m) => m.id === 'a').position).toBe(2);
    expect(channelMoves(moveChannel(sample(), 'c', 'cat1', 0)).some((m) => m.id === 'c'))
      .toBe(true);
    expect(channelMoves(sample())).toEqual([]);
  });

  it('records the channels a drag displaced, not only the one dragged', () => {
    const flat = channelTree([ch('a', 0), ch('b', 0), ch('c', 0)]);
    expect(channelMoves(moveChannel(flat, 'c', null, 0)).map((m) => `${m.id}@${m.position}`))
      .toEqual(['a@1', 'b@2']);
  });
});

async function boot({ mayManage = true } = {}) {
  const server = createFakeServer();
  server.state.guild.channels.push(
    { id: 'cat1', name: 'Text rooms', type: 'category', position: 3, permission_overwrites: [] },
    {
      id: 'c4', name: 'planning', type: 'text', position: 4, parent_id: 'cat1',
      permission_overwrites: [],
    },
    { id: 'cat2', name: 'Empty', type: 'category', position: 5, permission_overwrites: [] },
  );
  if (!mayManage) server.state.guild.me.permissions = '3151875';
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  await screen.findByRole('button', { name: 'general' });
  return { server, store, user };
}

describe('the channel sidebar', () => {
  it('draws the categories, including the one with nothing in it yet', async () => {
    await boot();
    expect(screen.getByText('Text rooms')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'planning' })).toBeTruthy();
    expect(screen.getByText('Empty')).toBeTruthy();
  });

  it('offers a way to make a channel straight into a category', async () => {
    const { user } = await boot();
    await user.click(screen.getByTitle('Create channel in Empty'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Create a channel')).toBeTruthy();
  });

  it('gives none of it to a member who cannot manage channels', async () => {
    await boot({ mayManage: false });
    expect(screen.getByText('Text rooms')).toBeTruthy();
    expect(screen.queryByTitle('Create channel in Empty')).toBeNull();
  });

  it('offers guild settings from the guild menu to a member who may manage it', async () => {
    const { user } = await boot();
    await user.click(screen.getByRole('button', { name: 'Guild menu' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Server settings' })).toBeTruthy();
  });

  it('hides guild settings from a member without MANAGE_GUILD', async () => {
    const { user } = await boot({ mayManage: false });

    await user.click(screen.getByRole('button', { name: 'Guild menu' }));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: 'Copy guild ID' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Server settings' })).toBeNull();
  });
});
