// Pinch, pan and double-tap zoom for one element, applied as a transform on a
// wrapper. The page itself never zooms in the Android app, so photos zoom here.

import { useCallback, useEffect, useRef, useState } from 'react';

const MIN = 1;
const MAX = 5;
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_SCALE = 2.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

/// Keeps the zoomed content covering the screen instead of drifting off it.
export function clampOffset({ x, y, scale }, width, height) {
  const minX = width - width * scale;
  const minY = height - height * scale;
  return { x: clamp(x, minX, 0), y: clamp(y, minY, 0), scale };
}

/// Zoom about a screen point (origin 0 0): that point stays under the finger.
export function zoomAbout(view, point, scale) {
  const next = clamp(scale, MIN, MAX);
  const qx = (point.x - view.x) / view.scale;
  const qy = (point.y - view.y) / view.scale;
  return { x: point.x - qx * next, y: point.y - qy * next, scale: next };
}

const DISMISS_PX = 110;
const DISMISS_FLING = 0.5; // px per ms

/// `onSwipeDismiss`: at normal size, a vertical drag moves the photo with the finger
/// (`pull`, for fading the backdrop) and closes past DISMISS_PX or on a flick.
export function usePinchZoom(ref, { enabled = true, onDoubleTap, onSwipeDismiss } = {}) {
  const doubleTapRef = useRef(onDoubleTap);
  doubleTapRef.current = onDoubleTap;
  const dismissRef = useRef(onSwipeDismiss);
  dismissRef.current = onSwipeDismiss;
  const [pull, setPull] = useState(0);
  const [settling, setSettling] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [gesturing, setGesturing] = useState(false);

  const reset = useCallback(() => setView({ x: 0, y: 0, scale: 1 }), []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    let pinch = null;
    let pan = null;
    let swipe = null;
    let lastTap = 0;

    const size = () => ({ w: el.clientWidth || window.innerWidth, h: el.clientHeight || window.innerHeight });
    const apply = (next) => {
      const { w, h } = size();
      setView(clampOffset(next, w, h));
    };

    const onStart = (e) => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches;
        pinch = { d: dist(a, b), m: mid(a, b), view: viewRef.current };
        pan = null;
        if (swipe?.active) setPull(0);
        swipe = null;
        setGesturing(true);
      } else if (e.touches.length === 1 && viewRef.current.scale > 1) {
        const t = e.touches[0];
        pan = { x: t.clientX, y: t.clientY, view: viewRef.current, moved: false };
        setGesturing(true);
      } else if (e.touches.length === 1 && dismissRef.current) {
        const t = e.touches[0];
        swipe = { x: t.clientX, y: t.clientY, active: false, samples: [] };
      }
    };

    const onMove = (e) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        const m = mid(a, b);
        const scaled = zoomAbout(pinch.view, pinch.m, pinch.view.scale * (dist(a, b) / pinch.d));
        apply({ ...scaled, x: scaled.x + (m.x - pinch.m.x), y: scaled.y + (m.y - pinch.m.y) });
      } else if (pan && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        const dx = t.clientX - pan.x;
        const dy = t.clientY - pan.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) pan.moved = true;
        apply({ ...pan.view, x: pan.view.x + dx, y: pan.view.y + dy });
      } else if (swipe && e.touches.length === 1) {
        const t = e.touches[0];
        const dx = t.clientX - swipe.x;
        const dy = t.clientY - swipe.y;
        const now = e.timeStamp || Date.now();
        swipe.samples.push({ y: dy, t: now });
        while (swipe.samples.length > 2 && now - swipe.samples[0].t > 90) swipe.samples.shift();
        if (!swipe.active) {
          if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
          if (Math.abs(dy) <= Math.abs(dx) * 1.2) { swipe = null; return; }
          swipe.active = true;
          swipe.y = t.clientY;
          setGesturing(true);
        }
        e.preventDefault();
        swipe.pull = t.clientY - swipe.y;
        setPull(swipe.pull);
      }
    };

    const onEnd = (e) => {
      if (pinch && e.touches.length < 2) {
        pinch = null;
        if (viewRef.current.scale <= 1.02) reset();
      }
      if (e.touches.length === 0 && swipe?.active) {
        const { samples, pull: dy = 0 } = swipe;
        swipe = null;
        lastTap = 0;
        setGesturing(false);
        const first = samples[0];
        const last = samples[samples.length - 1];
        const endedAt = e.timeStamp || Date.now();
        const v = first && last && endedAt - last.t < 90 && last.t > first.t
          ? (last.y - first.y) / (last.t - first.t) : 0;
        setPull(0);
        // Glide back to the middle rather than jumping there.
        setSettling(true);
        setTimeout(() => setSettling(false), 220);
        if (e.type !== 'touchcancel' && (Math.abs(dy) > DISMISS_PX || Math.abs(v) > DISMISS_FLING)) {
          dismissRef.current?.();
        }
        return;
      }
      if (e.touches.length === 0) swipe = null;
      if (e.touches.length === 0) {
        const wasPan = pan?.moved;
        pan = null;
        setGesturing(false);
        if (wasPan || e.changedTouches.length !== 1) { lastTap = 0; return; }
        const now = Date.now();
        if (now - lastTap < DOUBLE_TAP_MS) {
          lastTap = 0;
          doubleTapRef.current?.();
          const t = e.changedTouches[0];
          if (viewRef.current.scale > 1) reset();
          else apply(zoomAbout(viewRef.current, { x: t.clientX, y: t.clientY }, DOUBLE_TAP_SCALE));
          e.preventDefault();
        } else {
          lastTap = now;
        }
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [ref, enabled, reset]);

  const shrink = 1 - Math.min(0.15, Math.abs(pull) / 2000);
  return {
    zoomed: view.scale > 1,
    reset,
    // 0 … 1 as a dismiss drag travels, for fading the backdrop.
    pullProgress: Math.min(1, Math.abs(pull) / 300),
    style: pull || settling ? {
      transform: `translate3d(0, ${pull}px, 0) scale(${shrink})`,
      transformOrigin: '50% 50%',
      transition: gesturing ? 'none' : 'transform 200ms ease-out',
    } : view.scale === 1 && !gesturing ? undefined : {
      transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
      transformOrigin: '0 0',
      transition: gesturing ? 'none' : 'transform 200ms ease-out',
    },
  };
}
