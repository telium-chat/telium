// `preload="auto"`: someone opened this and agreed to the host.

import { positionClock } from './player.js';

export function createFilePlayer(source, container, hooks = {}) {
  const el = document.createElement('video');
  el.src = source.url;
  el.playsInline = true;
  el.preload = 'auto';
  el.className = 'h-full w-full bg-black object-contain';
  el.controls = false;
  container.append(el);

  // Held even here: a stalled or seeking element keeps reporting its last frame, which the engine would read as drift.
  const clock = positionClock();

  let stalled = false;
  const stall = () => {
    if (stalled) return;
    stalled = true;
    hooks.onStall?.();
  };
  const resume = () => {
    if (!stalled) return;
    stalled = false;
    hooks.onResume?.();
  };

  const on = (name, fn) => {
    el.addEventListener(name, fn);
    return () => el.removeEventListener(name, fn);
  };

  const off = [
    on('loadedmetadata', () => hooks.onReady?.(el.duration)),
    on('timeupdate', () => clock.mark(el.currentTime)),
    on('play', () => { clock.mark(el.currentTime); clock.start(); }),
    on('pause', () => clock.stop()),
    on('seeked', () => { clock.mark(el.currentTime); resume(); }),
    on('ended', () => { clock.stop(); hooks.onEnded?.(); }),
    on('waiting', stall),
    on('stalled', stall),
    on('playing', () => { clock.mark(el.currentTime); clock.start(); resume(); }),
    on('canplay', resume),
    on('error', () => hooks.onError?.(source.hls
      // An `.m3u8` failing on Chrome is not a broken link.
      ? 'This browser cannot play an HLS stream without help. Safari can; others need a '
        + 'direct .mp4 or .webm.'
      : 'This video could not be loaded.')),
  ];

  return {
    play() { return el.play().catch(() => {}); },
    pause() { el.pause(); },
    seek(seconds) { try { el.currentTime = Math.max(0, seconds); } catch {} },
    setRate(rate) { try { el.playbackRate = rate; } catch {} },
    position() { return el.seeking || stalled ? clock.read() : el.currentTime; },
    destroy() {
      for (const remove of off) remove();
      el.pause();
      // Empty the source too: a detached `<video>` with a src keeps its connection to the host open.
      el.removeAttribute('src');
      el.load();
      el.remove();
    },
  };
}
