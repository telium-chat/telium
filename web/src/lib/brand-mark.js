// A packaged Electron renderer loads its JS from renderer/assets/, even after a
// history navigation changes the document URL. Resolve the bundled mark against
// that JS URL, never against window.location (or an absolute file:///brand path).
//
// Keep the relative path dynamic: Vite must not treat the public/ asset as an
// import from this source module. The file is copied unchanged into dist/brand/.
import { runtime } from './build.js';

const DESKTOP_MARK_PATH = ['..', 'brand', 'telium-mark-gradient.svg'].join('/');

export function markUrlFor(shell, moduleUrl) {
  return shell === 'desktop'
    ? new URL(DESKTOP_MARK_PATH, moduleUrl).href
    : '/brand/telium-mark-gradient.svg';
}

export const brandMarkUrl = markUrlFor(runtime, import.meta.url);
