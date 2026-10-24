import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Sidebar } from '../views/Sidebar.jsx';
import { ME, mount, signedInStore } from './harness.jsx';

const NO_VIEW = '1';
const OWNER = '18446744073709551615';
const VIEW_ONLY = '1';

const shut = (guildId) => [{ target_type: 'role', target_id: guildId, deny: NO_VIEW }];

function guild({ id = 'g1', name = 'Telium', channels = [], permissions = OWNER } = {}) {
  return {
    id,
    name,
    channels,
    roles: [{ id, name: '@everyone', permissions: '0' }],
    me: { user_id: ME, roles: [], permissions },
  };
}

const ch = (id, name, over = {}) => ({
  id, name, type: 'text', position: 0, parent_id: null, ...over,
});

function furnished() {
  return guild({
    channels: [
      ch('c-welcome', 'welcome', { position: 0 }),
      ch('cat-text', 'Text channels', { type: 'category', position: 1 }),
      ch('c-general', 'general', { position: 2, parent_id: 'cat-text' }),
      ch('c-secret', 'secret', {
        position: 3, parent_id: 'cat-text', permission_overwrites: shut('g1'),
      }),
      ch('cat-voice', 'Voice channels', { type: 'category', position: 4 }),
      ch('c-lounge', 'lounge', { type: 'voice', position: 5, parent_id: 'cat-voice' }),
    ],
  });
}

const row = (name) => screen.findByRole('button', { name: new RegExp(`^${name}(?! settings)`) });

