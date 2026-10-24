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
    document.documentElement.style.removeProperty('--android-ime-bottom');
  });

  afterEach(() => {
    document.documentElement.style.removeProperty('--android-ime-bottom');
  });

  it('uses the native Android IME inset when visualViewport does not resize', () => {
    installVisualViewport({ height: 800 });
    renderHook(() => useMobileViewport());

    expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('800px');

    act(() => {
      document.documentElement.style.setProperty('--android-ime-bottom', '300px');
      window.dispatchEvent(new CustomEvent('telium:android-insets'));
    });

    expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('500px');
    expect(document.documentElement.style.getPropertyValue('--mobile-keyboard-height')).toBe('300px');
    expect(document.documentElement.dataset.mobileKeyboard).toBe('open');
  });

  it('does not double-count the keyboard when visualViewport already reports it', () => {
    const viewport = installVisualViewport({ height: 500 });
    document.documentElement.style.setProperty('--android-ime-bottom', '300px');
    renderHook(() => useMobileViewport());

    expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('500px');
    expect(document.documentElement.style.getPropertyValue('--mobile-keyboard-height')).toBe('300px');

    act(() => {
      viewport.set({ height: 800 });
      document.documentElement.style.setProperty('--android-ime-bottom', '0px');
      window.dispatchEvent(new CustomEvent('telium:android-insets'));
    });

    expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('800px');
    expect(document.documentElement.dataset.mobileKeyboard).toBe('closed');
  });
});
