import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RichActivityCard } from '../components/RichActivityCard.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import {
  decodeRichActivity, encodeRichActivity, normalizeRichActivity, normalizeRichActivities,
  richActivitiesOf,
} from '../lib/activity.js';
import {
  installDesktopRichPresence,
  richPresenceActivityAllowed,
  richPresenceKinds,
} from '../lib/rich-presence.js';
import { KEYS, SyncStore } from '../lib/sync.js';
import { activityLine, Emitter, statusLine } from '../lib/util.js';
import { createApplicationNameResolver } from '../../electron/rich-presence-name.mjs';

describe('rich presence compatibility', () => {
  it('round-trips the legacy activity envelope through the viewer normalizer', () => {
    const activity = {
      name: 'Minecraft',
      type: 0,
      details: 'Survival',
      state: 'Overworld',
      timestamps: { start: 1_700_000_000_000 },
      party: { size: [2, 4] },
      buttons: [{ label: 'Website', url: 'https://example.com/' }],
      assets: {
        large_image: 'https://cdn.discordapp.com/app-icons/123456789012345678/abcdef.png?size=128',
        large_text: 'Minecraft',
      },
    };
    expect(decodeRichActivity(encodeRichActivity(activity))).toEqual(normalizeRichActivity(activity));
  });

  it('keeps one bounded rich activity per desktop category', () => {
    const many = normalizeRichActivities([
      { name: 'Minecraft', type: 0 },
      { name: 'Second game', type: 5 },
      { name: 'Album', type: 2 },
      { name: 'Video', type: 3 },
      { name: 'Second video', type: 1 },
    ]);
    expect(many.map((activity) => activity.name)).toEqual(['Minecraft', 'Album', 'Video']);

    expect(richActivitiesOf({
      rich_activities: many,
      rich_activity: { name: 'legacy winner', type: 0 },
    })).toEqual(many);
    expect(richActivitiesOf({
      rich_activity: { name: 'legacy winner', type: 0 },
    })).toEqual([normalizeRichActivity({ name: 'legacy winner', type: 0 })]);
  });

  it('renders new-server and old-server presence the same way', () => {
    const rich = { name: 'Minecraft', type: 0 };
    expect(activityLine({ rich_activity: rich, activity: 'Minecraft' })).toBe('Playing Minecraft');
    expect(activityLine({ activity: encodeRichActivity(rich) })).toBe('Playing Minecraft');
  });

  it('keeps a custom status ahead of automatic activity', () => {
    expect(statusLine({
      custom_status: 'busy building',
      rich_activity: { name: 'Minecraft', type: 0 },
    })).toBe('busy building');
  });

  it('uses Discord activity verbs where they are meaningful', () => {
    expect(activityLine({ rich_activity: { name: 'Album', type: 2 } })).toBe('Listening to Album');
    expect(activityLine({ rich_activity: { name: 'Stream', type: 3 } })).toBe('Watching Stream');
    expect(activityLine({ rich_activity: { name: 'Tournament', type: 5 } })).toBe('Competing in Tournament');
  });

  it('splits game, music and video into independent local presence choices', () => {
    const store = { prefs: {} };
    expect(richPresenceKinds(store)).toEqual({ game: true, music: false, video: false });
    expect(richPresenceActivityAllowed(store, { type: 0 })).toBe(true);
    expect(richPresenceActivityAllowed(store, { type: 1 })).toBe(false);
    expect(richPresenceActivityAllowed(store, { type: 2 })).toBe(false);
    expect(richPresenceActivityAllowed(store, { type: 3 })).toBe(false);

    store.prefs.richPresenceMusicEnabled = true;
    expect(richPresenceKinds(store)).toEqual({ game: true, music: true, video: false });
    expect(richPresenceActivityAllowed(store, { type: 2 })).toBe(true);
    expect(richPresenceActivityAllowed(store, { type: 3 })).toBe(false);

    store.prefs.richPresenceVideoEnabled = true;
    expect(richPresenceKinds(store)).toEqual({ game: true, music: true, video: true });
    expect(richPresenceActivityAllowed(store, { type: 1 })).toBe(true);
    expect(richPresenceActivityAllowed(store, { type: 3 })).toBe(true);

    store.prefs = { richPresenceEnabled: false, richPresenceMusicEnabled: true };
    expect(richPresenceKinds(store)).toEqual({ game: false, music: true, video: false });
  });

  it('renders structured activity as a profile-ready card with large and small artwork', () => {
    const html = renderToStaticMarkup(createElement(RichActivityCard, {
      activity: {
        name: 'Geometry Dash',
        type: 0,
        details: 'Stereo Madness',
        state: 'Practice Mode',
        party: { size: [1, 4] },
        buttons: [{ label: 'Website', url: 'https://example.com/play' }],
        assets: {
          large_image: 'https://cdn.discordapp.com/app-assets/123456789012345678/222222222222222222.png?size=256',
          large_text: 'Stereo Madness',
          small_image: 'https://media.discordapp.net/external/hash/https/example.com/icon.png',
          small_text: 'Practice Mode',
        },
      },
    }));
    expect(html).toContain('Playing');
    expect(html).toContain('Geometry Dash');
    expect(html).toContain('Stereo Madness');
    expect(html).toContain('Practice Mode');
    expect(html).toContain('1 of 4 in party');
    expect(html).toContain('https://example.com/play');

    expect(html).not.toContain('cdn.discordapp.com');
    expect(html).not.toContain('media.discordapp.net');
  });

  it('renders listening activity with a Discord-style playback progress bar', () => {
    const now = Date.now();
    const html = renderToStaticMarkup(createElement(RichActivityCard, {
      activity: {
        name: 'Music',
        type: 2,
        details: 'akihabara',
        state: 'venny',
        timestamps: { start: now - 30_000, end: now + 120_000 },
        assets: {
          large_image: 'https://cdn.discordapp.com/app-assets/123456789012345678/222222222222222222.png?size=256',
          small_image: 'https://cdn.discordapp.com/app-icons/123456789012345678/abcdef.png?size=128',
        },
      },
    }));
    expect(html).toContain('Listening to');
    expect(html).toContain('akihabara');
    expect(html).toContain('venny');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Playback progress"');
    expect(html).toContain('02:30');
  });

  it('resolves arbitrary external artwork and keeps the app icon as the small badge', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ name: 'Example Player', icon: 'abc123' }),
    }));
    const resolver = createApplicationNameResolver({
      fetchImpl,
      endpoints: () => ['https://discord.invalid/application'],
      assetsEndpoint: () => 'https://discord.invalid/assets',
    });
    const artwork = await resolver.resolveArtwork('123456789012345678', {
      large_image: 'https://covers.example/song/album.png',
      large_text: 'Album cover',
    });

    expect(artwork).toEqual({
      large_image: 'https://covers.example/song/album.png',
      large_text: 'Album cover',
      small_image: 'https://cdn.discordapp.com/app-icons/123456789012345678/abc123.png?size=128',
      small_text: 'Example Player',
    });
    expect(normalizeRichActivity({ name: 'Music', type: 2, assets: artwork })?.assets).toEqual(artwork);
  });

  it('renders external artwork directly in the local desktop preview only', () => {
    const raw = 'https://covers.example/local-preview/album.png';
    const small = 'https://cdn.discordapp.com/app-icons/123456789012345678/abcdef.png?size=128';
    const html = renderToStaticMarkup(createElement(RichActivityCard, {
      allowDirectExternal: true,
      activity: {
        name: 'Music',
        type: 2,
        assets: {
          large_image: raw,
          large_text: 'Album cover',
          small_image: small,
          small_text: 'Music',
        },
      },
    }));
    expect(html).toContain(raw);
    expect(html).toContain(small);
    expect(html).toContain('Album cover');
  });

  it('proxies arbitrary external artwork instead of hotlinking it from the viewer', async () => {
    const raw = 'https://covers.example/another-app/custom-art.png';
    const camo = `https://guild.example/_telium/v1/camo/${'a'.repeat(64)}`;
    const api = {
      base: 'https://guild.example',
      embed: vi.fn(async (url) => ({ status: 'ok', image: url === raw ? camo : null })),
    };
    const store = {
      guilds: new Map([['guild-1', { id: 'guild-1' }]]),
      apiForGuild: vi.fn(() => api),
    };

    render(createElement(
      StoreProvider,
      { store },
      createElement(RichActivityCard, {
        activity: {
          name: 'Another App',
          assets: {
            large_image: raw,
            large_text: 'Custom artwork',
            small_image: 'https://cdn.discordapp.com/app-icons/123456789012345678/abcdef.png?size=128',
          },
        },
      }),
    ));

    expect(document.querySelector(`img[src="${raw}"]`)).toBeNull();
    await waitFor(() => {
      expect(document.querySelector('img[title="Custom artwork"]')?.getAttribute('src')).toBe(camo);
    });
    expect(api.embed).toHaveBeenCalledWith(raw);
  });

  it('refuses a camo path the answering server hosted somewhere else entirely', async () => {
    const raw = 'https://covers.example/another-app/tracked-art.png';
    const api = {
      base: 'https://guild.example',
      embed: vi.fn(async () => ({
        status: 'ok',
        image: `https://tracker.example/_telium/v1/camo/${'b'.repeat(64)}`,
      })),
    };
    const store = {
      guilds: new Map([['guild-1', { id: 'guild-1' }]]),
      apiForGuild: vi.fn(() => api),
    };

    render(createElement(
      StoreProvider,
      { store },
      createElement(RichActivityCard, {
        activity: { name: 'Another App', assets: { large_image: raw, large_text: 'Custom artwork' } },
      }),
    ));

    await waitFor(() => expect(api.embed).toHaveBeenCalledWith(raw));
    expect(document.body.innerHTML).not.toContain('tracker.example');
    expect(document.querySelector('img[title="Custom artwork"]')).toBeNull();
  });

  it('drops unsafe rich-presence buttons, artwork and malformed envelopes', () => {
    const normalized = normalizeRichActivity({
      name: 'Game',
      buttons: [
        { label: 'bad', url: 'javascript:alert(1)' },
        { label: 'good', url: 'https://example.com/play' },
      ],
      assets: {
        large_image: 'javascript:alert(1)',
        small_image: 'https://user:password@example.com/private.png',
        large_text: 'do not render',
      },
    });
    expect(normalized?.buttons).toEqual([{ label: 'good', url: 'https://example.com/play' }]);
    expect(normalized?.assets).toBeNull();
    expect(activityLine({ activity: 'telium-rich-v1:{not json' })).toBe('');
  });

  it('keeps the rich-presence switches local to this device', async () => {
    const remotePrefs = {
      theme: 'light',
      richPresenceEnabled: true,
      richPresenceGameEnabled: false,
      richPresenceMusicEnabled: true,
      richPresenceVideoEnabled: false,
      voiceRegion: 'remote-region',
    };
    const api = {
      sync: vi.fn(async () => ({
        [KEYS.prefs]: { value: remotePrefs, updated_at: 10 },
      })),
      syncPut: vi.fn(async () => {}),
    };

    const fresh = new SyncStore();
    await fresh.load(api);
    expect(fresh.get(KEYS.prefs).theme).toBe('light');
    expect(fresh.get(KEYS.prefs).richPresenceEnabled).toBeUndefined();
    expect(fresh.get(KEYS.prefs).richPresenceGameEnabled).toBeUndefined();
    expect(fresh.get(KEYS.prefs).richPresenceMusicEnabled).toBeUndefined();
    expect(fresh.get(KEYS.prefs).richPresenceVideoEnabled).toBeUndefined();
    expect(fresh.get(KEYS.prefs).voiceRegion).toBeUndefined();

    const existing = new SyncStore();
    existing.get(KEYS.prefs).richPresenceEnabled = false;
    existing.get(KEYS.prefs).richPresenceGameEnabled = true;
    existing.get(KEYS.prefs).richPresenceMusicEnabled = false;
    existing.get(KEYS.prefs).richPresenceVideoEnabled = true;
    existing.get(KEYS.prefs).voiceRegion = 'local-region';
    await existing.load(api);
    expect(existing.get(KEYS.prefs).richPresenceEnabled).toBe(false);
    expect(existing.get(KEYS.prefs).richPresenceGameEnabled).toBe(true);
    expect(existing.get(KEYS.prefs).richPresenceMusicEnabled).toBe(false);
    expect(existing.get(KEYS.prefs).richPresenceVideoEnabled).toBe(true);
    expect(existing.get(KEYS.prefs).voiceRegion).toBe('local-region');
  });

  it('defaults to game-only after authentication and respects an explicit local opt-out', async () => {
    const enabledCalls = [];
    const bridge = {
      runtime: 'electron',
      setRichPresenceEnabled: vi.fn(async (enabled) => { enabledCalls.push(enabled); }),
      richPresenceActivity: vi.fn(async () => null),
      onRichPresenceChanged: vi.fn(() => () => {}),
    };
    Object.defineProperty(window, 'teliumDesktop', {
      configurable: true,
      value: bridge,
    });

    const store = new Emitter();
    store.session = null;
    store.prefs = { presence: 'online' };
    store.sharesStatus = () => true;
    store.presenceFor = () => ({ status: 'online', custom_status: null });
    store.gw = new Emitter();
    store.gw.setPresence = vi.fn();

    const dispose = installDesktopRichPresence(store);
    await Promise.resolve();
    expect(enabledCalls).toEqual([false]);

    store.session = { home: { user_id: '@a:x' } };
    store.emit('ready');
    expect(enabledCalls).toEqual([false, true]);
    expect(bridge.setRichPresenceEnabled).toHaveBeenLastCalledWith(true, {
      game: true,
      music: false,
      video: false,
    });

    const publishes = store.gw.setPresence.mock.calls.length;
    store.gw.emit('ready', { domain: 'guilds.example' });
    expect(store.gw.setPresence).toHaveBeenCalledTimes(publishes + 1);

    store.session = null;
    store.emit('signout');
    expect(enabledCalls).toEqual([false, true, false]);

    store.prefs.richPresenceEnabled = false;
    store.session = { home: { user_id: '@b:x' } };
    store.emit('ready');
    expect(enabledCalls).toEqual([false, true, false, false]);

    store.prefs.richPresenceEnabled = true;
    store.emit('prefs');
    expect(enabledCalls).toEqual([false, true, false, false, true]);

    store.prefs.richPresenceMusicEnabled = true;
    store.emit('prefs');
    expect(bridge.setRichPresenceEnabled).toHaveBeenLastCalledWith(true, {
      game: true,
      music: true,
      video: false,
    });

    dispose();
    delete window.teliumDesktop;
  });
});
