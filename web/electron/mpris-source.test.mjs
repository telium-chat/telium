import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { activityFromMpris, createMprisSource } from './mpris-source.mjs';

const variant = (value) => ({ signature: '?', value });

function song(overrides = {}) {
  return {
    service: 'org.mpris.MediaPlayer2.spotify',
    identity: 'Spotify',
    playbackStatus: 'Playing',
    metadata: {
      'xesam:title': variant('akihabara'),
      'xesam:artist': variant(['venny']),
      'xesam:album': variant('night drive'),
      'mpris:length': variant(150_000_000n),
      'mpris:artUrl': variant('https://covers.example/album.jpg'),
    },
    positionMicros: 30_000_000n,
    ...overrides,
  };
}

test('turns MPRIS music metadata into a Listening activity with playback timestamps', () => {
  const now = 1_800_000_000_000;
  const activity = activityFromMpris(song(), now);
  assert.deepEqual(activity, {
    name: 'Spotify',
    type: 2,
    details: 'akihabara',
    state: 'venny',
    timestamps: { start: now - 30_000, end: now + 120_000 },
    party: null,
    buttons: [],
    assets: {
      large_image: 'https://covers.example/album.jpg',
      large_text: 'night drive',
    },
  });
});

test('uses Watching for explicit MPRIS video metadata', () => {
  const activity = activityFromMpris(song({
    identity: 'VLC media player',
    service: 'org.mpris.MediaPlayer2.vlc',
    metadata: {
      ...song().metadata,
      'xesam:mimeType': variant('video/mp4'),
      'xesam:url': variant('file:///home/alice/Videos/demo.mp4'),
    },
  }));
  assert.equal(activity.type, 3);
});

test('recognizes video URLs while keeping YouTube Music as Listening', () => {
  const video = activityFromMpris(song({
    identity: 'Firefox',
    service: 'org.mpris.MediaPlayer2.firefox.instance_42',
    metadata: {
      ...song().metadata,
      'xesam:album': variant(''),
      'xesam:url': variant('https://www.youtube.com/watch?v=demo'),
    },
  }));
  assert.equal(video.type, 3);

  const music = activityFromMpris(song({
    identity: 'Firefox',
    service: 'org.mpris.MediaPlayer2.firefox.instance_42',
    metadata: {
      ...song().metadata,
      'xesam:album': variant(''),
      'xesam:url': variant('https://music.youtube.com/watch?v=demo'),
    },
  }));
  assert.equal(music.type, 2);
});

test('uses a browser no-album fallback for YouTube-style MPRIS sessions', () => {
  const activity = activityFromMpris(song({
    identity: 'Brave',
    service: 'org.mpris.MediaPlayer2.chromium.instance1234',
    metadata: {
      'xesam:title': variant('A video title'),
      'xesam:artist': variant(['Creator channel']),
      'xesam:album': variant(''),
      'mpris:length': variant(600_000_000n),
      'mpris:artUrl': variant('file:///tmp/.org.chromium.Chromium/example-cover'),
    },
  }));
  assert.equal(activity.type, 3);
});

test('explicit audio metadata wins over the browser fallback', () => {
  const activity = activityFromMpris(song({
    identity: 'Chromium',
    service: 'org.mpris.MediaPlayer2.chromium.instance1234',
    metadata: {
      'xesam:title': variant('A song'),
      'xesam:artist': variant(['Artist']),
      'xesam:album': variant(''),
      'xesam:mimeType': variant('audio/ogg'),
      'mpris:length': variant(180_000_000n),
    },
  }));
  assert.equal(activity.type, 2);
});

test('keeps local album artwork local until Electron replaces it with an opaque handle', () => {
  const activity = activityFromMpris(song({
    metadata: {
      ...song().metadata,
      'mpris:artUrl': variant('file:///home/alice/.cache/player/cover.jpg'),
    },
  }), 1_800_000_000_000);
  assert.equal(activity.assets.large_image, undefined);
  assert.equal(activity.assets.local_large_image, 'file:///home/alice/.cache/player/cover.jpg');
});

test('does not publish paused or metadata-less media as music presence', () => {
  assert.equal(activityFromMpris(song({ playbackStatus: 'Paused' })), null);
  assert.equal(activityFromMpris(song({ metadata: {} })), null);
});

test('MPRIS source discovers players, reports health, and clears them when the bus name disappears', async () => {
  class Interface extends EventEmitter {}
  const busIface = new Interface();
  busIface.ListNames = async () => ['org.mpris.MediaPlayer2.spotify'];
  const props = new Interface();
  props.GetAll = async (iface) => iface === 'org.mpris.MediaPlayer2.Player'
    ? {
      PlaybackStatus: variant('Playing'),
      Metadata: variant(song().metadata),
    }
    : { Identity: variant('Spotify') };
  props.Get = async () => variant(30_000_000n);
  const playerIface = new Interface();
  const bus = new EventEmitter();
  bus.getProxyObject = async (name) => {
    if (name === 'org.freedesktop.DBus') {
      return { getInterface: () => busIface };
    }
    return {
      getInterface: (iface) => iface === 'org.freedesktop.DBus.Properties' ? props : playerIface,
    };
  };
  bus.disconnect = () => {};
  const seen = [];
  const statuses = [];
  const source = createMprisSource({
    dbusModule: { sessionBus: () => bus },
    onActivity: (entry) => seen.push(entry),
    onStatus: (status) => statuses.push(status),
  });
  assert.equal(await source.start(), true);
  assert.equal(seen.at(-1).activity.details, 'akihabara');
  assert.deepEqual(statuses.at(-1), {
    available: true,
    state: 'watching',
    reason: null,
    players: 1,
    readable: 1,
    playing: 1,
    names: ['Spotify'],
    bus: 'injected',
  });

  busIface.emit('NameOwnerChanged', 'org.mpris.MediaPlayer2.spotify', ':1.42', '');
  assert.equal(seen.at(-1).activity, null);
  assert.equal(statuses.at(-1).state, 'no-players');
  assert.equal(statuses.at(-1).players, 0);
  await source.stop();
  assert.equal(statuses.at(-1).state, 'stopped');
});

test('MPRIS source distinguishes a healthy session bus with no media players', async () => {
  class Interface extends EventEmitter {}
  const busIface = new Interface();
  busIface.ListNames = async () => ['org.freedesktop.DBus'];
  const bus = new EventEmitter();
  bus.getProxyObject = async () => ({ getInterface: () => busIface });
  bus.disconnect = () => {};
  const statuses = [];
  const source = createMprisSource({
    dbusModule: { sessionBus: () => bus },
    onStatus: (status) => statuses.push(status),
  });

  assert.equal(await source.start(), true);
  assert.equal(statuses.at(-1).available, true);
  assert.equal(statuses.at(-1).state, 'no-players');
  assert.equal(statuses.at(-1).players, 0);
  await source.stop();
});
