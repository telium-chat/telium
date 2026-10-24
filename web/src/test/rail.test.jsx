import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  addToFolder, combine, dissolveFolder, folderLabel, folderOf, moveTo, normalizeRail,
  renameFolder, setCollapsed,
} from '../lib/rail.js';
import { createFakeServer } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const guilds = (...names) => names.map((name) => ({ id: name.toLowerCase(), name }));
const ids = (nodes) => nodes.map((n) => (n.kind === 'folder' ? `[${n.guilds.join(' ')}]` : n.id));
const folder = (id, ...members) => ({
  kind: 'folder', id, name: '', collapsed: false, guilds: members,
});
const guild = (id) => ({ kind: 'guild', id });

describe('the rail arrangement', () => {
  it('keeps what it is told and appends what it has never heard of', () => {
    const all = guilds('Alpha', 'Bravo', 'Charlie');
    const nodes = normalizeRail([guild('bravo'), guild('alpha')], all);
    expect(ids(nodes)).toEqual(['bravo', 'alpha', 'charlie']);
  });

  it('forgets guilds the account is no longer in, and folders they emptied', () => {
    const nodes = normalizeRail(
      [folder('f1', 'gone', 'alsogone'), guild('gone'), guild('alpha')],
      guilds('Alpha'),
    );
    expect(ids(nodes)).toEqual(['alpha']);
  });

  it('keeps a guild once when the saved list names it twice', () => {
    const nodes = normalizeRail(
      [folder('f1', 'alpha'), guild('alpha'), guild('bravo')],
      guilds('Alpha', 'Bravo'),
    );
    expect(ids(nodes)).toEqual(['[alpha]', 'bravo']);
  });

  it('reads a bare id, so an older or hand-edited value is not thrown away', () => {
    expect(ids(normalizeRail(['bravo', 'alpha'], guilds('Alpha', 'Bravo'))))
      .toEqual(['bravo', 'alpha']);
  });

  it('moves a tile to the gap the user aimed at, not the one the index became', () => {
    const nodes = normalizeRail(null, guilds('Alpha', 'Bravo', 'Charlie'));
    expect(ids(moveTo(nodes, { type: 'guild', id: 'alpha' }, 3)))
      .toEqual(['bravo', 'charlie', 'alpha']);
    expect(ids(moveTo(nodes, { type: 'guild', id: 'charlie' }, 0)))
      .toEqual(['charlie', 'alpha', 'bravo']);
    expect(ids(moveTo(nodes, { type: 'guild', id: 'bravo' }, 1)))
      .toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('makes a folder where the target stood, holding both', () => {
    const nodes = normalizeRail(null, guilds('Alpha', 'Bravo', 'Charlie'));
    const made = combine(nodes, { type: 'guild', id: 'charlie' }, 'alpha');
    expect(ids(made)).toEqual(['[alpha charlie]', 'bravo']);
    expect(made[0].collapsed).toBe(false);
  });

  it('takes a drop onto a guild inside a folder as a drop onto the folder', () => {
    const nodes = normalizeRail(
      [folder('f1', 'alpha', 'bravo'), guild('charlie')],
      guilds('Alpha', 'Bravo', 'Charlie'),
    );
    const made = combine(nodes, { type: 'guild', id: 'charlie' }, 'bravo');
    expect(ids(made)).toEqual(['[alpha bravo charlie]']);
  });

  it('drags a guild out of a folder onto the rail', () => {
    const nodes = normalizeRail(
      [folder('f1', 'alpha', 'bravo'), guild('charlie')],
      guilds('Alpha', 'Bravo', 'Charlie'),
    );
    expect(ids(moveTo(nodes, { type: 'guild', id: 'alpha' }, 2)))
      .toEqual(['[bravo]', 'charlie', 'alpha']);
  });

  it('deletes a folder the moment its last guild leaves', () => {
    const nodes = normalizeRail([folder('f1', 'alpha'), guild('bravo')], guilds('Alpha', 'Bravo'));
    expect(ids(moveTo(nodes, { type: 'guild', id: 'alpha' }, 2))).toEqual(['bravo', 'alpha']);
  });

  it('reorders inside a folder, and refuses to empty one into itself', () => {
    const nodes = normalizeRail([folder('f1', 'alpha', 'bravo')], guilds('Alpha', 'Bravo'));
    expect(addToFolder(nodes, { type: 'guild', id: 'bravo' }, 'f1', 0)[0].guilds)
      .toEqual(['bravo', 'alpha']);
    const one = normalizeRail([folder('f1', 'alpha'), guild('bravo')], guilds('Alpha', 'Bravo'));
    expect(ids(addToFolder(one, { type: 'guild', id: 'alpha' }, 'f1'))).toEqual(['[alpha]', 'bravo']);
  });

  it('moves a whole folder without unpacking it', () => {
    const nodes = normalizeRail(
      [folder('f1', 'alpha', 'bravo'), guild('charlie')],
      guilds('Alpha', 'Bravo', 'Charlie'),
    );
    expect(ids(moveTo(nodes, { type: 'folder', id: 'f1' }, 2)))
      .toEqual(['charlie', '[alpha bravo]']);
  });

  it('names itself after what is in it until somebody says otherwise', () => {
    const known = new Map(guilds('Alpha', 'Bravo').map((g) => [g.id, g]));
    expect(folderLabel(folder('f1', 'alpha', 'bravo'), known)).toBe('Alpha, Bravo');
    expect(folderLabel({ ...folder('f1', 'alpha'), name: 'Games' }, known)).toBe('Games');
  });

  it('renames, collapses, and opens up without letting go of anything', () => {
    const nodes = normalizeRail([folder('f1', 'alpha', 'bravo')], guilds('Alpha', 'Bravo'));
    expect(renameFolder(nodes, 'f1', '  Games  ')[0].name).toBe('Games');
    expect(setCollapsed(nodes, 'f1', true)[0].collapsed).toBe(true);
    expect(ids(dissolveFolder(nodes, 'f1'))).toEqual(['alpha', 'bravo']);
    expect(folderOf(nodes, 'bravo').id).toBe('f1');
  });
});

async function boot() {
  const server = createFakeServer();
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await screen.findByTitle('Telium on guilds.example');
  act(() => {
    store.guilds.set('g2', {
      id: 'g2', name: 'Second', domain: 'guilds.example', icon_ref: null, member_count: 1,
    });
    store.emit('guilds');
  });
  return { store, user };
}

describe('folders on the rail', () => {
  it('closes over what it holds and opens again, and says how many', async () => {
    const { store, user } = await boot();
    act(() => {
      store.setRail([{ kind: 'folder', id: 'f1', name: '', collapsed: true, guilds: ['g1', 'g2'] }]);
    });

    const lid = await screen.findByTitle('Telium, Second - 2 servers');
    expect(screen.queryByRole('button', { name: 'Telium on guilds.example' })).toBeNull();

    await user.click(lid);
    expect(await screen.findByTitle('Telium on guilds.example')).toBeTruthy();
    expect(screen.getByTitle('Second on guilds.example')).toBeTruthy();
    expect(store.prefs.rail[0].collapsed).toBe(false);
  });

  it('carries the unread of everything inside it while it is closed', async () => {
    const { store, user } = await boot();
    act(() => {
      store.setRail([{ kind: 'folder', id: 'f1', name: '', collapsed: true, guilds: ['g1', 'g2'] }]);
    });
    const lid = (await screen.findByTitle('Telium, Second - 2 servers')).parentElement;

    act(() => {
      const channel = [...store.channels.values()].find((c) => c.guild_id === 'g1');
      store.readState.set(channel.id, { channel_id: channel.id, unread: 3, mentions: 2 });
      store.emit('unread', 'g1');
    });
    expect(await within(lid).findByText('2')).toBeTruthy();

    await user.click(within(lid).getByRole('button'));
    await screen.findByTitle('Telium on guilds.example');
    const open = (await screen.findByTitle('Telium, Second')).parentElement;
    await waitFor(() => expect(within(open).queryByText('2')).toBeNull());
  });

  it('opens the guild you press inside it, and marks that tile', async () => {
    const { store, user } = await boot();
    act(() => {
      store.setRail([{ kind: 'folder', id: 'f1', name: '', collapsed: false, guilds: ['g1', 'g2'] }]);
      store.navigate({ view: 'dms' });
    });
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    expect(store.route.view).toBe('chat');
    expect(store.route.guildId).toBe('g1');
    const tile = await screen.findByRole('button', { name: 'Telium on guilds.example' });
    expect(tile.getAttribute('aria-current')).toBe('page');
  });

  it('renames from the folder menu, and empties out without dropping a guild', async () => {
    const { store, user } = await boot();
    act(() => {
      store.setRail([{ kind: 'folder', id: 'f1', name: '', collapsed: true, guilds: ['g1', 'g2'] }]);
    });
    const lid = await screen.findByTitle('Telium, Second - 2 servers');

    fireEvent.contextMenu(lid.parentElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Rename folder' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Folder name'), 'Games');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByTitle('Games - 2 servers');

    fireEvent.contextMenu(screen.getByTitle('Games - 2 servers').parentElement);
    await user.click(await screen.findByRole('menuitem', { name: /Take these out/ }));
    expect(await screen.findByTitle('Telium on guilds.example')).toBeTruthy();
    expect(screen.getByTitle('Second on guilds.example')).toBeTruthy();
    expect(store.prefs.rail.some((n) => n.kind === 'folder')).toBe(false);
  });
});

describe('the marks on a tile', () => {
  const waiting = (store, guildId, unread, mentions) => act(() => {
    const channel = [...store.channels.values()].find((c) => c.guild_id === guildId);
    store.readState.set(channel.id, { channel_id: channel.id, unread, mentions });
    store.emit('unread', guildId);
  });

  it('marks what is waiting, and counts only what was addressed to you', async () => {
    const { store } = await boot();
    const tile = (await screen.findByTitle('Telium on guilds.example')).parentElement;
    const mark = () => tile.querySelector('.rail-pill');

    waiting(store, 'g1', 4, 0);
    await waitFor(() => expect(mark().dataset.state).toBe('unread'));
    expect(within(tile).queryByText('4')).toBeNull();

    waiting(store, 'g1', 9, 2);
    const named = await within(tile).findByText('2');
    expect(named.className).toContain('badge');
    expect(named.className).not.toContain('badge--quiet');
    expect(mark().dataset.state).toBe('unread');
  });

  it('says what is waiting as well as drawing it', async () => {
    const { store } = await boot();
    const tile = () => screen.getByRole('button', { name: 'Telium on guilds.example' });
    const note = () => document.getElementById(tile().getAttribute('aria-describedby') || '');
    expect(tile().getAttribute('aria-describedby')).toBe(null);

    waiting(store, 'g1', 4, 0);
    await waitFor(() => expect(tile().getAttribute('aria-describedby')).toBeTruthy());
    expect(note().textContent).toBe('Unread');
    expect(tile().getAttribute('aria-label')).toBe('Telium on guilds.example');
    expect(tile().getAttribute('title')).toBe('Telium on guilds.example');
  });

  it('stops counting at 99, where the exact number is only a wider tile', async () => {
    const { store } = await boot();
    const tile = (await screen.findByTitle('Telium on guilds.example')).parentElement;
    waiting(store, 'g1', 250, 250);
    expect(await within(tile).findByText('99+')).toBeTruthy();
  });

  it('is something the pointer will actually pick up', async () => {
    await boot();
    const tile = (await screen.findByTitle('Telium on guilds.example')).parentElement;
    const rail = tile.closest('nav');

    fireEvent.pointerDown(tile, { button: 0, pointerId: 1, clientX: 30, clientY: 40 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 80 });
    expect(rail.classList.contains('is-dragging')).toBe(true);
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(rail.classList.contains('is-dragging')).toBe(false);
    fireEvent.click(document.body);

    fireEvent.contextMenu(tile);
    expect(await screen.findByRole('menuitem', { name: 'Delete guild' })).toBeTruthy();
  });

  it('does not change colour under the press that opens it', async () => {
    const { store } = await boot();
    const tile = await screen.findByTitle('Telium on guilds.example');
    expect(tile.className).not.toMatch(/active:/);
    expect(store.route.guildId).not.toBe('g1');
  });
});

describe('a name on the rail', () => {
  it('draws the emoji in it, and still reads it out as the characters', async () => {
    const { store, user } = await boot();
    act(() => {
      store.guilds.set('g2', { ...store.guilds.get('g2'), name: 'Kittens \u{1F431}' });
      store.emit('guilds');
    });

    const tile = await screen.findByRole('button', { name: 'Kittens \u{1F431} on guilds.example' });
    expect(tile.getAttribute('title')).toBe('Kittens \u{1F431} on guilds.example');

    await user.hover(tile);
    const cat = await screen.findByAltText('\u{1F431}');
    expect(cat.closest('[data-base-ui-portal]')).toBeTruthy();
    expect(cat.parentElement.textContent).toContain('Kittens');
    expect(tile.getAttribute('title')).toBeNull();
  });
});

describe('the end of a guild', () => {
  it('is the owner’s only exit, and asks for the name before taking it', async () => {
    const { store, user } = await boot();
    const tile = await screen.findByTitle('Telium on guilds.example');

    fireEvent.contextMenu(tile.parentElement);
    expect(screen.queryByRole('menuitem', { name: 'Leave guild' })).toBeNull();
    await user.click(await screen.findByRole('menuitem', { name: 'Delete guild' }));

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete guild' });
    await user.type(within(dialog).getByLabelText('Type the name to confirm'), 'Telum');
    await user.click(confirm);
    expect(store.guilds.has('g1')).toBe(true);

    const field = within(dialog).getByLabelText('Type the name to confirm');
    await user.clear(field);
    await user.type(field, 'Telium');
    await user.click(confirm);

    await waitFor(() => expect(screen.queryByTitle('Telium on guilds.example')).toBeNull());
    expect(store.guilds.has('g1')).toBe(false);
  });
});

describe("the What's new tile", () => {
  const CHANGELOG = [
    '# Telium changelog', '',
    '## 15 October 2026', '',
    '- Feedback came in-app.',
  ].join('\n');
  const seed = (row) => localStorage.setItem('telium.changelog.v1', JSON.stringify(row));
  const tile = (name) => screen.getByRole('button', { name }).closest('.rail-tile');

  it('sits under the add button, and badges with an exclamation while unread', async () => {
    seed({ read: null, at: Date.now(), text: CHANGELOG });
    await boot();
    const add = tile('Add a guild or server');
    const whatsNew = tile("What's new");
    expect(
      add.compareDocumentPosition(whatsNew) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(whatsNew).getByText('!')).toBeTruthy();
  });

  it('an entry already read on this device draws no badge', async () => {
    seed({ read: '15 October 2026', at: Date.now(), text: CHANGELOG });
    await boot();
    expect(within(tile("What's new")).queryByText('!')).toBeNull();
  });

  it('opening it reads it, and the badge is gone by the time the dialog closes', async () => {
    seed({ read: null, at: Date.now(), text: CHANGELOG });
    const { user } = await boot();
    await user.click(screen.getByRole('button', { name: "What's new" }));
    expect(await screen.findByText('15 October 2026')).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(within(tile("What's new")).queryByText('!')).toBeNull();
    }, { timeout: 5000 });
    expect(JSON.parse(localStorage.getItem('telium.changelog.v1')).read).toBe('15 October 2026');
  });

  it('a failed fetch never manufactures a badge', async () => {
    await boot();
    expect(within(tile("What's new")).queryByText('!')).toBeNull();
  });
});
