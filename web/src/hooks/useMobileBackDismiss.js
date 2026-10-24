import { useEffect, useRef } from 'react';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { isAndroid, isTauriRuntime } from '../lib/platform.js';

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

export function useMobileBackDismiss(dismiss, { active = true } = {}) {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    if (!active) return undefined;

    const entry = {
      dismiss: () => dismissRef.current?.(),
    };
    dismissStack.push(entry);
    ensureDispatchers();

    return () => {
      const index = dismissStack.indexOf(entry);
      if (index >= 0) dismissStack.splice(index, 1);
      releaseDispatchers();
    };
  }, [active]);
}
