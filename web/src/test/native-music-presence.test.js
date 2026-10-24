import { createElement } from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichActivityCard } from '../components/RichActivityCard.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { normalizeRichActivity } from '../lib/activity.js';
import { installDesktopRichPresence, rehostLocalPresenceArtwork } from '../lib/rich-presence.js';
import { Emitter } from '../lib/util.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete window.teliumDesktop;
});

describe('native music presence', () => {
  it('re-encodes and rehosts opaque local album artwork as short-lived profile media', async () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]).buffer;
    Object.defineProperty(window, 'teliumDesktop', {
      configurable: true,
      value: {
        readRichPresenceArtwork: vi.fn(async (handle) => {
          expect(handle).toBe('mpris-art:opaque');
          return { bytes, mime: 'image/png', name: 'album.png' };
        }),
      },
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        origin: 'home.example',
        hash: 'a'.repeat(64),
        reference: `media://home.example/${'a'.repeat(64)}`,
        capability: 'cap',
        url: `https://home.example/_telium/v1/media/${'a'.repeat(64)}?cap=cap`,
        filename: 'album.webp',
        mime: 'image/webp',
        size: 10,
      }),
    });
    const encodeImage = vi.fn(async (file, crop, preset) => {
      expect(file).toBeInstanceOf(File);
      expect(file.type).toBe('image/png');
      expect(crop).toEqual({});
      expect(preset.size).toBe(256);
      return new File([new Uint8Array([1, 2, 3])], 'album.webp', { type: 'image/webp' });
    });

    const activity = {
      name: 'Spotify',
      type: 2,
      details: 'akihabara',
      state: 'venny',
      assets: {
        local_large_image: 'mpris-art:opaque',
        large_text: 'night drive',
      },
    };
    const resolved = await rehostLocalPresenceArtwork({
      home: { base: 'https://home.example', token: 'home-token' },
    }, activity, new Map(), encodeImage);

    expect(window.teliumDesktop.readRichPresenceArtwork).toHaveBeenCalledTimes(1);
    expect(encodeImage).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://home.example/_telium/v1/media');
    expect(init.headers.Authorization).toBe('Bearer home-token');
    expect(init.headers['X-Telium-Purpose']).toBe('profile');
    expect(init.headers['X-Telium-Ttl-Secs']).toBe(String(6 * 60 * 60));
    expect(init.body).toBeInstanceOf(File);
    expect(init.body.type).toBe('image/webp');
    expect(resolved.assets.large_image).toContain('https://home.example/_telium/v1/media/');
    expect(resolved.assets.large_media).toEqual({
      origin: 'home.example',
      hash: 'a'.repeat(64),
      capability: 'cap',
    });
    expect(resolved.assets.local_large_image).toBeUndefined();
  });

  it('renders Telium-hosted album art through the viewers media cache without the embed proxy', () => {
    const hash = 'b'.repeat(64);
    const api = {
      base: 'https://guild.example',
      domain: 'guild.example',
      embed: vi.fn(async () => null),
    };
    const store = {
      apis: new Map([['guild.example', api]]),
      guilds: new Map(),
      home: null,
    };

    render(createElement(
      StoreProvider,
      { store },
      createElement(RichActivityCard, {
        activity: {
          name: 'Sonora',
          type: 2,
          details: 'Daily Lookback',
          state: 'Masato Kouda',
          assets: {
            large_image: `https://home.example/_telium/v1/media/${hash}?cap=music-cap`,
            large_media: {
              origin: 'home.example',
              hash,
              capability: 'music-cap',
            },
            large_text: 'Album cover',
          },
        },
      }),
    ));

    const artwork = document.querySelector('img[title="Album cover"]');
    expect(artwork?.getAttribute('src')).toBe(
      `https://guild.example/_telium/v1/media/remote/home.example/${hash}?cap=music-cap`,
    );
    expect(api.embed).not.toHaveBeenCalled();
  });

  it('replaces album artwork live across the text-first track transition without a reload', () => {
    const firstHash = 'b'.repeat(64);
    const secondHash = 'c'.repeat(64);
    const api = {
      base: 'https://guild.example',
      domain: 'guild.example',
      embed: vi.fn(async () => null),
    };
    const store = {
      apis: new Map([['guild.example', api]]),
      guilds: new Map(),
      home: null,
    };
    const tree = (activity) => createElement(
      StoreProvider,
      { store },
      createElement(RichActivityCard, { activity }),
    );
    const media = (hash, capability) => ({
      large_image: `https://home.example/_telium/v1/media/${hash}?cap=${capability}`,
      large_media: { origin: 'home.example', hash, capability },
      large_text: `cover-${hash[0]}`,
    });

    const view = render(tree({
      name: 'Sonora',
      type: 2,
      details: 'Song one',
      state: 'Artist',
      assets: media(firstHash, 'cap-one'),
    }));
    expect(document.querySelector('img[title="cover-b"]')?.getAttribute('src')).toContain(firstHash);

    expect(() => view.rerender(tree({
      name: 'Sonora',
      type: 2,
      details: 'Song two',
      state: 'Artist',
      assets: null,
    }))).not.toThrow();
    expect(document.querySelector('img[title^="cover-"]')).toBeNull();

    view.rerender(tree({
      name: 'Sonora',
      type: 2,
      details: 'Song two',
      state: 'Artist',
      assets: media(secondHash, 'cap-two'),
    }));
    expect(document.querySelector('img[title="cover-c"]')?.getAttribute('src')).toContain(secondHash);
    expect(api.embed).not.toHaveBeenCalled();
  });

  it('never serializes an Electron-only artwork handle into network activity', () => {
    const normalized = normalizeRichActivity({
      name: 'Music',
      type: 2,
      details: 'Track',
      assets: { local_large_image: 'mpris-art:opaque', large_text: 'Album' },
    });
    expect(normalized.assets).toBeNull();
    expect(JSON.stringify(normalized)).not.toContain('mpris-art:opaque');
  });

  it('mirrors detected music into the signed-in users local profile presence immediately', async () => {
    let onActivity = null;
    const bridge = {
      runtime: 'electron',
      setRichPresenceEnabled: vi.fn(async () => {}),
      richPresenceActivity: vi.fn(async () => null),
      onRichPresenceChanged: vi.fn((callback) => {
        onActivity = callback;
        return () => { onActivity = null; };
      }),
    };
    Object.defineProperty(window, 'teliumDesktop', {
      configurable: true,
      value: bridge,
    });

    const userId = '@music:home.example';
    const store = new Emitter();
    store.session = { home: { user_id: userId } };
    store.me = { user_id: userId };
    store.prefs = {
      presence: 'online',
      status: { text: 'hello' },
      richPresenceMusicEnabled: true,
    };
    store.presence = new Map([[
      userId,
      { user_id: userId, status: 'online', custom_status: 'hello' },
    ]]);
    store.sharesStatus = () => true;
    store.presenceFor = () => ({ status: 'online', custom_status: 'hello' });
    store.gw = new Emitter();
    store.gw.setPresence = vi.fn();
    const presenceEvents = [];
    store.on('presence', (presence) => presenceEvents.push(presence));

    const dispose = installDesktopRichPresence(store);
    store.emit('ready');
    await Promise.resolve();

    expect(onActivity).toBeTypeOf('function');
    onActivity({
      name: 'Spotify',
      type: 2,
      details: 'One More Game',
      state: 'DJ KVNXD',
      timestamps: { start: 1_700_000_000_000, end: 1_700_000_122_000 },
    });

    expect(store.desktopRichActivity?.details).toBe('One More Game');
    expect(store.presence.get(userId)).toMatchObject({
      user_id: userId,
      status: 'online',
      custom_status: 'hello',
      rich_activity: {
        name: 'Spotify',
        type: 2,
        details: 'One More Game',
        state: 'DJ KVNXD',
      },
    });
    expect(store.presence.get(userId).activity).toContain('telium-rich-v1:');
    expect(presenceEvents.at(-1)?.rich_activity?.details).toBe('One More Game');

    const beforeClobber = store.gw.setPresence.mock.calls.length;
    store.emit('presence', {
      user_id: userId,
      status: 'online',
      custom_status: 'hello',
      activity: null,
      rich_activity: null,
    });
    await Promise.resolve();
    expect(store.gw.setPresence).toHaveBeenCalledTimes(beforeClobber + 1);
    const resolvePresence = store.gw.setPresence.mock.calls.at(-1)[0];
    expect(resolvePresence('guild.example').rich_activity).toMatchObject({
      name: 'Spotify',
      type: 2,
      details: 'One More Game',
    });

    const beforeOffline = store.gw.setPresence.mock.calls.length;
    store.emit('presence', {
      user_id: userId,
      status: 'offline',
      activity: null,
      rich_activity: null,
    });
    await Promise.resolve();
    expect(store.gw.setPresence).toHaveBeenCalledTimes(beforeOffline);

    onActivity(null);
    expect(store.presence.get(userId).rich_activity).toBeNull();
    expect(store.presence.get(userId).activity).toBeNull();

    dispose();
  });
});
