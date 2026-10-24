import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { App } from '../App.jsx';
import { createFakeServer, freshStore, GUILD, HOME } from './fake-server.js';
import { signIn } from './sign-in.js';
import { KEYS } from '../lib/sync.js';
import { open, syncKeys } from '../lib/sealed-sync.js';
import { stubMedia } from './fake-webrtc.js';

const GUILD_PANES = ['Overview', 'Roles', 'Channel permissions',
  'Gates and origins', 'Moderation queue', 'Bans', 'Emoji', 'Audit log'];
const USER_PANES = ['Profile', 'Account', 'Messages', 'Calls & audio', 'Profile lookups',
  'Network privacy', 'Connected servers', 'Notifications', 'Appearance', 'Extras', 'Local data'];

async function boot({ strict = false } = {}) {
  const server = createFakeServer();
  server.install();
  const store = freshStore();
  const user = userEvent.setup();
  const app = <App store={store} />;
  render(strict ? <StrictMode>{app}</StrictMode> : app);
  await signIn(user, { home: HOME });
  await waitFor(() => expect(store.signedIn).toBe(true));
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

async function openUserSettings(user) {
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
}

async function dismiss(user) {
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

async function dismissMenu(user) {
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
}

async function exerciseSelect(user, root) {
  const trigger = within(root).queryAllByRole('button')
    .find((b) => b.getAttribute('aria-haspopup') === 'listbox');
  if (!trigger) return;
  await user.click(trigger);
  const options = within(await screen.findByRole('listbox')).getAllByRole('option');
  expect(options.length).toBeGreaterThan(0);
  await user.click(options[options.length - 1]);
}

describe('every screen mounts', () => {
  it('walks the settings panes and the dialogs', async () => {
    const logged = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => logged.push(a.join(' ')));
    const { server, store, user } = await boot();

    for (const [openSettings, panes] of [[openUserSettings, USER_PANES],
      [openGuildSettings, GUILD_PANES]]) {
      await openSettings(user);
      const dialog = await screen.findByRole('dialog');
      for (const label of panes) {
        await user.click(await within(dialog).findByRole('button', { name: label }, { timeout: 5000 }));
        await waitFor(
          () => expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0),
          { timeout: 5000 },
        );
      }
      await dismiss(user);
    }

    await openUserSettings(user);
    const settings = await screen.findByRole('dialog');
    await user.click(within(settings).getByRole('button', { name: 'Profile' }));
    await user.upload(
      settings.querySelector('input[type="file"]'),
      new File(['not really a png'], 'me.png', { type: 'image/png' }),
    );
    const avatarCrop = (await screen.findAllByRole('dialog')).at(-1);
    await within(avatarCrop).findByText('Crop your avatar');
    expect(within(avatarCrop).queryByLabelText('Emoji name')).toBeNull();
    expect(within(avatarCrop).queryByLabelText('Sticker name')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Crop your avatar')).toBeNull());
    await dismiss(user);

    for (const title of ['Threads', 'Pinned messages',
      'Add a guild or server', 'React']) {
      await user.click((await screen.findAllByTitle(title))[0]);
      await screen.findByRole('dialog');
      await dismiss(user);
    }

    await user.click(screen.getByRole('textbox', { name: 'Search Telium' }));
    await screen.findByRole('dialog', { name: 'Search' });
    await dismiss(user);

    await user.click((await screen.findAllByRole('button', { name: 'More actions' }))[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Report message' }));
    await screen.findByRole('dialog');
    await dismiss(user);

    for (const name of ['Guild menu', 'general settings', 'Account menu']) {
      await user.click(await screen.findByRole('button', { name }));
      expect((await screen.findAllByRole('menuitem')).length).toBeGreaterThan(0);
      await dismissMenu(user);
    }

    const firstMessage = document.querySelector('.msg-row');
    expect(firstMessage).not.toBeNull();
    for (const target of [
      await screen.findByRole('button', { name: 'general' }),
      firstMessage,
    ]) {
      fireEvent.contextMenu(target);
      expect((await screen.findAllByRole('menuitem')).length).toBeGreaterThan(0);
      await dismissMenu(user);
    }

    for (const label of ['Invite people', 'Create channel']) {
      await user.click(await screen.findByRole('button', { name: 'Guild menu' }));
      await user.click(await screen.findByRole('menuitem', { name: label }));
      await exerciseSelect(user, await screen.findByRole('dialog'));
      await dismiss(user);
    }

    await user.click(await screen.findByTitle('Direct messages'));
    await user.click(await screen.findByTitle('New conversation'));
    await screen.findByRole('dialog');
    await dismiss(user);

    await user.click(await screen.findByRole('button', { name: /^Friends/ }));
    for (const label of ['All', 'Blocked', 'Online', 'Pending']) {
      await user.click(await screen.findByRole('button', { name: new RegExp(`^${label}`) }));
    }
    server.state.friends = [{
      user_id: '@bob:home.example', domain: 'home.example', state: 'pending_in',
      presence: null, display_name: null, avatar_ref: null,
    }];
    await act(async () => { await store.refreshFriends(); });
    fireEvent.contextMenu(await screen.findByText('bob'));
    expect((await screen.findAllByRole('menuitem')).length).toBeGreaterThan(0);
    await dismissMenu(user);

    spy.mockRestore();
    expect(logged.filter((e) => !/not wrapped in act|no route for/.test(e))).toEqual([]);
  });

  it('asks for an expression name inside the emoji crop dialog', async () => {
    const { server, user } = await boot();
    await openGuildSettings(user);
    const settings = await screen.findByRole('dialog');
    await user.click(await within(settings).findByRole('button', { name: 'Emoji' }));
    await user.upload(
      settings.querySelector('input[type="file"]'),
      new File(['not really a png'], 'Party Blob.png', { type: 'image/png' }),
    );

    const dialogs = await screen.findAllByRole('dialog');
    const crop = dialogs.at(-1);
    const name = within(crop).getByLabelText('Emoji name');
    expect(name.value).toBe('partyblob');
    await user.clear(name);
    await user.type(name, 'My Party Blob!');
    expect(name.value).toBe('mypartyblob');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Crop this emoji')).toBeNull());
    await user.keyboard('{Escape}');
  });

  it('a repaired toggle takes effect and outlives the session', async () => {
    const { user } = await boot();
    expect(screen.getByRole('complementary', { name: 'Members' })).toBeTruthy();

    await openUserSettings(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Appearance' }));
    await user.click(await screen.findByRole('switch', { name: 'Show the member list' }));
    await dismiss(user);

    await waitFor(() => expect(
      screen.queryByRole('complementary', { name: 'Members' }),
    ).toBeNull());
    expect(freshStore().prefs.members).toBe(false);
  });

  it('records the upload tier on the account, not in this browser', async () => {
    const { server, store, user } = await boot();
    await openUserSettings(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Account' }));

    await user.click(await screen.findByRole('radio', { name: /Another Telium server/ }));
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Example Files' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(server.state.mediaWrites).toEqual([
      { tier: 2, origin: 'files.example' },
    ]));
    await act(async () => { await store.loadMediaPreference(); });
    expect(store.mediaPreference).toEqual({ tier: 2, origin: 'files.example' });
    expect(localStorage.getItem('telium.prefs.v1') || '').not.toContain('files.example');
  });

  it('offers upload hosts the guild’s curators vouch for, saying who vouched', async () => {
    const { server, user } = await boot();
    server.state.feedVouchedHosts = [
      {
        origin: 'vouched.example',
        name: 'Vouched Files',
        description: 'Answers takedowns within a day.',
        max_file_bytes: null,
        abuse_contact: 'abuse@vouched.example',
        vouched_by: [{ curator: 'curator.example', feed: 'https://curator.example/feed.json' }],
      },
    ];
    await openUserSettings(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Account' }));
    await user.click(await screen.findByRole('radio', { name: /Another Telium server/ }));

    await user.click(within(dialog).getByRole('combobox'));
    expect(await screen.findByRole('option', { name: 'Example Files' })).toBeTruthy();
    await user.click(await screen.findByRole('option', { name: 'Vouched Files - via curator.example' }));
    expect(await within(dialog).findByText(/Vouched for by curator\.example\./)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(server.state.mediaWrites).toEqual([
      { tier: 2, origin: 'vouched.example' },
    ]));
  });

  it('jumps from a reply preview and opens the profile behind a ping', async () => {
    const { server, user } = await boot();

    act(() => {
      server.dispatch(GUILD, 'MESSAGE_CREATE', {
        id: 'm3',
        channel_id: 'c1',
        guild_id: 'g1',
        author: '@bob:home.example',
        content: 'what @alice:home.example said',
        reply_to: 'm1',
        created_at: Date.now(),
      });
    });

    await user.click(await screen.findByTitle('Jump to the replied-to message'));
    await waitFor(() => expect(document.querySelector('[data-id="m1"]').className)
      .toMatch(/msg-flash/));

    const pill = screen.getByRole('button', { name: '@alice' });
    expect(pill.getAttribute('title')).toBe('@alice:home.example');
    await user.click(pill);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /^@alice:home\.example, copy username$/ })).toBeTruthy();
    expect(dialog.closest('.popover')).toBeTruthy();
    await dismiss(user);

    act(() => {
      server.dispatch(GUILD, 'MESSAGE_CREATE', {
        id: 'm4',
        channel_id: 'c1',
        guild_id: 'g1',
        author: '@bob:home.example',
        content: 'quoting something that is gone',
        reply_to: 'm0',
        created_at: Date.now(),
      });
    });

    await user.click((await screen.findAllByTitle('Jump to the replied-to message')).at(-1));
    expect(await screen.findByText('That message is not available any more.')).toBeTruthy();
  });

  it('resolves an invite before joining, and says so when it cannot', async () => {
    const { user } = await boot();

    await user.click((await screen.findAllByTitle('Add a guild or server'))[0]);
    await user.click(await screen.findByRole('button', { name: /Join a guild/ }));
    const field = await screen.findByLabelText('Guild address or invite');

    await user.type(field, 'INVITE1');
    expect(await screen.findByText(
      /on guilds\.example/, {}, { timeout: 3000 },
    )).toBeTruthy();
    expect((await screen.findAllByText(/2 members/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Join Telium' }).getAttribute('disabled'),
    ).not.toBe(''));

    await user.clear(field);
    await user.type(field, 'EXPIRED');
    expect(await screen.findByText(
      /No server we can reach knows that address or invite/, {}, { timeout: 3000 },
    )).toBeTruthy();
    await dismiss(user);
  });

  it('refreshes the profile before creating a guild', async () => {
    const { server, user } = await boot();
    const host = server.state.minted.keys().next().value || 'home.example';
    const sessionsBefore = server.state.minted.get(host);

    await user.click((await screen.findAllByTitle('Add a guild or server'))[0]);
    await user.click(await screen.findByRole('button', { name: /Create my own/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(await within(dialog).findByPlaceholderText('My guild'), 'Fresh profile');
    await user.click(within(dialog).getByRole('button', { name: 'Create guild' }));

    await waitFor(() => expect(server.state.guildCreates).toHaveLength(1));
    expect(server.state.minted.get(host)).toBe(sessionsBefore + 1);
    expect(server.state.guildCreates[0]).toMatchObject({
      name: 'Fresh profile',
      token: `session-for-${host}-3`,
    });
  });

  it('follows an announcement channel from its menu', async () => {
    const { server, user } = await boot();
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'notices' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Follow announcements' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Follow' }));
    await waitFor(() => expect(server.state.follows).toHaveLength(1));
    expect(server.state.follows[0]).toEqual({ source: 'c3', target: 'c1' });
  });

  it('moderates a person from their tile in a live call', async () => {
    stubMedia();
    const { server, user } = await boot();
    await user.click(await screen.findByRole('button', { name: 'lounge' }));
    await act(async () => {
      server.dispatch(GUILD, 'VOICE_STATE_UPDATE', {
        guild_id: 'g1', channel_id: 'c2', user_id: '@bob:home.example', streaming: true,
      });
    });

    const tile = await waitFor(() => {
      const found = document.querySelector('[data-user="@bob:home.example"]');
      expect(found).toBeTruthy();
      return found;
    });
    fireEvent.contextMenu(tile);
    await user.click(await screen.findByRole('menuitem', { name: 'Server mute' }));
    await waitFor(() => expect(server.state.moderated).toHaveLength(1));
    expect(server.state.moderated[0]).toMatchObject({
      user_id: '@bob:home.example', mute: true,
    });
  });
});

describe('links and stickers', () => {
  it('opens an uploaded image attachment in an in-app preview', async () => {
    const { server, user } = await boot();

    act(() => {
      server.dispatch(GUILD, 'MESSAGE_CREATE', {
        id: 'image-message',
        channel_id: 'c1',
        guild_id: 'g1',
        author: '@bob:home.example',
        content: '',
        attachments: [{
          ref: 'image-hash',
          url: `${GUILD}/_telium/v1/media/image-hash?cap=cap-1`,
          name: 'photo.png',
          mime: 'image/png',
          size: 1234,
        }],
        created_at: Date.now(),
      });
    });

    await screen.findByAltText('photo.png');
    await user.click(screen.getByRole('button', { name: 'View photo.png larger' }));
    const preview = await screen.findByRole('dialog');
    expect(within(preview).getByAltText('photo.png').getAttribute('src'))
      .toBe(`${GUILD}/_telium/v1/media/image-hash?cap=cap-1`);
    await user.click(within(preview).getByTitle('Close image preview'));
    await waitFor(() => expect(screen.queryByTitle('Close image preview')).toBeNull());
  });

  it('previews a link through the proxy, never through the site', async () => {
    const { server, user } = await boot();

    const composer = screen.getByPlaceholderText('Message #general');
    await user.type(composer, 'look at https://example.com/page');
    await user.click(screen.getByTitle('Send'));

    const card = await screen.findByTitle('External link: https://example.com/page');
    expect(card.querySelector('img')?.getAttribute('src'))
      .toBe(`${GUILD}/_telium/v1/camo/camohash`);
    expect([...card.querySelectorAll('img')].map((i) => i.src))
      .not.toContain('https://example.com/page');

    await user.click(within(card).getByRole('button', { name: 'View image larger' }));
    const preview = await screen.findByRole('dialog');
    expect(within(preview).getByAltText('').getAttribute('src'))
      .toBe(`${GUILD}/_telium/v1/camo/camohash`);
    await user.click(within(preview).getByTitle('Close image preview'));
    await waitFor(() => expect(screen.queryByTitle('Close image preview')).toBeNull());

    await act(async () => {
      server.dispatch(GUILD, 'CHANNEL_UPDATE', { id: 'c1', guild_id: 'g1', strip_embeds: true });
    });
    await waitFor(() => expect(
      screen.queryByTitle('External link: https://example.com/page'),
    ).toBeNull());
  });

  it('keeps the emoji picker compact, and honours a saved skin tone', async () => {
    const { store, user } = await boot();
    store.sync.set(KEYS.emojiRecent, ['\u{1F44D}\u{1F3FD}']);
    store.sync.set(KEYS.emojiTone, '\u{1F3FD}');

    await user.click(screen.getByTitle('Emoji'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.className).toContain('emoji-popup');
    expect(dialog.querySelector('.emoji-panel')).toBeTruthy();

    const tones = within(dialog).getByRole('group', { name: 'Skin tone' });
    expect(within(tones).getByRole('button', { name: 'Medium skin tone' })
      .getAttribute('aria-pressed')).toBe('true');
    expect(within(tones).getByRole('button', { name: 'Dark skin tone' })
      .getAttribute('aria-pressed')).toBe('false');

    const recent = await waitFor(() => {
      const found = [...dialog.querySelectorAll('section')]
        .find((section) => section.textContent.startsWith('Recent'));
      expect(found).toBeTruthy();
      return found;
    }, { timeout: 30_000 });
    const thumb = await within(recent).findByAltText(
      '\u{1F44D}\u{1F3FD}', {}, { timeout: 30_000 },
    );
    const grid = thumb.closest('button')?.parentElement;
    expect(grid?.style.gridTemplateColumns).toContain('repeat(9');
    await dismiss(user);
  });

  it('stages a sticker from the picker and sends it', async () => {
    const { server, user } = await boot();

    await user.click(screen.getByTitle('Emoji'));
    await user.click(await screen.findByTitle(':partyblob:'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByTitle('Send'));
    await waitFor(() => expect(server.state.sent.at(-1)?.sticker).toEqual({
      id: 'st1', name: 'partyblob', origin: 'guilds.example',
    }));

    const image = await screen.findByAltText('partyblob');
    expect(image.getAttribute('src')).toBe(`${GUILD}/_telium/v1/sticker/st1`);
  });

  it('saves a sticker to the account, sealed, and shows it first in the picker', async () => {
    const { server, store, user } = await boot();

    await user.click(screen.getByTitle('Emoji'));
    await screen.findByTitle(':partyblob:');
    expect(screen.queryByText('Saved stickers')).toBeNull();

    await user.click(screen.getByTitle('Save sticker'));
    const dialog = screen.getAllByRole('dialog').find((d) => within(d).queryAllByTitle(':partyblob:').length);
    await within(dialog).findByText('Saved stickers');
    expect(within(dialog).getAllByTitle('Unsave sticker')).toHaveLength(2);
    expect(store.sync.get(KEYS.savedStickers)).toEqual([
      { id: 'st1', name: 'partyblob', origin: 'guilds.example' },
    ]);

    await waitFor(() => expect(store.sync.keys).toBeTruthy());
    await act(async () => { await store.sync.push(); });
    const row = server.state.sync[KEYS.savedStickers];
    expect(JSON.stringify(row)).not.toContain('partyblob');
    expect(JSON.stringify(row)).not.toContain('guilds.example');
    const { doc } = await open(await syncKeys(store.vault), KEYS.savedStickers, row.value);
    expect(doc.v).toEqual([{ id: 'st1', name: 'partyblob', origin: 'guilds.example' }]);

    await user.click(within(dialog).getAllByTitle('Unsave sticker')[0]);
    await waitFor(() => expect(within(dialog).queryByText('Saved stickers')).toBeNull());
    expect(store.sync.get(KEYS.savedStickers)).toEqual([]);
  });

  it('keeps the crop preview URL alive under StrictMode', async () => {
    const created = [];
    const revoked = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:telium/crop-${created.length + 1}`;
      created.push(url);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => revoked.push(url));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 100, height: 100, close() {},
    })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect() {},
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done, type) => {
      done(new Blob(['encoded'], { type }));
    });

    const { server, user } = await boot({ strict: true });
    await openUserSettings(user);
    const settings = await screen.findByRole('dialog');
    await user.click(await within(settings).findByRole('button', { name: 'Profile' }));
    await user.upload(
      settings.querySelector('input[type="file"]'),
      new File(['not really a png'], 'me.png', { type: 'image/png' }),
    );

    const dialogs = await screen.findAllByRole('dialog');
    const crop = dialogs.at(-1);
    const preview = crop.querySelector('img');
    expect(preview).not.toBeNull();
    const src = preview.getAttribute('src');
    expect(src).toBe(created.at(-1));
    expect(revoked).not.toContain(src);

    Object.defineProperties(preview, {
      naturalWidth: { configurable: true, value: 100 },
      naturalHeight: { configurable: true, value: 100 },
    });
    fireEvent.load(preview);
    const useImage = within(crop).getByRole('button', { name: 'Use image' });
    await waitFor(() => expect(useImage.disabled).toBe(false));
    await user.click(useImage);
    await waitFor(() => expect(screen.queryByText('Crop your avatar')).toBeNull());
    expect(server.state.mediaUploads.at(-1)?.purpose).toBe('profile');

    const bannerInput = settings.querySelectorAll('input[type="file"]')[1];
    await user.upload(
      bannerInput,
      new File(['not really a png'], 'banner.png', { type: 'image/png' }),
    );
    const bannerCrop = (await screen.findAllByRole('dialog')).at(-1);
    expect(within(bannerCrop).getByText('Crop your profile banner')).toBeTruthy();
    const bannerPreview = bannerCrop.querySelector('img');
    Object.defineProperties(bannerPreview, {
      naturalWidth: { configurable: true, value: 300 },
      naturalHeight: { configurable: true, value: 100 },
    });
    fireEvent.load(bannerPreview);
    const useBanner = within(bannerCrop).getByRole('button', { name: 'Use image' });
    await waitFor(() => expect(useBanner.disabled).toBe(false));
    await user.click(useBanner);
    await waitFor(() => expect(screen.queryByText('Crop your profile banner')).toBeNull());
    expect(server.state.mediaUploads.at(-1)?.purpose).toBe('profile');
  });

  it('applies a guild icon when the crop is confirmed', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:telium/guild-icon');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 100, height: 100, close() {},
    })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect() {},
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done, type) => {
      done(new Blob(['encoded'], { type }));
    });

    const { server, user } = await boot({ strict: true });
    await openGuildSettings(user);
    const settings = await screen.findByRole('dialog');
    await user.upload(
      settings.querySelector('input[type="file"]'),
      new File(['not really a png'], 'guild-icon.png', { type: 'image/png' }),
    );

    const crop = (await screen.findAllByRole('dialog')).at(-1);
    const preview = crop.querySelector('img');
    Object.defineProperties(preview, {
      naturalWidth: { configurable: true, value: 100 },
      naturalHeight: { configurable: true, value: 100 },
    });
    fireEvent.load(preview);
    const useImage = within(crop).getByRole('button', { name: 'Use image' });
    await waitFor(() => expect(useImage.disabled).toBe(false));
    await user.click(useImage);

    await waitFor(() => expect(server.state.guild.icon_ref).toBe('hash1?cap=cap-1'));
    await waitFor(() => expect(settings.querySelector('img')?.getAttribute('src'))
      .toBe(`${GUILD}/_telium/v1/media/hash1?cap=cap-1`));
    expect(within(settings).getByText('Custom icon set.')).toBeTruthy();
  });

  it('sends a GIF URL immediately, keeps the draft, and skips the embed proxy', async () => {
    const { server, store, user } = await boot();
    const composer = screen.getByPlaceholderText('Message #general');
    await user.type(composer, 'draft stays here');
    await user.click(screen.getByTitle('GIF'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByPlaceholderText('Search GIFs')).toBeTruthy();
    expect(within(dialog).queryByText('Add GIF URL')).toBeNull();
    await waitFor(() => expect(server.state.klipyRequests.length).toBeGreaterThan(0));

    const trending = within(dialog).getByRole('button', { name: 'Trending' });
    const door = () => within(dialog).getByRole('option', { name: 'Favorites' });
    expect(trending.getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getAllByRole('option')[0]).toBe(door());
    await user.click(door());
    expect(await within(dialog).findByText('Star a GIF to keep it here.')).toBeTruthy();
    expect(within(dialog).queryByRole('option', { name: 'Favorites' })).toBeNull();
    expect(trending.getAttribute('aria-pressed')).toBe('false');
    await user.click(trending);
    await within(dialog).findByTitle('Send Celebration');

    await user.click(within(dialog).getByTitle('Send Celebration'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const gifUrl = 'https://media.klipy.com/test/celebrate.gif';
    await waitFor(() => expect(server.state.sent.at(-1)?.content).toBe(gifUrl));
    expect(composer.value).toBe('draft stays here');
    expect(server.state.embedRequests).not.toContain(gifUrl);
    expect((await screen.findByAltText('GIF')).getAttribute('src')).toBe(gifUrl);

    await user.click(screen.getByRole('button', { name: 'View GIF larger' }));
    const preview = await screen.findByRole('dialog');
    expect(within(preview).getByAltText('GIF').getAttribute('src')).toBe(gifUrl);
    expect(within(preview).getByRole('link', { name: 'Open original' }).getAttribute('href'))
      .toBe(gifUrl);
    await user.click(within(preview).getByAltText('GIF'));
    expect(within(preview).getByTitle('Close image preview')).toBeTruthy();
    await user.click(within(preview).getByRole('document'));
    await waitFor(() => expect(screen.queryByTitle('Close image preview')).toBeNull());

    await user.click(screen.getByTitle('Favorite GIF'));
    await waitFor(() => expect(store.sync.keys).toBeTruthy());
    await act(async () => { await store.sync.push(); });
    const row = server.state.sync['gif.favorites.v1'];
    expect(JSON.stringify(row)).not.toContain('klipy');
    const { doc } = await open(await syncKeys(store.vault), 'gif.favorites.v1', row.value);
    expect(doc.v).toContain(gifUrl);
  });

  it('resolves a Klipy share page into a direct GIF embed', async () => {
    const { server, user } = await boot();
    const shareUrl = 'https://klipy.com/gifs/big-brother-is-watching-you-5';
    const composer = screen.getByPlaceholderText('Message #general');
    await user.type(composer, shareUrl);
    await user.keyboard('{Enter}');

    await waitFor(() => expect(server.state.sent.at(-1)?.content).toBe(shareUrl));
    await waitFor(() => expect(screen.getByAltText('GIF').getAttribute('src'))
      .toBe('https://media.klipy.com/test/celebrate.gif'));
    expect(server.state.klipyRequests.some(({ query }) => query.q === 'big-brother-is-watching-you-5')).toBe(true);
    expect(server.state.embedRequests).not.toContain(shareUrl);
  });

  it('resolves a Tenor share page into the same direct GIF tile', async () => {
    const { server, user } = await boot();
    const shareUrl = 'https://tenor.com/view/hypergamy-admin-learns-about-hypergamy-oy-vey-admin-gif-6459198981897272921';
    const composer = screen.getByPlaceholderText('Message #general');
    await user.type(composer, shareUrl);
    await user.keyboard('{Enter}');

    await waitFor(() => expect(server.state.sent.at(-1)?.content).toBe(shareUrl));
    await waitFor(() => expect(screen.getByAltText('GIF').getAttribute('src'))
      .toBe('https://media1.tenor.com/test/hypergamy.gif'));
    expect(server.state.tenorRequests.some(({ query }) => query.ids === '6459198981897272921')).toBe(true);
    expect(server.state.embedRequests).not.toContain(shareUrl);
    expect(screen.getByTitle('Favorite GIF')).toBeTruthy();
  });

  it('resolves a Giphy share page into the same direct GIF tile', async () => {
    const { server, user } = await boot();
    const shareUrl = 'https://giphy.com/gifs/RespectiveCollective-side-eye-cute-cat-fluffy-GAXXHdS0zXawVLOJLY';
    const composer = screen.getByPlaceholderText('Message #general');
    await user.type(composer, shareUrl);
    await user.keyboard('{Enter}');

    await waitFor(() => expect(server.state.sent.at(-1)?.content).toBe(shareUrl));
    await waitFor(() => expect(screen.getByAltText('GIF').getAttribute('src'))
      .toBe('https://media.giphy.com/media/GAXXHdS0zXawVLOJLY/giphy.gif'));
    expect(server.state.embedRequests).not.toContain(shareUrl);
    expect(screen.getByTitle('Favorite GIF')).toBeTruthy();
  });

  it('publishes a custom status, and withholds it from a guild switched off', async () => {
    const { server, store, user } = await boot();

    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Set a custom status' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Status'), 'writing tests');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const published = () => server.framesFor(GUILD)
      .filter((f) => f.op === 'PRESENCE_UPDATE').at(-1)?.d;
    await waitFor(() => expect(published()).toMatchObject({
      status: 'online', custom_status: 'writing tests',
    }));

    await user.click(await screen.findByRole('button', { name: 'Guild menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide my status here' }));
    await waitFor(() => expect(published()).toMatchObject({
      status: 'online', custom_status: null,
    }));
    expect(store.prefs.status.text).toBe('writing tests');
  });
});
