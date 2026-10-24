import { createElement } from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichActivityCard } from '../components/RichActivityCard.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { richActivityOf } from '../lib/activity.js';
import { installDesktopRichPresence } from '../lib/rich-presence.js';
import { Emitter } from '../lib/util.js';
import { activityFromMpris } from '../../electron/mpris-source.mjs';

vi.mock('../lib/image.js', async (importOriginal) => ({
  ...(await importOriginal()),
  reencode: async () => new File([new Uint8Array([1, 2, 3])], 'cover.webp', { type: 'image/webp' }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete window.teliumDesktop;
});

const TRACK_MICROS = 173_000_000;

function mprisSnapshot(positionMicros, title = 'Daily Lookback') {
  return {
    service: 'org.mpris.MediaPlayer2.spotify',
    identity: 'Spotify',
    playbackStatus: 'Playing',
    metadata: {
      'xesam:title': title,
      'xesam:artist': ['Masato Kouda'],
      'xesam:album': 'Sonora',
      'mpris:length': TRACK_MICROS,
    },
    positionMicros,
  };
}

describe('detected activity holds still while nothing changes', () => {
  it('keeps one set of timestamps across repeated reports of the same track', () => {
    const t0 = 1_700_000_000_000;
    const first = activityFromMpris(mprisSnapshot(30_000_000), t0);
    expect(first.timestamps).toEqual({ start: t0 - 30_000, end: t0 - 30_000 + 173_000 });

    const drifted = activityFromMpris(
      { ...mprisSnapshot(30_850_000), previous: first },
      t0 + 900,
    );
    expect(drifted.timestamps).toBe(first.timestamps);
    expect(drifted).toEqual({ ...first, timestamps: first.timestamps });

    const seeked = activityFromMpris(
      { ...mprisSnapshot(120_000_000), previous: drifted },
      t0 + 900,
    );
    expect(seeked.timestamps.start).toBe(t0 + 900 - 120_000);

    const next = activityFromMpris(
      { ...mprisSnapshot(0, 'Night Drive'), previous: seeked },
      t0 + 2_000,
    );
    expect(next.details).toBe('Night Drive');
    expect(next.timestamps.start).toBe(t0 + 2_000);
  });

  it('never publishes a song without the cover it has already uploaded', async () => {
    let onActivity = null;
    Object.defineProperty(window, 'teliumDesktop', {
      configurable: true,
      value: {
        runtime: 'electron',
        setRichPresenceEnabled: vi.fn(async () => {}),
        richPresenceActivity: vi.fn(async () => null),
        onRichPresenceChanged: vi.fn((callback) => { onActivity = callback; return () => {}; }),
        readRichPresenceArtwork: vi.fn(async () => ({
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
          mime: 'image/png',
          name: 'cover.png',
        })),
      },
    });
    const hash = 'a'.repeat(64);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        origin: 'home.example',
        hash,
        capability: 'cap',
        url: `https://home.example/_telium/v1/media/${hash}?cap=cap`,
      }),
    });

    const userId = '@m:home.example';
    const store = new Emitter();
    store.session = { home: { user_id: userId } };
    store.me = { user_id: userId };
    store.prefs = {
      presence: 'online',
      status: { text: '' },
      richPresenceMusicEnabled: true,
    };
    store.presence = new Map();
    store.home = { base: 'https://home.example', token: 'home-token' };
    store.sharesStatus = () => true;
    store.presenceFor = () => ({ status: 'online', custom_status: null });
    store.gw = new Emitter();
    store.gw.setPresence = vi.fn();
    const covers = [];
    store.on('presence', (p) => covers.push(richActivityOf(p)?.assets?.large_media || null));

    const dispose = installDesktopRichPresence(store);
    store.emit('ready');
    await Promise.resolve();

    const song = (positionMs) => ({
      name: 'Spotify',
      type: 2,
      details: 'Daily Lookback',
      state: 'Masato Kouda',
      timestamps: { start: 1_700_000_000_000 - positionMs, end: 1_700_000_173_000 },
      assets: { local_large_image: 'mpris-art:one', large_text: 'Sonora' },
    });

    onActivity(song(0));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(covers.at(-1)).toEqual({ origin: 'home.example', hash, capability: 'cap' });

    const settled = covers.length;
    onActivity(song(950));
    onActivity(song(1_900));
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(covers.slice(settled)).not.toContain(null);
    expect(covers.slice(settled).length).toBeGreaterThan(0);
    dispose();
  });
});

describe('the card survives a presence that says the same thing again', () => {
  const store = {
    apis: new Map(),
    guilds: new Map(),
    home: { base: 'https://home.example', domain: 'home.example' },
  };
  const hash = 'b'.repeat(64);
  const tree = (activity) => createElement(
    StoreProvider,
    { store },
    createElement(RichActivityCard, { activity }),
  );
  const cover = (digest) => ({ origin: 'home.example', hash: digest, capability: 'cap' });
  const song = () => ({
    name: 'Spotify',
    type: 2,
    details: 'Daily Lookback',
    state: 'Masato Kouda',
    timestamps: { start: Date.now() - 30_000, end: Date.now() + 140_000 },
    assets: {
      large_image: null,
      large_media: cover(hash),
      large_text: 'Sonora',
    },
  });

  it('keeps the very same <img> element rather than tearing it down', () => {
    const view = render(tree(song()));
    const before = document.querySelector('.activity-card__cover');
    expect(before?.tagName).toBe('IMG');

    view.rerender(tree(song()));
    expect(document.querySelector('.activity-card__cover')).toBe(before);

    view.rerender(tree({
      ...song(),
      details: 'Night Drive',
      assets: { large_image: null, large_media: cover('c'.repeat(64)) },
    }));
    expect(document.querySelector('.activity-card__cover')?.getAttribute('src'))
      .toContain('c'.repeat(64));
  });

  it('holds the artwork tile open when a presence arrives without a cover', () => {
    const view = render(tree(song()));
    const box = document.querySelector('.activity-card__art');
    expect(box).not.toBeNull();

    view.rerender(tree({ ...song(), details: 'Night Drive', assets: null }));
    expect(document.querySelector('.activity-card__art')).toBe(box);
    expect(document.querySelector('.activity-card__cover--empty')).not.toBeNull();
  });
});
