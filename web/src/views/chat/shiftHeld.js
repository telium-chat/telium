const CLASS = 'shift-held';
let installed = false;

function set(on) {
  const root = document.documentElement;
  if (root.classList.contains(CLASS) !== on) root.classList.toggle(CLASS, on);
}

const fromEvent = (e) => set(Boolean(e.shiftKey));
const clear = () => set(false);

export function watchShift() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', fromEvent, true);
  window.addEventListener('keyup', fromEvent, true);
  window.addEventListener('pointermove', fromEvent, { capture: true, passive: true });
  window.addEventListener('blur', clear);
}

export function shiftHeld() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains(CLASS);
}