describe('the channel sidebar', () => {
  it('draws the guild, its categories and what is under each of them', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, store);

    expect(await screen.findByText('Telium')).toBeTruthy();

    expect(screen.getByText('Text channels')).toBeTruthy();
    expect(screen.getByText('Voice channels')).toBeTruthy();
    for (const name of ['welcome', 'general', 'secret', 'lounge']) {
      expect(await row(name)).toBeTruthy();
    }
  });

  it('marks the channel the route names, and only that one', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, store);

    expect((await row('general')).getAttribute('aria-current')).toBe('page');
    expect((await row('welcome')).getAttribute('aria-current')).toBe(null);
    expect((await row('lounge')).getAttribute('aria-current')).toBe(null);
  });

  it('says that a private channel is private in something other than a glyph', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, store);

    expect(within(await row('secret')).getByText('Private')).toBeTruthy();
    expect(within(await row('general')).queryByText('Private')).toBe(null);
  });

  it('badges what is waiting, and stops badging it once the channel is muted', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      unread: { 'c-welcome': { unread: 9, mentions: 3 } },
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    const { unmount } = mount(<Sidebar />, store);
    expect(within(await row('welcome')).getByText('3')).toBeTruthy();
    unmount();

    const muted = signedInStore({
      guilds: [furnished()],
      unread: { 'c-welcome': { unread: 9, mentions: 3 } },
      prefs: { muted: { 'c-welcome': true } },
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, muted);
    expect(within(await row('welcome')).queryByText('3')).toBe(null);
  });

  it('says a channel has something waiting, not only draws it', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      unread: { 'c-welcome': { unread: 9, mentions: 0 } },
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, store);

    const waiting = await row('welcome');
    expect(within(waiting).queryByText('9')).toBe(null);
    const note = document.getElementById(waiting.getAttribute('aria-describedby') || '');
    expect(note?.textContent).toBe('Unread');
    expect(screen.getByRole('button', { name: 'welcome' })).toBe(waiting);

    expect((await row('general')).getAttribute('aria-describedby')).toBe(null);
  });

  it('lets a mute with a deadline in the past expire on its own', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      unread: { 'c-welcome': { unread: 4, mentions: 4 } },
      prefs: { muted: { 'c-welcome': Date.now() - 3_600_000 } },
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, store);
    expect(within(await row('welcome')).getByText('4')).toBeTruthy();
  });

  it('navigates on a click and remembers having been there', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    const { user } = mount(<Sidebar />, store);

    expect(store.recentSurfaces()).toEqual([]);

    await user.click(await row('welcome'));
    expect(store.route.channelId).toBe('c-welcome');
    expect(store.route.guildId).toBe('g1');
    expect(store.recentSurfaces()).toEqual(['c-welcome']);

    expect((await row('welcome')).getAttribute('aria-current')).toBe('page');
    expect((await row('general')).getAttribute('aria-current')).toBe(null);
  });

  it('puts the most recent visit first and keeps each place once', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    const { user } = mount(<Sidebar />, store);

    await user.click(await row('welcome'));
    await user.click(await row('general'));
    await user.click(await row('welcome'));
    expect(store.recentSurfaces()).toEqual(['c-welcome', 'c-general']);
  });

  it('substitutes emoji in every name it draws', async () => {
    const store = signedInStore({
      guilds: [guild({
        name: '🎉 Telium',
        channels: [
          ch('cat-fun', '🎈 Fun', { type: 'category', position: 0 }),
          ch('c-party', '🎉 party', { position: 1, parent_id: 'cat-fun' }),
        ],
      })],
      threads: { 'c-party': [{ id: 't-1', title: '🧵 the thread', archived: false }] },
      route: { view: 'chat', guildId: 'g1', channelId: 'c-party' },
    });
    mount(<Sidebar />, store);

    for (const emoji of ['🎈', '🧵']) {
      expect(await screen.findByRole('img', { name: emoji })).toBeTruthy();
    }
    expect(screen.getAllByRole('img', { name: '🎉' })).toHaveLength(2);
    expect(await screen.findByRole('button', { name: /party(?! settings)/ })).toBeTruthy();
  });

  it('lists a channel’s threads while that channel is the one open', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      threads: {
        'c-general': [
          { id: 't-live', title: 'still going', archived: false },
          { id: 't-old', title: 'long since done', archived: true },
        ],
        'c-welcome': [{ id: 't-elsewhere', title: 'under another channel', archived: false }],
      },
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, store);

    expect(await row('still going')).toBeTruthy();
    expect(screen.queryByText('long since done')).toBe(null);
    expect(screen.queryByText('under another channel')).toBe(null);
  });

  it('opens a thread as a channel of its own', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      threads: { 'c-general': [{ id: 't-live', title: 'still going', archived: false }] },
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    const { user } = mount(<Sidebar />, store);

    await user.click(await row('still going'));
    expect(store.route.channelId).toBe('t-live');
    expect(store.channels.get('t-live')?.parent_id).toBe('c-general');
    expect((await row('still going')).getAttribute('aria-current')).toBe('page');
  });

  it('collapses a category, and keeps the answer in preferences', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      route: { view: 'chat', guildId: 'g1', channelId: 'c-welcome' },
    });
    const { user } = mount(<Sidebar />, store);

    await user.click(await screen.findByRole('button', { name: /^Text channels/ }));
    expect(screen.queryByRole('button', { name: /^general/ })).toBe(null);
    expect(store.prefs.collapsed['cat-text']).toBe(true);
    expect(screen.getByText('Text channels')).toBeTruthy();

    await user.click(await screen.findByRole('button', { name: /^Text channels/ }));
    expect(await row('general')).toBeTruthy();
  });

  it('starts folded when preferences say the category is folded', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      prefs: { collapsed: { 'cat-text': true } },
      route: { view: 'chat', guildId: 'g1', channelId: 'c-welcome' },
    });
    mount(<Sidebar />, store);

    expect(await screen.findByText('Text channels')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^general/ })).toBe(null);
  });

  it('opens a voice channel’s chat from its row without joining the call', async () => {
    const store = signedInStore({
      guilds: [furnished()],
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, store);

    fireEvent.click(await screen.findByRole('button', { name: 'Open chat in lounge' }));

    expect(store.route.view).toBe('voice');
    expect(store.route.channelId).toBe('c-lounge');
    expect(store.route.chat).toBe(true);
    expect(store.voice.get('c-lounge') || []).toHaveLength(0);
  });

  it('names who is in a voice channel, and whether they can hear you', async () => {
    const store = signedInStore({
      guilds: [{
        ...furnished(),
        voice_states: [
          { user_id: '@bob:guilds.example', channel_id: 'c-lounge' },
          { user_id: '@cara:guilds.example', channel_id: 'c-lounge', self_mute: true },
          { user_id: '@dev:guilds.example', channel_id: 'c-lounge', self_deaf: true },
          { user_id: '@eve:guilds.example', channel_id: 'c-lounge', server_mute: true },
        ],
      }],
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, store);

    const person = async (id) => {
      await screen.findByText('lounge');
      return document.querySelector(`[data-voice-participant="${id}"]`);
    };

    expect(within(await person('@bob:guilds.example')).getByText('bob')).toBeTruthy();
    expect(within(await person('@bob:guilds.example')).queryByText('Muted')).toBe(null);

    expect(within(await person('@cara:guilds.example')).getByText('Muted')).toBeTruthy();
    expect(within(await person('@eve:guilds.example')).getByText('Muted')).toBeTruthy();
    expect(within(await person('@dev:guilds.example')).getByText('Deafened')).toBeTruthy();
    expect(within(await person('@dev:guilds.example')).queryByText('Muted')).toBe(null);
  });

  it('takes the people in a voice channel along when the channel is dragged', async () => {
    const store = signedInStore({
      guilds: [{
        ...furnished(),
        voice_states: [
          { user_id: '@bob:guilds.example', channel_id: 'c-lounge' },
          { user_id: '@cara:guilds.example', channel_id: 'c-lounge' },
        ],
      }],
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, store);
    await screen.findByText('lounge');

    for (const id of ['@bob:guilds.example', '@cara:guilds.example']) {
      const row = document.querySelector(`[data-voice-participant="${id}"]`);
      expect(row.closest('.drag-item')).toBeTruthy();
    }
  });

  it('registers nobody for a reader who cannot rearrange the list', async () => {
    const store = signedInStore({
      guilds: [{
        ...guild({ permissions: VIEW_ONLY, channels: furnished().channels }),
        voice_states: [{ user_id: '@bob:guilds.example', channel_id: 'c-lounge' }],
      }],
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    mount(<Sidebar />, store);
    await screen.findByText('lounge');

    const row = document.querySelector('[data-voice-participant="@bob:guilds.example"]');
    expect(row.closest('.drag-item')).toBe(null);
  });

  it('keeps voice members draggable between channels without stealing profile clicks', async () => {
    const store = signedInStore({
      guilds: [{
        ...furnished(),
        voice_states: [
          { user_id: '@bob:guilds.example', channel_id: 'c-lounge' },
        ],
      }],
      members: {
        g1: [{ user_id: '@bob:guilds.example', display_name: 'Bob' }],
      },
      route: { view: 'chat', guildId: 'g1', channelId: 'c-general' },
    });
    const { user } = mount(<Sidebar />, store);

    await screen.findByText('lounge');
    const person = document.querySelector('[data-voice-participant="@bob:guilds.example"]');
    expect(person).toBeTruthy();

    await waitFor(() => expect(person.getAttribute('draggable')).toBe('true'));
    expect(person.getAttribute('title')).toBe('Drag to another voice channel');

    await user.click(person);
    await waitFor(() => expect(document.querySelector('[data-profile-card-popover]')).toBeTruthy());
    expect(screen.getByRole('button', { name: /copy username/i })).toBeTruthy();
  });

  it('says so plainly when there is no guild, and when the guild is empty', async () => {
    const none = signedInStore({ route: { view: 'chat', guildId: null } });
    const { unmount } = mount(<Sidebar />, none);
    expect(await screen.findByText('Telium')).toBeTruthy();
    expect(screen.getByText(/Join or create a guild/)).toBeTruthy();
    unmount();

    const empty = signedInStore({
      guilds: [guild({ channels: [] })],
      route: { view: 'chat', guildId: 'g1' },
    });
    mount(<Sidebar />, empty);
    expect(await screen.findByText(/No channels you can see here/)).toBeTruthy();
  });
});

describe('the direct messages sidebar', () => {
  const conversation = (over) => ({
    id: 'k1',
    kind: 'dm',
    members: [{ user_id: ME }, { user_id: '@bob:home.example' }],
    ...over,
  });

  it('lists conversations and marks the one that is open', async () => {
    const store = signedInStore({
      conversations: [conversation({ id: 'k1' }), conversation({
        id: 'k2',
        kind: 'group',
        name: '🎉 the group',
        members: [{ user_id: ME }, { user_id: '@bob:home.example' }, { user_id: '@cara:home.example' }],
      })],
      route: { view: 'dms', conversationId: 'k2' },
    });
    mount(<Sidebar />, store);

    expect(await screen.findByText('Direct messages')).toBeTruthy();
    const group = await screen.findByRole('button', { name: /the group/ });
    expect(group.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('img', { name: '🎉' })).toBeTruthy();

    const friends = screen.getByRole('button', { name: /^Friends/ });
    expect(friends.getAttribute('aria-current')).toBe(null);
  });

  it('marks Friends as the place you are when no conversation is open', async () => {
    const store = signedInStore({ route: { view: 'dms', conversationId: null } });
    mount(<Sidebar />, store);
    const friends = await screen.findByRole('button', { name: /^Friends/ });
    expect(friends.getAttribute('aria-current')).toBe('page');
  });

  it('badges unread conversations and incoming friend requests', async () => {
    const store = signedInStore({
      conversations: [conversation({ id: 'k1' })],
      dmUnread: { k1: 5 },
      friends: [
        { user_id: '@zoe:home.example', state: 'pending_in' },
        { user_id: '@yan:home.example', state: 'pending_out' },
      ],
      route: { view: 'dms', conversationId: null },
    });
    mount(<Sidebar />, store);

    expect(within(await screen.findByRole('button', { name: /^Friends/ })).getByText('1')).toBeTruthy();
    expect(within(await screen.findByRole('button', { name: /bob/ })).getByText('5')).toBeTruthy();
  });

  it('gives a friend nobody has written to a row anyway', async () => {
    const store = signedInStore({
      conversations: [conversation({ id: 'k1' })],
      friends: [
        { user_id: '@bob:home.example', state: 'accepted' },
        { user_id: '@cara:home.example', state: 'accepted' },
      ],
      route: { view: 'dms', conversationId: null },
    });
    mount(<Sidebar />, store);

    expect(await screen.findByRole('button', { name: /cara/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /bob/ })).toHaveLength(1);
  });

  it('says there is nothing here when there is nothing here', async () => {
    const store = signedInStore({ route: { view: 'dms', conversationId: null } });
    mount(<Sidebar />, store);
    expect(await screen.findByText('No conversations yet.')).toBeTruthy();
  });

  it('navigates into a conversation and records the visit', async () => {
    const store = signedInStore({
      conversations: [conversation({ id: 'k1' })],
      route: { view: 'dms', conversationId: null },
    });
    const { user } = mount(<Sidebar />, store);

    await user.click(await screen.findByRole('button', { name: /bob/ }));
    expect(store.route.conversationId).toBe('k1');
    expect(store.recentSurfaces()).toEqual(['k1']);
  });
});
