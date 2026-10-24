import { useEffect } from 'react';

export function useMobileViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;

    const sync = () => {
      const visualHeight = Math.max(1, Math.round(viewport?.height || window.innerHeight));
      const top = Math.max(0, Math.round(viewport?.offsetTop || 0));
      const visualCovered = Math.max(0, Math.round(window.innerHeight - visualHeight - top));
      const nativeIme = Math.max(
        0,
        Number.parseFloat(
          getComputedStyle(root).getPropertyValue('--android-ime-bottom'),
        ) || 0,
      );
      const covered = Math.max(visualCovered, Math.round(nativeIme));
      const height = Math.max(1, Math.round(window.innerHeight - top - covered));

      root.style.setProperty('--mobile-viewport-height', `${height}px`);
      root.style.setProperty('--mobile-viewport-top', `${top}px`);
      root.style.setProperty('--mobile-keyboard-height', `${covered}px`);
      root.dataset.mobileKeyboard = covered > 80 ? 'open' : 'closed';
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
