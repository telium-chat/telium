import { useEffect } from 'react';

const LAST_KEYBOARD_KEY = 'telium.mobile.keyboardHeight';

function readLastKeyboard() {
  try { return Number(localStorage.getItem(LAST_KEYBOARD_KEY)) || 0; } catch { return 0; }
}

export function useMobileViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    // The height with no keyboard up, so the keyboard's own height can be told even
    // when the native shell shrinks the page rather than overlaying it. Remembered
    // for the emoji panel, which takes the keyboard's place at the same height.
    let fullHeight = 0;
    let fullWidth = window.innerWidth;
    let lastKeyboard = readLastKeyboard();
    if (lastKeyboard) root.style.setProperty('--mobile-keyboard-last', `${lastKeyboard}px`);

    // On Android the native shell shrinks the WebView above the keyboard (MainActivity
    // liftAboveKeyboard), so window and visual viewport already agree there; the
    // visualViewport difference covers browsers whose keyboard overlays the page.
    const sync = () => {
      const visualHeight = Math.max(1, Math.round(viewport?.height || window.innerHeight));
      const top = Math.max(0, Math.round(viewport?.offsetTop || 0));
      const covered = Math.max(0, Math.round(window.innerHeight - visualHeight - top));
      const height = Math.max(1, Math.round(window.innerHeight - top - covered));
      const open = covered > 80 || root.dataset.androidKeyboard === 'open';

      root.style.setProperty('--mobile-viewport-height', `${height}px`);
      root.style.setProperty('--mobile-viewport-top', `${top}px`);
      root.style.setProperty('--mobile-keyboard-height', `${covered}px`);
      root.dataset.mobileKeyboard = open ? 'open' : 'closed';

      // The resize and Android's "keyboard open" signal arrive in either order, so a
      // sync can see the shrunk page before it knows the keyboard is up: only ever
      // raise the baseline, and start again when the width changes (rotation).
      if (window.innerWidth !== fullWidth) {
        fullWidth = window.innerWidth;
        fullHeight = 0;
      }
      if (!open) {
        fullHeight = Math.max(fullHeight, window.innerHeight);
      } else {
        const keyboard = Math.max(covered, fullHeight ? fullHeight - window.innerHeight : 0);
        if (keyboard > 120 && Math.abs(keyboard - lastKeyboard) > 4) {
          lastKeyboard = Math.round(keyboard);
          root.style.setProperty('--mobile-keyboard-last', `${lastKeyboard}px`);
          try { localStorage.setItem(LAST_KEYBOARD_KEY, String(lastKeyboard)); } catch {}
        }
      }
    };

    sync();
    viewport?.addEventListener('resize', sync);
    viewport?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    window.addEventListener('telium:android-insets', sync);

    return () => {
      viewport?.removeEventListener('resize', sync);
      viewport?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
      window.removeEventListener('telium:android-insets', sync);
      root.style.removeProperty('--mobile-viewport-height');
      root.style.removeProperty('--mobile-viewport-top');
      root.style.removeProperty('--mobile-keyboard-height');
      delete root.dataset.mobileKeyboard;
    };
  }, []);
}
