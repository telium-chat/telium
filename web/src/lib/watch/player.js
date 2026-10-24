// What the sync engine may assume about a player.
// `position()` must be synchronous: awaiting would compare against the room a round trip ago.
// Adapters never touch the timeline: a stall pause and a user pause look identical from in here.

import { createFilePlayer } from './player-file.js';
import { createVimeoPlayer } from './player-vimeo.js';
import { createYouTubePlayer } from './player-youtube.js';
import { embedUrl, providerById } from './providers.js';

export function createPlayer(source, container, hooks = {}) {
  // Fail as a caught error rather than an iframe with "null" in its `src`.
  if (!embedUrl(source)) throw new Error('No player for this source.');
  switch (source.provider) {
    case 'youtube': return createYouTubePlayer(source, container, hooks);
    case 'vimeo': return createVimeoPlayer(source, container, hooks);
    case 'file': return createFilePlayer(source, container, hooks);
    default: throw new Error('No player for this source.');
  }
}

/// `stop()` and seek freeze it: extrapolating from the old position would report a position no frame was shown at.
export function positionClock() {
  let at = 0;
  let stamped = 0;
  let rate = 1;
  let running = false;
  return {
    mark(seconds, now = Date.now()) {
      if (!Number.isFinite(seconds)) return;
      at = Math.max(0, seconds);
      stamped = now;
    },
    start(now = Date.now()) {
      if (running) return;
      stamped = now;
      running = true;
    },
    stop(now = Date.now()) {
      if (running) at = this.read(now);
      running = false;
      stamped = now;
    },
    setRate(next, now = Date.now()) {
      if (!Number.isFinite(next) || next <= 0) return;
      if (running) at = this.read(now);
      stamped = now;
      rate = next;
    },
    read(now = Date.now()) {
      if (!running) return at;
      return Math.max(0, at + ((now - stamped) / 1000) * rate);
    },
  };
}

export function connectsTo(source) {
  const provider = providerById(source?.provider);
  if (!provider) return null;
  if (provider.kind === 'file') {
    return {
      kind: 'file',
      name: provider.name,
      note: 'Your browser will request the video file directly from this host, '
        + 'which tells it your IP address.',
    };
  }
  return {
    kind: 'iframe',
    name: provider.name,
    note: `The ${provider.name} player runs in a frame inside this call. It talks to its own `
      + 'host on every frame it draws, which tells that host your IP address and that you are '
      + 'watching this — the same thing a link preview is proxied to avoid, and the reason it '
      + 'only happens here, once you say so.',
  };
}
