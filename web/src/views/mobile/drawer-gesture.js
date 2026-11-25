// Finger-tracking drawer drags for the mobile shell. The drawers move with the finger
// and settle by fling velocity or distance, like Android's own navigation drawers.
// Drags can start anywhere in the content, not only at the screen edge: with gesture
// navigation the outer edges belong to the system Back gesture.

import { useEffect, useRef } from 'react';

const SLOP = 10;
const FLING = 0.35; // px per ms
const VELOCITY_WINDOW = 90; // ms of recent movement used for fling velocity

const EXCLUDED = 'input, textarea, select, [contenteditable="true"], .composer-shell, [role="dialog"], [data-mobile-gesture-lock]';

/// Which drag a horizontal movement starts. `dx` is physical (positive = rightwards).
/// Returns 'open-drawer' | 'close-drawer' | 'open-members' | 'close-members' | null.
export function pickDrawerDrag({ dx, rtl = false, drawerOpen, membersOpen, membersAvailable, onMessage = false }) {
  // Positive when moving toward the inline end (rightwards in LTR).
  const towardEnd = (rtl ? -dx : dx) > 0;
  if (drawerOpen) return towardEnd ? null : 'close-drawer';
  if (membersOpen) return towardEnd ? 'close-members' : null;
  if (towardEnd) return 'open-drawer';
  // Toward the start on a message is swipe-to-reply.
  if (!onMessage && membersAvailable) return 'open-members';
  return null;
}

/// Progress (0 closed … 1 open) for a drag of `dx` physical pixels.
export function dragProgress(action, dx, width, rtl = false) {
  if (!width) return action.startsWith('open') ? 0 : 1;
  const towardEnd = (rtl ? -dx : dx) / width;
  // The drawer sits at the inline start, members at the inline end.
  const delta = action.endsWith('drawer') ? towardEnd : -towardEnd;
  const base = action.startsWith('open') ? 0 : 1;
  return Math.min(1, Math.max(0, base + delta));
}

/// Whether a released drag leaves the panel open. A fling wins over position.
export function settleOpen(action, progress, velocity, rtl = false) {
  const towardEnd = (rtl ? -velocity : velocity);
  const opening = action.endsWith('drawer') ? towardEnd : -towardEnd;
  if (Math.abs(velocity) >= FLING) return opening > 0;
  return progress >= 0.5;
}

function scrollsHorizontally(target, root, dx) {
  for (let el = target; el && el !== root; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const overflow = getComputedStyle(el).overflowX;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    // Can it still scroll the way the content would follow the finger?
    const max = el.scrollWidth - el.clientWidth;
    const left = Math.abs(el.scrollLeft);
    if (dx > 0 ? left > 0 : left < max - 1) return true;
  }
  return false;
}

/// Wires drags on `rootRef` to the drawer elements. `state` is read on every touch so
/// callers can pass a fresh object each render. `drawers[name]` must return the element
/// carrying `--drawer-progress` and `data-dragging` (see MobileDrawer).
export function useDrawerGestures(rootRef, state) {
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let drag = null;
    let frame = 0;

    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      drag = null;
    };

    const elFor = (action) => stateRef.current.drawers?.[action.endsWith('drawer') ? 'drawer' : 'members']?.();

    const onStart = (e) => {
      const s = stateRef.current;
      if (s.disabled || e.touches.length !== 1) { reset(); return; }
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(EXCLUDED)) { reset(); return; }
      const t = e.touches[0];
      drag = {
        target,
        x: t.clientX,
        y: t.clientY,
        samples: [{ x: t.clientX, t: e.timeStamp || Date.now() }],
        action: null,
        el: null,
        width: 0,
        progress: 0,
      };
    };

    const onMove = (e) => {
      if (!drag || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - drag.x;
      const dy = t.clientY - drag.y;
      const now = e.timeStamp || Date.now();
      drag.samples.push({ x: t.clientX, t: now });
      while (drag.samples.length > 2 && now - drag.samples[0].t > VELOCITY_WINDOW) drag.samples.shift();

      if (!drag.action) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (Math.abs(dx) <= Math.abs(dy) * 1.2) { reset(); return; }
        const s = stateRef.current;
        const action = pickDrawerDrag({
          dx,
          rtl: s.rtl,
          drawerOpen: s.drawerOpen,
          membersOpen: s.membersOpen,
          membersAvailable: s.membersAvailable,
          onMessage: Boolean(drag.target?.closest('.msg-row')),
        });
        if (!action || scrollsHorizontally(drag.target, root, dx)) { reset(); return; }
        const el = elFor(action);
        const panel = el?.querySelector('[data-drawer-panel]');
        if (!el || !panel) { reset(); return; }
        drag.action = action;
        drag.el = el;
        drag.width = panel.getBoundingClientRect().width || window.innerWidth * 0.85;
        // Measure from here so the panel doesn't jump by the slop distance.
        drag.x = t.clientX;
        el.setAttribute('data-dragging', '');
        s.onDragStart?.(action);
      }

      drag.progress = dragProgress(drag.action, t.clientX - drag.x, drag.width, stateRef.current.rtl);
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (drag?.el) drag.el.style.setProperty('--drawer-progress', String(drag.progress));
        });
      }
    };

    const finish = (cancelled, e) => {
      if (!drag?.action) { reset(); return; }
      const { action, el, samples } = drag;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const endedAt = e?.timeStamp || Date.now();
      // A finger that stopped before lifting is not a fling.
      const stale = endedAt - last.t > VELOCITY_WINDOW;
      const velocity = !stale && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      const wasOpen = action.startsWith('close');
      const open = cancelled ? wasOpen : settleOpen(action, drag.progress, velocity, stateRef.current.rtl);
      reset();
      el.removeAttribute('data-dragging');
      el.style.setProperty('--drawer-progress', open ? '1' : '0');
      if (open !== wasOpen) stateRef.current.onSettle?.(action.endsWith('drawer') ? 'drawer' : 'members', open);
    };

    const onEnd = (e) => finish(false, e);
    const onCancel = (e) => finish(true, e);

    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: true });
    root.addEventListener('touchend', onEnd, { passive: true });
    root.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onCancel);
      if (drag?.el) drag.el.removeAttribute('data-dragging');
      reset();
    };
  }, [rootRef]);
}
