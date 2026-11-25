import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useMobileViewport } from '../hooks/useMobileViewport.js';

function installVisualViewport({ height = 800, offsetTop = 0 } = {}) {
  const target = new EventTarget();
  const state = { height, offsetTop };

  Object.defineProperties(target, {
    height: { configurable: true, get: () => state.height },
    offsetTop: { configurable: true, get: () => state.offsetTop },
  });

  target.set = (next) => {
    if (next.height !== undefined) state.height = next.height;
    if (next.offsetTop !== undefined) state.offsetTop = next.offsetTop;
  };

  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: target,
  });
  return target;
}

describe('useMobileViewport', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 800,
    });
    delete document.documentElement.dataset.androidKeyboard;
  });

  afterEach(() => {
    delete document.documentElement.dataset.androidKeyboard;
  });

  it('follows a keyboard that overlays the page through visualViewport', () => {
    const viewport = installVisualViewport({ height: 500 });
    renderHook(() => useMobileViewport());

    expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('500px');
    expect(document.documentElement.style.getPropertyValue('--mobile-keyboard-height')).toBe('300px');
    expect(document.documentElement.dataset.mobileKeyboard).toBe('open');

    act(() => {
      viewport.set({ height: 800 });
      viewport.dispatchEvent(new Event('resize'));
    });

    expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('800px');
    expect(document.documentElement.dataset.mobileKeyboard).toBe('closed');
  });

  it('takes the open state from Android when the native shell has already shrunk the page', () => {
    installVisualViewport({ height: 500 });
    window.innerHeight = 500;
    renderHook(() => useMobileViewport());
    expect(document.documentElement.dataset.mobileKeyboard).toBe('closed');

    act(() => {
      document.documentElement.dataset.androidKeyboard = 'open';
      window.dispatchEvent(new CustomEvent('telium:android-insets'));
    });

    expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('500px');
    expect(document.documentElement.style.getPropertyValue('--mobile-keyboard-height')).toBe('0px');
    expect(document.documentElement.dataset.mobileKeyboard).toBe('open');
  });
});
