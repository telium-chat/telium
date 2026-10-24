import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useSwipeGesture } from '../hooks/useSwipeGesture.jsx';

function SwipeSurface({ onLeft, onRight }) {
  const handlers = useSwipeGesture({ onSwipeLeft: onLeft, onSwipeRight: onRight });
  return (
    <div
      data-testid="swipe-surface"
      onTouchStart={handlers.onTouchStart}
      onTouchEnd={handlers.onTouchEnd}
    />
  );
}

describe('mobile swipe gestures', () => {
  it('distinguishes reply-left from navigation-right', () => {
    const left = vi.fn();
    const right = vi.fn();
    render(<SwipeSurface onLeft={left} onRight={right} />);
    const surface = screen.getByTestId('swipe-surface');

    fireEvent.touchStart(surface, {
      touches: [{ clientX: 180, clientY: 80 }],
    });
    fireEvent.touchEnd(surface, {
      changedTouches: [{ clientX: 70, clientY: 82 }],
    });
    expect(left).toHaveBeenCalledOnce();
    expect(right).not.toHaveBeenCalled();

    fireEvent.touchStart(surface, {
      touches: [{ clientX: 40, clientY: 80 }],
    });
    fireEvent.touchEnd(surface, {
      changedTouches: [{ clientX: 155, clientY: 82 }],
    });
    expect(right).toHaveBeenCalledOnce();
    expect(left).toHaveBeenCalledOnce();
  });

  it('does not treat mostly vertical movement as navigation', () => {
    const left = vi.fn();
    const right = vi.fn();
    render(<SwipeSurface onLeft={left} onRight={right} />);
    const surface = screen.getByTestId('swipe-surface');

    fireEvent.touchStart(surface, {
      touches: [{ clientX: 100, clientY: 40 }],
    });
    fireEvent.touchEnd(surface, {
      changedTouches: [{ clientX: 190, clientY: 180 }],
    });

    expect(left).not.toHaveBeenCalled();
    expect(right).not.toHaveBeenCalled();
  });

  it('cancels a recorded gesture without allowing a later touch end to reuse it', () => {
    const left = vi.fn();
    const right = vi.fn();
    function Cancelable() {
      const handlers = useSwipeGesture({ onSwipeLeft: left, onSwipeRight: right });
      return <div
        data-testid="cancelable"
        onTouchStart={handlers.onTouchStart}
        onTouchEnd={handlers.onTouchEnd}
        onTouchCancel={handlers.onTouchCancel}
      />;
    }
    render(<Cancelable />);
    const surface = screen.getByTestId('cancelable');
    fireEvent.touchStart(surface, { touches: [{ clientX: 180, clientY: 80 }] });
    fireEvent.touchCancel(surface);
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 60, clientY: 80 }] });
    expect(left).not.toHaveBeenCalled();
    expect(right).not.toHaveBeenCalled();
  });
});
