import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultWindowsMediaHelperPath,
  windowsMediaActivity,
  windowsMediaKind,
} from './windows-media-source.mjs';

test('packaged Windows media helper path wins over the ASAR-relative fallback', () => {
  const chosen = defaultWindowsMediaHelperPath({
    env: {},
    resourcesPath: 'C:\\Telium\\resources',
    exists: () => true,
  });
  assert.equal(
    chosen.replaceAll('\\', '/'),
    'C:/Telium/resources/windows-media/telium-windows-media.exe',
  );
});

test('Windows media respects an explicit playback type', () => {
  assert.equal(windowsMediaKind({ media_type: 'music', source_app_id: 'chrome.exe' }), 'music');
  assert.equal(windowsMediaKind({ media_type: 'video', source_app_id: 'spotify.exe' }), 'video');
});

test('Windows media uses conservative process/title fallbacks when type is unknown', () => {
  assert.equal(windowsMediaKind({ media_type: 'unknown', source_app_id: 'Spotify.exe', artist: 'Artist' }), 'music');
  assert.equal(windowsMediaKind({ media_type: 'unknown', source_app_id: 'msedge.exe', title: 'Video' }), 'video');
});

test('Windows media treats YouTube Music as music before generic YouTube video', () => {
  assert.equal(windowsMediaKind({
    media_type: 'unknown',
    source_app_id: 'chrome.exe',
    title: 'Song - YouTube Music',
  }), 'music');
});

test('Windows media ignores unrelated game/audio sessions', () => {
  assert.equal(windowsMediaKind({
    media_type: 'unknown',
    source_app_id: 'SomeGame.exe',
    title: 'Some Game',
  }), null);
  assert.equal(windowsMediaActivity({
    source_app_id: 'SomeGame.exe',
    title: 'Some Game',
    media_type: 'unknown',
  }), null);
});

test('Windows media normalizes a listening activity', () => {
  assert.deepEqual(windowsMediaActivity({
    source_app_id: 'Spotify.exe',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    media_type: 'music',
  }), {
    name: 'Spotify',
    type: 2,
    details: 'Song',
    state: 'Artist',
    timestamps: null,
    party: null,
    buttons: [],
    assets: null,
  });
});

test('Windows media normalizes a watching activity', () => {
  const activity = windowsMediaActivity({
    source_app_id: 'msedge.exe',
    title: 'A video',
    media_type: 'video',
  });
  assert.equal(activity.type, 3);
  assert.equal(activity.details, 'A video');
  assert.equal(activity.name, 'msedge');
});
