import { useCallback, useRef } from 'react';

const SWIPE_THRESHOLD = 80;
const SWIPE_VELOCITY = 0.3;

export function useSwipeGesture({ onSwipeRight, onSwipeLeft, disabled = false }) {
  const startRef = useRef(null);

  const onTouchStart = useCallback((e) => {
    if (disabled) return;
    const touch = e.touches[0];
    startRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
  }, [disabled]);

  const onTouchEnd = useCallback((e) => {
    if (disabled || !startRef.current) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - startRef.current.x;
    const dy = touch.clientY - startRef.current.y;
    const dt = Date.now() - startRef.current.time;

    startRef.current = null;

    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_THRESHOLD) {
      const velocity = Math.abs(dx) / dt;
      if (velocity > SWIPE_VELOCITY) {
        if (dx > 0 && onSwipeRight) onSwipeRight();
        else if (dx < 0 && onSwipeLeft) onSwipeLeft();
      }
    }
  }, [disabled, onSwipeRight, onSwipeLeft]);

  const onTouchCancel = useCallback(() => {
    startRef.current = null;
  }, []);

  return { onTouchStart, onTouchEnd, onTouchCancel };
}
