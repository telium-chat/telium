'use strict';

// Page zoom for a menu-less shell, handled in `before-input-event` since Chromium's accelerators are absent; `preventDefault` stops Blink zooming twice.

// Chromium's standard zoom table, verbatim so Blink's and our steps share stops.
const PAGE_ZOOM_FACTORS = Object.freeze([
  0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.8, 0.9, 1,
  1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
]);

// Values between stops move to the adjacent stop; clamped at both ends.
function stepPageZoomFactor(current, direction) {
  if (direction === 0) return 1;
  if (!Number.isFinite(current)) return 1;
  if (direction > 0) {
    for (const factor of PAGE_ZOOM_FACTORS) {
      if (factor > current * (1 + 1e-9)) return factor;
    }
    return PAGE_ZOOM_FACTORS[PAGE_ZOOM_FACTORS.length - 1];
  }
  for (let index = PAGE_ZOOM_FACTORS.length - 1; index >= 0; index -= 1) {
    if (PAGE_ZOOM_FACTORS[index] < current * (1 - 1e-9)) return PAGE_ZOOM_FACTORS[index];
  }
  return PAGE_ZOOM_FACTORS[0];
}

// `shift` is ignored, so Ctrl+Shift+= and Ctrl+= both zoom in.
function classifyPageZoomKeys(input) {
  const key = input.key || '';
  const code = input.code || '';
  if (key === '+' || key === '=' || code === 'NumpadAdd') return 'in';
  // `_` is Shift+-; some layouts reach `-` only with Shift, and no chord uses Ctrl+Shift+-.
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return 'out';
  if (key === '0' || code === 'Numpad0') return 'reset';
  return null;
}

// Injected accessors let tests drive the chords without a window.
function createPageZoomHandler({ getFactor, setFactor }) {
  return (event, input) => {
    if (!input || input.type !== 'keyDown') return false;
    if (input.alt || !(input.control || input.meta)) return false;
    const action = classifyPageZoomKeys(input);
    if (!action) return false;
    event.preventDefault();
    try {
      if (action === 'reset') setFactor(1);
      else setFactor(stepPageZoomFactor(getFactor(), action === 'in' ? 1 : -1));
    } catch {
    }
    return true;
  };
}

function installPageZoom(window) {
  window.webContents.on('before-input-event', createPageZoomHandler({
    getFactor: () => window.webContents.getZoomFactor(),
    setFactor: (factor) => window.webContents.setZoomFactor(factor),
  }));
}

module.exports = {
  PAGE_ZOOM_FACTORS,
  stepPageZoomFactor,
  classifyPageZoomKeys,
  createPageZoomHandler,
  installPageZoom,
};
