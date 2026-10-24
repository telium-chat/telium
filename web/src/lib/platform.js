export const isTauri = typeof window !== 'undefined' && (
  Boolean(window.__TAURI__)
  || Boolean(window.__TAURI_INTERNALS__)
  || window.location.protocol === 'tauri:'
  || window.location.protocol === 'asset:'
  || window.location.hostname === 'tauri.localhost'
  || window.location.hostname.endsWith('.tauri.localhost')
);

export const isElectron = typeof window !== 'undefined'
  && window.teliumDesktop?.runtime === 'electron';
export const isNativeShell = isTauri || isElectron;

export const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
export const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
export const isMobileDevice = typeof navigator !== 'undefined' && (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || ''));
export const isMobileTauri = isTauri && isAndroid;

export function checkIsMobile() {
  if (isMobileTauri || isMobileDevice) return true;
  if (typeof window !== 'undefined') {
    if (new URLSearchParams(window.location.search).has('mobile')) return true;
    if (window.innerWidth <= 768) return true;
  }
  return false;
}

export function isElectronRuntime() {
  return typeof window !== 'undefined' && window.teliumDesktop?.runtime === 'electron';
}

function isActualTauriRuntime() {
  return typeof window !== 'undefined' && (
    Boolean(window.__TAURI__)
    || Boolean(window.__TAURI_INTERNALS__)
    || window.location.protocol === 'tauri:'
    || window.location.protocol === 'asset:'
    || window.location.hostname === 'tauri.localhost'
    || window.location.hostname.endsWith('.tauri.localhost')
  );
}

// Legacy meaning "in the native shell"; Electron takes the same paths, Android stays Tauri.
export function isTauriRuntime() {
  return isElectronRuntime() || isActualTauriRuntime();
}

export function isNativeShellRuntime() {
  return isTauriRuntime();
}

let androidCallRequestSerial = 0;

function androidCallBridge() {
  if (!isAndroid || !isActualTauriRuntime() || typeof window === 'undefined') return null;
  return window.teliumAndroidCallBridge || null;
}

function requestAndroidCallHost(payload, timeoutMs = 3000) {
  const bridge = androidCallBridge();
  if (!bridge?.postMessage || !bridge?.addEventListener) {
    return Promise.reject(new Error('Android call controls are unavailable on this device.'));
  }

  const requestId = `call-${++androidCallRequestSerial}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bridge.removeEventListener?.('message', onMessage);
      fn(value);
    };
    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (message.request_id !== requestId) return;
      if (!message.ok) {
        finish(reject, new Error(message.message || 'Android could not change the call audio output.'));
        return;
      }
      finish(resolve, message);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Android did not respond to the call-audio request.')),
      timeoutMs,
    );
    bridge.addEventListener('message', onMessage);
    try {
      bridge.postMessage(JSON.stringify({ ...payload, request_id: requestId }));
    } catch (error) {
      finish(reject, error);
    }
  });
}

export async function getAndroidAudioRoutes() {
  if (!isAndroid || !isActualTauriRuntime()) {
    return { supported: false, selected: 'auto', automatic_label: 'Automatic', routes: [] };
  }
  const message = await requestAndroidCallHost({ op: 'routes' });
  return {
    supported: Boolean(message.supported),
    selected: String(message.selected || 'auto'),
    automatic_label: String(message.automatic_label || 'Automatic'),
    routes: Array.isArray(message.routes) ? message.routes : [],
  };
}

export async function setAndroidAudioRoute(routeId) {
  const message = await requestAndroidCallHost({
    op: 'select_route',
    route_id: String(routeId || 'auto'),
  });
  return String(message.selected || 'auto');
}

let androidShareRequestSerial = 0;

export async function takeAndroidSharedText() {
  if (!isAndroid || !isActualTauriRuntime() || typeof window === 'undefined') return null;
  const bridge = window.teliumAndroidShareBridge;
  if (!bridge?.postMessage || !bridge?.addEventListener) return null;

  const requestId = `share-${++androidShareRequestSerial}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bridge.removeEventListener?.('message', onMessage);
      fn(value);
    };
    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (message.request_id !== requestId) return;
      if (!message.ok) {
        finish(reject, new Error(message.message || 'Android could not read the shared text.'));
        return;
      }
      finish(resolve, message.has_share ? String(message.text ?? '') : null);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Android did not respond to the share request.')),
      3000,
    );
    bridge.addEventListener('message', onMessage);
    try {
      bridge.postMessage(JSON.stringify({ op: 'take', request_id: requestId }));
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function setAndroidCallActive(active, { muted = false, deafened = false } = {}) {
  if (!isAndroid || !isActualTauriRuntime() || typeof window === 'undefined') return false;
  const bridge = androidCallBridge();
  if (!bridge?.postMessage) return false;
  try {
    bridge.postMessage(JSON.stringify({
      op: 'state',
      active: Boolean(active),
      muted: Boolean(muted),
      deafened: Boolean(deafened),
    }));
    return true;
  } catch {
    return false;
  }
}

export function subscribeAndroidCallControls(listener) {
  if (!isAndroid || !isActualTauriRuntime() || typeof window === 'undefined') return () => {};
  const onControl = (event) => {
    const action = String(event?.detail || '');
    if (action) listener(action);
  };
  window.addEventListener('telium:android-call-control', onControl);
  return () => window.removeEventListener('telium:android-call-control', onControl);
}

export async function openExternal(url) {
  const parsed = new URL(url, typeof document === 'undefined' ? undefined : document.baseURI);
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error('Only HTTP(S) links can be opened externally.');

  if (isElectronRuntime()) {
    await window.teliumDesktop.openExternal(parsed.href);
    return;
  }
  if (!isActualTauriRuntime()) {
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
    return;
  }
  // Linux's xdg-open can report success before its handler fails; the Tauri command uses Gio first.
  if (!isAndroid) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_external_url', { url: parsed.href });
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(parsed.href);
}
