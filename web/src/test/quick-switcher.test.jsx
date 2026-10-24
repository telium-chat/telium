import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeServer } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import { destinations, fuzzyMatch, rankDestinations } from '../lib/switcher.js';

const ME = '@alice:home.example';
const BOB = '@bob:home.example';
const CAROL = '@carol:other.example';

const convo = (id, kind, memberIds, extra = {}) => ({
  id,
  kind,
  sequencer: 'home.example',
  epoch: 1,
  last_seq: 0,
  members: memberIds.map((user_id) => ({ user_id, state: 'joined' })),
  ...extra,
});

const friend = (userId, extra = {}) => ({
  user_id: userId,
  domain: userId.split(':')[1],
  state: 'accepted',
  presence: null,
  display_name: null,
  avatar_ref: null,
  ...extra,
});

const score = (text, query) => fuzzyMatch(text, query)?.score ?? null;

async function boot({ conversations = [], friends = [], channels = null } = {}) {
  const overrides = { conversations, friends };
  const server = createFakeServer(overrides);
  if (channels) server.state.guild.channels = channels;
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  await screen.findByRole('button', { name: 'general' });
  return { server, store, user };
}

const openSwitcher = async () => {
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  return screen.findByRole('dialog', { name: 'Quick switcher' });
};

const nameOf = (row) => within(row)
  .getByText((_, node) => node?.classList?.contains('qs-name')).textContent;

const rowNames = () => screen.getAllByRole('option').map(nameOf);

const rowNamed = (name) => screen.getAllByRole('option').find((row) => nameOf(row) === name);

describe('the matcher', () => {
  it('puts a prefix above a scattered subsequence', () => {
    expect(score('general', 'gen')).toBeGreaterThan(score('regeneration-log', 'gen'));
  });

  it('puts the start of a word above the middle of one', () => {
    expect(score('voice-chat', 'vc')).toBeGreaterThan(score('vivace-concerto', 'vc'));
  });

  it('prefers a run of characters to the same characters spread out', () => {
    expect(score('deploys', 'dep')).toBeGreaterThan(score('d-e-p', 'dep'));
  });

  it('refuses what is not there at all, in order', () => {
    expect(fuzzyMatch('general', 'xyz')).toBeNull();
    expect(fuzzyMatch('general', 'nag')).toBeNull();
  });

  it('marks exactly the characters it read, so a row can underline them', () => {
    expect(fuzzyMatch('deploy-notes', 'dnote').positions).toEqual([0, 7, 8, 9, 10]);
  });
});

describe('ranking', () => {
  const entry = (key, title, extra = {}) => ({
    key, title, group: 'channel', kind: 'text', where: '', recentId: key, unread: 0, mentions: 0, ...extra,
  });

  it('lets recency break a tie and nothing more', () => {
    const pool = [entry('a', 'design'), entry('b', 'deploys')];
    const cold = rankDestinations(pool, 'de', { recent: [] });
    expect(cold[0].entry.title).toBe('deploys');
    const warm = rankDestinations(pool, 'de', { recent: ['a'] });
    expect(warm[0].entry.title).toBe('design');
    const beaten = rankDestinations(pool, 'dep', { recent: ['a'] });
    expect(beaten[0].entry.title).toBe('deploys');
  });

  it('opens on where you have been, newest first', () => {
    const pool = [entry('a', 'one'), entry('b', 'two'), entry('c', 'three')];
    expect(rankDestinations(pool, '', { recent: ['c', 'a'] }).map((r) => r.entry.title))
      .toEqual(['three', 'one', 'two']);
  });

  it('falls back to what is waiting when there is no history', () => {
    const pool = [
      entry('a', 'quiet'),
      entry('b', 'unread', { unread: 3 }),
      entry('c', 'mentioned', { mentions: 1 }),
    ];
    expect(rankDestinations(pool, '', { recent: [] }).map((r) => r.entry.title))
      .toEqual(['mentioned', 'unread', 'quiet']);
  });
});

describe('the quick switcher', () => {
  it('opens on Cmd-K from anywhere, not only inside a server', async () => {
    const { store, user } = await boot();
    await user.click(await screen.findByTitle('Direct messages'));
    await waitFor(() => expect(store.route.view).toBe('dms'));
    await openSwitcher();
    expect(screen.getByPlaceholderText('Where would you like to go?')).toBeTruthy();
  });

  it('offers everything at once, and says where each thing lives', async () => {
    await boot({
      conversations: [convo('gc1', 'gc', [ME, BOB, CAROL])],
      friends: [friend(CAROL, { display_name: 'Carol' })],
    });
    await openSwitcher();
    await user_type('gene');
    await waitFor(() => expect(rowNames()).toContain('general'));
    expect(within(rowNamed('general')).getByText('Telium')).toBeTruthy();
  });

  it('walks with the arrows, wraps at both ends, and navigates on Enter', async () => {
    const { store } = await boot();
    await openSwitcher();
    await user_type('l');
    const names = rowNames();
    expect(names.length).toBeGreaterThan(1);

    const input = screen.getByPlaceholderText('Where would you like to go?');
    const selected = () => screen.getAllByRole('option')
      .findIndex((row) => row.getAttribute('aria-selected') === 'true');

    expect(selected()).toBe(0);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(selected()).toBe(names.length - 1);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selected()).toBe(0);

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(store.route.channelId).toBeTruthy());
    expect(store.channels.get(store.route.channelId).name).toBe(names[0]);
  });

  it('filters by prefix, Discord\'s way', async () => {
    await boot();
    await openSwitcher();
    await user_type('!');
    await waitFor(() => expect(rowNames()).toEqual(['lounge']));
    await user_clear();
    await user_type('*');
    await waitFor(() => expect(rowNames()).toEqual(['Telium']));
    await user_clear();
    await user_type('#');
    await waitFor(() => expect(rowNames()).not.toContain('lounge'));
  });

  it('remembers where you have been, and opens onto it', async () => {
    const { store, user } = await boot();
    await user.click(await screen.findByRole('button', { name: 'notices' }));
    await waitFor(() => expect(store.route.channelId).toBe('c3'));
    expect(store.recentSurfaces()[0]).toBe('c3');
    await openSwitcher();
    await waitFor(() => expect(rowNames()[0]).toBe('notices'));
  });

  it('closes on Escape', async () => {
    await boot();
    const dialog = await openSwitcher();
    fireEvent.keyDown(dialog, { key: 'Escape', bubbles: true });
    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: 'Quick switcher' }),
    ).toBeNull());
  });
});

async function user_type(text) {
  const input = screen.getByPlaceholderText('Where would you like to go?');
  await userEvent.type(input, text);
}

async function user_clear() {
  const input = screen.getByPlaceholderText('Where would you like to go?');
  await userEvent.clear(input);
}
