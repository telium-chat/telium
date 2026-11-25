import { createContext, useContext, useEffect, useRef } from 'react';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { isAndroid, isTauriRuntime } from '../lib/platform.js';

// Topmost layer last. Entries are sorted by level, then by when they became active:
//   0          the shell's own navigation (`base`), which toggles as drawers open;
//   2n         modal n of the stack (ModalHost registers one entry per modal);
//   2n + 1     anything shown in modal n (a settings page, a sheet, a viewer), or in
//              the app itself for n = 0.
// So a page inside a modal answers Back before its modal, and a confirm opened over
// that page answers before both, whatever order React runs their effects in.
export const BackDepthContext = createContext(0);
export const backLevel = {
  shell: 0,
  modal: (depth) => 2 * depth,
  content: (depth) => 2 * depth + 1,
};

const dismissStack = [];
let subscribers = 0;
let nativeListener = null;
let nativePending = null;

export function dismissTopMobileOverlay() {
  const top = dismissStack[dismissStack.length - 1];
  if (!top) return false;
  top.dismiss();
  return true;
}

const dispatchBack = () => {
  dismissTopMobileOverlay();
};

function ensureDispatchers() {
  subscribers += 1;
  if (subscribers === 1) {
    window.addEventListener('tauri://back', dispatchBack);
    window.addEventListener('androidback', dispatchBack);
  }

  if (!isAndroid || !isTauriRuntime() || nativeListener || nativePending) return;
  nativePending = onBackButtonPress(dispatchBack)
    .then((registered) => {
      nativePending = null;
      if (subscribers > 0) nativeListener = registered;
      else registered.unregister().catch(() => {});
    })
    .catch(() => {
      nativePending = null;
    });
}

function releaseDispatchers() {
  subscribers = Math.max(0, subscribers - 1);
  if (subscribers > 0) return;

  window.removeEventListener('tauri://back', dispatchBack);
  window.removeEventListener('androidback', dispatchBack);

  const listener = nativeListener;
  nativeListener = null;
  if (listener) listener.unregister().catch(() => {});
}

export function useMobileBackDismiss(dismiss, { active = true, base = false, level } = {}) {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const depth = useContext(BackDepthContext);
  const at = level ?? (base ? backLevel.shell : backLevel.content(depth));

  useEffect(() => {
    if (!active) return undefined;

    const entry = {
      level: at,
      dismiss: () => dismissRef.current?.(),
    };
    let index = dismissStack.length;
    while (index > 0 && dismissStack[index - 1].level > at) index -= 1;
    dismissStack.splice(index, 0, entry);
    ensureDispatchers();

    return () => {
      const found = dismissStack.indexOf(entry);
      if (found >= 0) dismissStack.splice(found, 1);
      releaseDispatchers();
    };
  }, [active, at]);
}
