import { useEffect, useRef, useState } from 'react';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { isElectronRuntime } from '../lib/platform.js';

const cache = new Map();

function fromBase64(value) {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function loadDesktopGif(src) {
  let hit = cache.get(src);
  if (!hit) {
    hit = (async () => {
      let encoded;
      if (isElectronRuntime()) {
        encoded = await window.teliumDesktop.fetchGifBytes(src);
      } else {
        const { invoke } = await import('@tauri-apps/api/core');
        encoded = await invoke('fetch_gif_bytes', { url: src });
      }
      const bytes = fromBase64(encoded);
      const parsed = parseGIF(bytes.buffer);
      const frames = decompressFrames(parsed, true);
      if (!frames.length) throw new Error('GIF contains no frames.');
      return {
        width: parsed.lsd.width,
        height: parsed.lsd.height,
        frames,
      };
    })();
    hit.catch(() => cache.delete(src));
    cache.set(src, hit);
  }
  return hit;
}

function frameDelay(frame) {
  return Math.max(20, Number(frame?.delay) || 100);
}

export function ControlledGifCanvas({
  src, active, alt = '', className, style, onError, onLoad, onClick, title,
  loading = 'lazy', loader = loadDesktopGif,
}) {
  const canvasRef = useRef(null);
  const scratchRef = useRef(null);
  const activeRef = useRef(active);
  const pauseRef = useRef(null);
  const resumeRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  activeRef.current = active;

  useEffect(() => {
    let live = true;
    let timer = null;
    let deadline = 0;
    let remaining = 0;
    let current = -1;
    let restore = null;
    let decoded = null;

    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const schedule = (delay) => {
      clearTimer();
      remaining = Math.max(0, delay);
      deadline = Date.now() + remaining;
      timer = setTimeout(() => {
        timer = null;
        remaining = 0;
        drawNext();
      }, remaining);
    };

    const disposePrevious = (context) => {
      if (current < 0) return;
      const previous = decoded.frames[current];
      if (previous.disposalType === 2) {
        const { left, top, width, height } = previous.dims;
        context.clearRect(left, top, width, height);
      } else if (previous.disposalType === 3 && restore) {
        context.putImageData(restore, 0, 0);
      }
      restore = null;
    };

    const drawNext = () => {
      if (!live || !decoded) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d');
      if (!context) return;

      const next = (current + 1) % decoded.frames.length;
      disposePrevious(context);

      if (next === 0 && current >= 0) context.clearRect(0, 0, canvas.width, canvas.height);

      const frame = decoded.frames[next];
      if (frame.disposalType === 3) {
        restore = context.getImageData(0, 0, canvas.width, canvas.height);
      }

      const { left, top, width, height } = frame.dims;
      let scratch = scratchRef.current;
      if (!scratch) {
        scratch = document.createElement('canvas');
        scratchRef.current = scratch;
      }
      scratch.width = width;
      scratch.height = height;
      const scratchContext = scratch.getContext('2d');
      if (!scratchContext) return;
      const patch = scratchContext.createImageData(width, height);
      patch.data.set(frame.patch);
      scratchContext.putImageData(patch, 0, 0);
      context.drawImage(scratch, left, top);

      current = next;
      remaining = frameDelay(frame);
      if (activeRef.current) schedule(remaining);
    };

    const pause = () => {
      if (timer !== null) {
        remaining = Math.max(0, deadline - Date.now());
        clearTimer();
      }
    };
    const resume = () => {
      if (!decoded || timer !== null) return;
      if (current < 0) {
        drawNext();
        return;
      }
      schedule(remaining);
    };
    pauseRef.current = pause;
    resumeRef.current = resume;

    setReady(false);
    setFailed(false);

    (async () => {
      try {
        decoded = await loader(src);
        if (!live) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = decoded.width;
        canvas.height = decoded.height;
        setReady(true);
        drawNext();
        onLoad?.({ currentTarget: canvas, target: canvas });
      } catch {
        if (!live) return;
        setFailed(true);
      }
    })();

    return () => {
      live = false;
      clearTimer();
      pauseRef.current = null;
      resumeRef.current = null;
    };
  }, [src, loader, onLoad]);

  useEffect(() => {
    if (active) resumeRef.current?.();
    else pauseRef.current?.();
  }, [active, ready]);

  const showNative = !ready || failed;

  return (
    <>
      <img
        src={showNative ? src : undefined}
        alt={alt}
        loading={loading}
        className={className}
        style={showNative ? style : { ...style, display: 'none' }}
        title={title}
        onClick={onClick}
        onError={onError}
      />
      <canvas
        ref={canvasRef}
        role={ready && alt ? 'img' : undefined}
        aria-label={ready && alt ? alt : undefined}
        aria-hidden={ready ? undefined : true}
        className={className}
        style={ready ? style : { ...style, display: 'none' }}
        title={title}
        onClick={onClick}
      />
    </>
  );
}
