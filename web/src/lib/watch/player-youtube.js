// YouTube's player, driven by posting JSON to the iframe instead of loading YouTube's script.
// Everything from the frame is network input: check origin and source window, validate every number.

import { positionClock } from './player.js';
import { embedUrl } from './providers.js';

const ORIGIN = 'https://www.youtube-nocookie.com';

const BUFFERING = 3;
const ENDED = 0;
const PLAYING = 1;

export function createYouTubePlayer(source, container, hooks = {}) {
  const frame = document.createElement('iframe');
  frame.src = embedUrl(source);
  frame.title = 'Video';
  frame.allow = 'autoplay; encrypted-media; picture-in-picture';
  // Not `no-referrer`: YouTube refuses it (Error 153).
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.className = 'h-full w-full border-0 bg-black';
  // Reduces what the frame can do to the page; it is not privacy.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
  container.append(frame);

  const clock = positionClock();
  // The frame echoes this id back so concurrent players cannot apply each other's position.
  const id = `telium-${Math.random().toString(36).slice(2, 10)}`;
  let ready = false;
  let stalled = false;
  let queued = [];

  const post = (message) => {
    const target = frame.contentWindow;
    if (!target) return;
    target.postMessage(JSON.stringify({ ...message, id, channel: 'widget' }), ORIGIN);
  };

  const command = (func, args = []) => {
    if (!ready) {
      queued = queued.filter((q) => q.func !== func).concat({ func, args });
      return;
    }
    post({ event: 'command', func, args });
  };

  const stall = () => {
    if (stalled) return;
    stalled = true;
    clock.stop();
    hooks.onStall?.();
  };
  const resume = () => {
    if (!stalled) return;
    stalled = false;
    hooks.onResume?.();
  };

  const onState = (state) => {
    if (state === BUFFERING) { stall(); return; }
    resume();
    if (state === PLAYING) clock.start();
    else clock.stop();
    if (state === ENDED) hooks.onEnded?.();
  };

  const onMessage = (event) => {
    if (event.origin !== ORIGIN || event.source !== frame.contentWindow) return;
    let body;
    try { body = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
    if (!body || typeof body !== 'object') return;
    if (body.id !== undefined && body.id !== null && String(body.id) !== id) return;

    if (body.event === 'onReady' || body.event === 'initialDelivery') {
      ready = true;
      const pending = queued;
      queued = [];
      for (const { func, args } of pending) post({ event: 'command', func, args });
      hooks.onReady?.(Number(body.info?.duration) || 0);
    }

    const info = body.info;
    if (!info || typeof info !== 'object') return;
    if (Number.isFinite(info.currentTime)) clock.mark(info.currentTime);
    if (Number.isFinite(info.playbackRate) && info.playbackRate > 0) clock.setRate(info.playbackRate);
    if (Number.isFinite(info.playerState)) onState(info.playerState);
  };

  window.addEventListener('message', onMessage);

  // The frame hears this only once its document is up, so ask on load and again shortly after.
  const announce = () => post({ event: 'listening' });
  frame.addEventListener('load', announce);
  const retry = setInterval(() => { if (!ready) announce(); }, 500);
  const giveUp = setTimeout(() => {
    clearInterval(retry);
    if (!ready) hooks.onError?.('The YouTube player did not respond. It may be blocked here, '
      + 'or the video may not allow embedding.');
  }, 10000);

  return {
    play() { command('playVideo'); },
    pause() { command('pauseVideo'); },
    seek(seconds) { clock.mark(Math.max(0, seconds)); command('seekTo', [Math.max(0, seconds), true]); },
    setRate(rate) { clock.setRate(rate); command('setPlaybackRate', [rate]); },
    position() { return clock.read(); },
    destroy() {
      clearInterval(retry);
      clearTimeout(giveUp);
      window.removeEventListener('message', onMessage);
      frame.removeEventListener('load', announce);
      frame.remove();
    },
  };
}
