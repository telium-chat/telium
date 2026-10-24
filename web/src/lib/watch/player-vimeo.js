// Position is extrapolated between `timeupdate` events; the clock stops on `bufferstart` and similar.

import { positionClock } from './player.js';
import { embedUrl } from './providers.js';

const ORIGIN = 'https://player.vimeo.com';

const EVENTS = ['ready', 'play', 'pause', 'timeupdate', 'seeked', 'ended', 'bufferstart', 'bufferend', 'error'];

export function createVimeoPlayer(source, container, hooks = {}) {
  const frame = document.createElement('iframe');
  frame.src = embedUrl(source);
  frame.title = 'Video';
  frame.allow = 'autoplay; encrypted-media; picture-in-picture';
  frame.referrerPolicy = 'no-referrer';
  frame.className = 'h-full w-full border-0 bg-black';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
  container.append(frame);

  const clock = positionClock();
  let ready = false;
  let stalled = false;
  let queued = [];

  const post = (message) => {
    frame.contentWindow?.postMessage(message, ORIGIN);
  };

  const call = (method, value) => {
    const message = value === undefined ? { method } : { method, value };
    if (!ready) {
      queued = queued.filter((q) => q.method !== method).concat(message);
      return;
    }
    post(message);
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

  const onMessage = (event) => {
    if (event.origin !== ORIGIN || event.source !== frame.contentWindow) return;
    let body;
    try { body = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
    if (!body || typeof body !== 'object') return;

    if (body.event === 'ready' && !ready) {
      ready = true;
      for (const name of EVENTS) post({ method: 'addEventListener', value: name });
      const pending = queued;
      queued = [];
      for (const message of pending) post(message);
      hooks.onReady?.(Number(body.data?.duration) || 0);
      return;
    }

    const seconds = Number(body.data?.seconds);
    if (Number.isFinite(seconds)) clock.mark(seconds);

    switch (body.event) {
      case 'play': resume(); clock.start(); break;
      case 'playing': resume(); clock.start(); break;
      case 'pause': clock.stop(); break;
      case 'bufferstart': stall(); break;
      case 'bufferend': resume(); break;
      case 'seeked': resume(); break;
      case 'ended': clock.stop(); hooks.onEnded?.(); break;
      case 'error':
        hooks.onError?.(typeof body.data?.message === 'string'
          ? body.data.message
          : 'This Vimeo video could not be played here.');
        break;
      default: break;
    }
  };

  window.addEventListener('message', onMessage);

  const giveUp = setTimeout(() => {
    if (!ready) hooks.onError?.('The Vimeo player did not respond. It may be blocked here, or '
      + 'the video may not allow embedding.');
  }, 10000);

  return {
    play() { call('play'); },
    pause() { call('pause'); },
    seek(seconds) { clock.mark(Math.max(0, seconds)); call('setCurrentTime', Math.max(0, seconds)); },
    setRate(rate) { clock.setRate(rate); call('setPlaybackRate', rate); },
    position() { return clock.read(); },
    destroy() {
      clearTimeout(giveUp);
      window.removeEventListener('message', onMessage);
      frame.remove();
    },
  };
}
