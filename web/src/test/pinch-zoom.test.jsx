import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { clampOffset, usePinchZoom, zoomAbout } from '../hooks/usePinchZoom.js';

function Viewer({ onSwipeDismiss }) {
  const ref = useRef(null);
  const zoom = usePinchZoom(ref, { onSwipeDismiss });
  return <div ref={ref} data-testid="layer" data-pull={zoom.pullProgress} style={zoom.style} />;
}

const touch = (el, type, y, t, x = 100) => {
  const key = type === 'touchEnd' ? 'changedTouches' : 'touches';
  const event = createEvent[type](el, { [key]: [{ clientX: x, clientY: y }], ...(key === 'changedTouches' ? { touches: [] } : {}) });
  Object.defineProperty(event, 'timeStamp', { value: t });
  act(() => { fireEvent(el, event); });
};

describe('usePinchZoom', () => {
  it('keeps the point under the fingers while zooming', () => {
    const next = zoomAbout({ x: 0, y: 0, scale: 1 }, { x: 100, y: 50 }, 2);
    expect(next).toEqual({ x: -100, y: -50, scale: 2 });
    expect(clampOffset({ x: 50, y: -900, scale: 2 }, 400, 400)).toEqual({ x: 0, y: -400, scale: 2 });
  });

  it('closes on a long enough downward drag and follows the finger on the way', () => {
    const dismiss = vi.fn();
    render(<Viewer onSwipeDismiss={dismiss} />);
    const layer = screen.getByTestId('layer');
    touch(layer, 'touchStart', 100, 1);
    touch(layer, 'touchMove', 115, 50);
    touch(layer, 'touchMove', 260, 400);
    expect(layer.style.transform).toContain('translate3d(0, 145px, 0)');
    touch(layer, 'touchEnd', 260, 450);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('slides back after a short slow drag, and leaves sideways drags alone', () => {
    const dismiss = vi.fn();
    render(<Viewer onSwipeDismiss={dismiss} />);
    const layer = screen.getByTestId('layer');
    touch(layer, 'touchStart', 100, 1);
    touch(layer, 'touchMove', 115, 100);
    touch(layer, 'touchMove', 160, 500);
    touch(layer, 'touchEnd', 160, 700);
    touch(layer, 'touchStart', 100, 800, 100);
    touch(layer, 'touchMove', 105, 820, 300);
    touch(layer, 'touchEnd', 105, 830, 300);
    expect(dismiss).not.toHaveBeenCalled();
  });
});
