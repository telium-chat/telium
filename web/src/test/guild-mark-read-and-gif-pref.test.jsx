import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { GUILD_DOMAIN, ME, mount, signedInStore } from './harness.jsx';
import { useMenus } from '../views/menus.jsx';
import { MenuButton } from '../components/index.js';
import { GifPickerPanel } from '../views/chat/GifPicker.jsx';
import { toggleGifFavorite } from '../lib/gifs.js';
import { EN } from '../lib/i18n/catalog/index.js';

const guild = (id, name, channels) => ({
  id, name, domain: GUILD_DOMAIN, channels,
  roles: [{ id, name: '@everyone', permissions: '0' }],
  me: { user_id: ME, roles: [], permissions: '0' },
});

function GuildMenu({ g }) {
  const menus = useMenus();
  return <MenuButton label="Guild menu" content={menus.guild(g)}>Guild</MenuButton>;
}

const MARK_READ = EN['chat.menu.markRead'];

describe('marking a whole guild read from the rail menu', () => {
  const channels = [
    { id: 'c1', guild_id: 'g1', name: 'one', type: 'text' },
    { id: 'c2', guild_id: 'g1', name: 'two', type: 'text' },
    { id: 'c3', guild_id: 'g1', name: 'quiet', type: 'text' },
  ];

  it('acks every unread channel, loaded or not, and clears the badge', async () => {
    const store = signedInStore({
      guilds: [guild('g1', 'Cartography', channels)],
      unread: { c1: { unread: 3, mentions: 1 }, c2: { unread: 2 } },
    });
    store.messages.set('c1', [{ id: 'm1' }, { id: 'm2' }]);
    const acked = [];
    const api = {
      ack: vi.fn(async (channel, id) => { acked.push([channel, id]); }),
      history: vi.fn(async () => ({ messages: [{ id: 'old' }, { id: 'newest' }] })),
    };
    store.apiForChannel = () => api;

    const { user } = mount(<GuildMenu g={store.guilds.get('g1')} />, store);
    await user.click(screen.getByRole('button', { name: 'Guild menu' }));
    await user.click(await screen.findByRole('menuitem', { name: MARK_READ }));

    await waitFor(() => expect(store.guildUnread('g1')).toEqual({ unread: 0, mentions: 0 }));
    expect(acked.sort()).toEqual([['c1', 'm2'], ['c2', 'newest']]);
    // The channel with nothing unread is left alone.
    expect(api.history).toHaveBeenCalledTimes(1);
  });

  it('is not offered when the guild has nothing unread', async () => {
    const store = signedInStore({ guilds: [guild('g1', 'Cartography', channels)] });
    const { user } = mount(<GuildMenu g={store.guilds.get('g1')} />, store);
    await user.click(screen.getByRole('button', { name: 'Guild menu' }));
    await screen.findByRole('menuitem', { name: /Copy guild ID/ });
    expect(screen.queryByRole('menuitem', { name: MARK_READ })).toBeNull();
  });
});

describe('the GIF picker opening on favorites', () => {
  const url = 'https://media.example.test/fav.gif';
  beforeEach(() => {
    globalThis.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; }

      observe(target) { this.callback([{ isIntersecting: true, target }], this); }

      unobserve() {}

      disconnect() {}
    };
  });
  afterEach(() => { delete globalThis.IntersectionObserver; });

  it('starts on the catalog by default', () => {
    const store = signedInStore();
    toggleGifFavorite(store, url);
    const { container } = mount(<GifPickerPanel onPick={() => {}} onClose={() => {}} />, store);
    expect(within(container).getByRole('option', { name: EN['chat.gif.favorites'] })).toBeTruthy();
  });

  it('starts on favorites when the setting is on and there are some', async () => {
    const store = signedInStore({ prefs: { gifOpensFavorites: true } });
    toggleGifFavorite(store, url);
    const { container } = mount(<GifPickerPanel onPick={() => {}} onClose={() => {}} />, store);
    expect(await within(container).findByAltText(EN['chat.gif.favorite'])).toBeTruthy();
    expect(within(container).getByRole('listbox').getAttribute('aria-label')).toBe(EN['chat.gif.favorites']);
  });

  it('falls back to the catalog when the setting is on but nothing is saved', () => {
    const store = signedInStore({ prefs: { gifOpensFavorites: true } });
    const { container } = mount(<GifPickerPanel onPick={() => {}} onClose={() => {}} />, store);
    expect(within(container).getByRole('option', { name: EN['chat.gif.favorites'] })).toBeTruthy();
  });
});
