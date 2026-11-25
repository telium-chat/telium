// Swipe back from a pushed page to the list beneath it (phone settings). The page
// follows the finger toward the inline end, the list shows through underneath, and
// a flick or a drag past 40% goes back; anything less slides the page home again.

import { useEffect, useRef } from 'react';

const SLOP = 10;
const FLING = 0.35;
const LEAVE_MS = 180;
const LOCKED = 'input, textarea, select, [contenteditable="true"], [role="slider"], [data-swipe-lock]';

/// A sideways scroller that can still scroll back toward its start keeps the drag.
function scrollsSideways(target, stop) {
  for (let el = target; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const overflow = getComputedStyle(el).overflowX;
    if ((overflow === 'auto' || overflow === 'scroll') && Math.abs(el.scrollLeft) > 0) return true;
  }
  return false;
}

/// `rootRef` gets `data-swiping` and `--swipe-progress` while a drag is live.
export function useSwipeBack(rootRef, paneRef, { enabled, onBack, canLeave = () => true }) {
  const opts = useRef({ enabled, onBack, canLeave });
  opts.current = { enabled, onBack, canLeave };

  useEffect(() => {
    const root = rootRef.current;
    const pane = paneRef.current;
    if (!root || !pane) return undefined;
    let drag = null;

    const rtl = () => document.documentElement.dir === 'rtl';
    // `translate`, not `transform`: the page's own slide-in animation owns transform,
    // and taking it over would replay that animation when the drag lets go.
    const place = (px, transition) => {
      pane.style.transition = transition;
      pane.style.translate = px ? `${px}px 0` : '';
    };
    const finish = () => {
      root.removeAttribute('data-swiping');
      root.style.removeProperty('--swipe-progress');
      pane.style.transition = '';
      pane.style.translate = '';
    };

    const onStart = (e) => {
      drag = null;
      if (!opts.current.enabled || e.touches.length !== 1) return;
      if (e.target instanceof Element && e.target.closest(LOCKED)) return;
      const t = e.touches[0];
      drag = { x: t.clientX, y: t.clientY, target: e.target, active: false, samples: [] };
    };

    const onMove = (e) => {
      if (!drag || e.touches.length !== 1) return;
      const t = e.touches[0];
      const sign = rtl() ? -1 : 1;
      const dx = (t.clientX - drag.x) * sign;
      const dy = t.clientY - drag.y;
      const now = e.timeStamp || Date.now();
      drag.samples.push({ x: dx, t: now });
      while (drag.samples.length > 2 && now - drag.samples[0].t > 90) drag.samples.shift();
      if (!drag.active) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (dx <= 0 || Math.abs(dx) <= Math.abs(dy) * 1.2
          || scrollsSideways(drag.target, pane)) { drag = null; return; }
        drag.active = true;
        drag.start = dx;
        drag.width = pane.getBoundingClientRect().width || window.innerWidth;
        root.setAttribute('data-swiping', '');
      }
      e.preventDefault();
      const offset = Math.max(0, dx - drag.start);
      drag.offset = offset;
      root.style.setProperty('--swipe-progress', String(Math.min(1, offset / drag.width)));
      place(offset * sign, 'none');
    };

    const onEnd = (e) => {
      if (!drag?.active) { drag = null; return; }
      const { samples, offset = 0, width } = drag;
      drag = null;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const endedAt = e?.timeStamp || Date.now();
      const v = first && last && endedAt - last.t < 90 && last.t > first.t
        ? (last.x - first.x) / (last.t - first.t) : 0;
      const wants = e?.type !== 'touchcancel' && (v > FLING || offset > width * 0.4);
      const sign = rtl() ? -1 : 1;
      if (wants && opts.current.canLeave()) {
        root.style.setProperty('--swipe-progress', '1');
        place(width * sign, `translate ${LEAVE_MS}ms cubic-bezier(0.2, 0, 0, 1)`);
        setTimeout(() => {
          root.setAttribute('data-swiped', '');
          opts.current.onBack();
          // Let React swap in the list before the page is put back in place.
          requestAnimationFrame(() => requestAnimationFrame(finish));
          // `data-swiped` stays until the next page opens (SettingsLayout clears it):
          // removing it while the list is up would restart the list's slide-in.
        }, LEAVE_MS);
        return;
      }
      root.style.setProperty('--swipe-progress', '0');
      place(0, 'translate 220ms cubic-bezier(0.2, 0, 0, 1)');
      setTimeout(finish, 220);
      // Unsaved edits: the swipe asks, the same way the Back arrow does.
      if (wants) opts.current.onBack();
    };

    pane.addEventListener('touchstart', onStart, { passive: true });
    pane.addEventListener('touchmove', onMove, { passive: false });
    pane.addEventListener('touchend', onEnd, { passive: true });
    pane.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      pane.removeEventListener('touchstart', onStart);
      pane.removeEventListener('touchmove', onMove);
      pane.removeEventListener('touchend', onEnd);
      pane.removeEventListener('touchcancel', onEnd);
      finish();
    };
  }, [rootRef, paneRef]);
}
