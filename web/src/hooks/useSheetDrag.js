// Drag-down-to-dismiss for bottom sheets. The sheet follows the finger once the drag
// is clearly downward and the content under the finger is scrolled to the top; it
// leaves on a flick or past a third of its height, and slides back otherwise.
// `dismiss()` plays the same exit for taps on the scrim and for Back.

import { useCallback, useEffect, useRef } from 'react';

const SLOP = 8;
const FLING = 0.5; // px per ms
const EXIT_MS = 200;

function scrolledAway(target, sheet) {
  for (let el = target; el && el !== sheet.parentElement; el = el.parentElement) {
    if (el.scrollTop > 0) return true;
    if (el === sheet) break;
  }
  return false;
}

export function useSheetDrag(onClose, { scrimRef } = {}) {
  const sheetRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const leaving = useRef(false);

  const setScrim = (opacity, transition) => {
    const scrim = scrimRef?.current;
    if (!scrim) return;
    scrim.style.animation = 'none';
    scrim.style.transition = transition;
    scrim.style.opacity = String(opacity);
  };

  const dismiss = useCallback(() => {
    const sheet = sheetRef.current;
    if (leaving.current) return;
    leaving.current = true;
    if (!sheet || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      closeRef.current?.();
      return;
    }
    sheet.style.animation = 'none';
    sheet.style.transition = `transform ${EXIT_MS}ms cubic-bezier(0.3, 0, 0.8, 0.15)`;
    sheet.style.transform = 'translateY(100%)';
    setScrim(0, `opacity ${EXIT_MS}ms linear`);
    setTimeout(() => closeRef.current?.(), EXIT_MS);
  }, []);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return undefined;
    let drag = null;

    const onStart = (e) => {
      if (e.touches.length !== 1 || leaving.current) { drag = null; return; }
      const t = e.touches[0];
      drag = {
        y: t.clientY,
        x: t.clientX,
        blocked: scrolledAway(e.target, sheet),
        active: false,
        samples: [{ y: t.clientY, t: e.timeStamp || Date.now() }],
      };
    };

    const onMove = (e) => {
      if (!drag || drag.blocked || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dy = t.clientY - drag.y;
      const dx = t.clientX - drag.x;
      const now = e.timeStamp || Date.now();
      drag.samples.push({ y: t.clientY, t: now });
      while (drag.samples.length > 2 && now - drag.samples[0].t > 90) drag.samples.shift();
      if (!drag.active) {
        if (Math.abs(dy) < SLOP && Math.abs(dx) < SLOP) return;
        if (dy <= 0 || Math.abs(dx) > dy) { drag = null; return; }
        drag.active = true;
        drag.y = t.clientY;
        drag.height = sheet.getBoundingClientRect().height || window.innerHeight / 2;
        sheet.style.animation = 'none';
        sheet.style.transition = 'none';
      }
      e.preventDefault();
      const offset = Math.max(0, t.clientY - drag.y);
      sheet.style.transform = `translateY(${offset}px)`;
      setScrim(Math.max(0, 1 - offset / drag.height), 'none');
      drag.offset = offset;
    };

    const onEnd = (e) => {
      if (!drag?.active) { drag = null; return; }
      const { samples, height, offset = 0 } = drag;
      drag = null;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const endedAt = e?.timeStamp || Date.now();
      const v = endedAt - last.t < 90 && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
      if (e?.type !== 'touchcancel' && (v > FLING || offset > height / 3)) {
        dismiss();
        return;
      }
      sheet.style.transition = 'transform 220ms cubic-bezier(0.2, 0, 0, 1)';
      sheet.style.transform = 'translateY(0)';
      setScrim(1, 'opacity 220ms linear');
    };

    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd, { passive: true });
    sheet.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
      sheet.removeEventListener('touchcancel', onEnd);
    };
  }, [dismiss]);

  return { sheetRef, dismiss };
}
