import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export function useAnchoredBox(anchor, measure) {
  const [box, setBox] = useState(null);
  const latest = useRef(measure);
  latest.current = measure;

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor?.getBoundingClientRect?.();
      if (!rect) return;
      setBox(latest.current(rect));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  return box;
}

export function useDismiss(onDismiss, {
  within = null,
  anchor = null,
  pointer = true,
  escape = true,
  capture = true,
  stopEscape = capture,
} = {}) {
  const inside = useRef(within);
  inside.current = within;

  useEffect(() => {
    if (!pointer && !escape) return undefined;

    const isInside = (target) => {
      const refs = Array.isArray(inside.current) ? inside.current : [inside.current];
      if (refs.some((ref) => ref?.current?.contains?.(target))) return true;
      return Boolean(anchor?.contains?.(target));
    };

    const onDown = (e) => {
      if (isInside(e.target)) return;
      onDismiss();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (stopEscape) e.stopPropagation();
      onDismiss();
    };

    if (pointer) document.addEventListener('pointerdown', onDown, capture);
    if (escape) document.addEventListener('keydown', onKey, capture);
    return () => {
      if (pointer) document.removeEventListener('pointerdown', onDown, capture);
      if (escape) document.removeEventListener('keydown', onKey, capture);
    };
  }, [anchor, onDismiss, pointer, escape, capture, stopEscape]);
}
