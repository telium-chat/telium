import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSwipeBack } from '../hooks/useSwipeBack.js';

function Page({ onBack, canLeave = () => true }) {
  const root = useRef(null);
  const pane = useRef(null);
  useSwipeBack(root, pane, { enabled: true, onBack, canLeave });
  return (
    <div ref={root} data-testid="root">
      <div ref={pane} data-testid="pane"><p data-testid="text">Voice</p><input data-testid="field" /></div>
    </div>
  );
}

const touch = (el, type, x, t, y = 100) => {
  const key = type === 'touchEnd' ? 'changedTouches' : 'touches';
  const event = createEvent[type](el, { [key]: [{ clientX: x, clientY: y }], ...(key === 'changedTouches' ? { touches: [] } : {}) });
  Object.defineProperty(event, 'timeStamp', { value: t });
  fireEvent(el, event);
};

describe('useSwipeBack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => setTimeout(cb, 0));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('follows the finger and goes back past 40%', () => {
    const back = vi.fn();
    render(<Page onBack={back} />);
    const pane = screen.getByTestId('pane');
    pane.getBoundingClientRect = () => ({ width: 400 });
    touch(screen.getByTestId('text'), 'touchStart', 20, 1);
    touch(screen.getByTestId('text'), 'touchMove', 40, 20);
    expect(screen.getByTestId('root').hasAttribute('data-swiping')).toBe(true);
    touch(screen.getByTestId('text'), 'touchMove', 240, 300);
    expect(pane.style.translate).toBe('200px 0');
    touch(screen.getByTestId('text'), 'touchEnd', 240, 600);
    vi.runAllTimers();
    expect(back).toHaveBeenCalledOnce();
  });

  it('slides home on a short drag, and ignores drags that start on a field', () => {
    const back = vi.fn();
    render(<Page onBack={back} />);
    screen.getByTestId('pane').getBoundingClientRect = () => ({ width: 400 });
    touch(screen.getByTestId('text'), 'touchStart', 20, 1);
    touch(screen.getByTestId('text'), 'touchMove', 40, 100);
    touch(screen.getByTestId('text'), 'touchMove', 80, 400);
    touch(screen.getByTestId('text'), 'touchEnd', 80, 600);
    touch(screen.getByTestId('field'), 'touchStart', 20, 700);
    touch(screen.getByTestId('field'), 'touchMove', 300, 720);
    touch(screen.getByTestId('field'), 'touchEnd', 300, 730);
    vi.runAllTimers();
    expect(back).not.toHaveBeenCalled();
  });

  it('asks instead of leaving when there are unsaved edits', () => {
    const back = vi.fn();
    render(<Page onBack={back} canLeave={() => false} />);
    const pane = screen.getByTestId('pane');
    pane.getBoundingClientRect = () => ({ width: 400 });
    touch(screen.getByTestId('text'), 'touchStart', 20, 1);
    touch(screen.getByTestId('text'), 'touchMove', 40, 20);
    touch(screen.getByTestId('text'), 'touchMove', 300, 300);
    touch(screen.getByTestId('text'), 'touchEnd', 300, 320);
    expect(back).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(pane.style.translate).toBe('');
  });
});
