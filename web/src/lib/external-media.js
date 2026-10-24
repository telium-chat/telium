// The web client can't use Gofile's cookie-gated path, so the homeserver mints a signed playback URL.

import {
  isAndroid,
  isElectronRuntime,
  isIOS,
  isNativeShellRuntime,
  isTauriRuntime,
} from './platform.js';

let viewerGuestToken = null;
let viewerGuestTokenHome = null;
let viewerGuestTokenPromise = null;
let androidRequestSerial = 0;

export function isGofileDownloadUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:'
      && (url.hostname === 'gofile.io' || url.hostname.endsWith('.gofile.io'))
      && url.pathname.startsWith('/download/');
  } catch {
    return false;
  }
}

export async function gofilePlaybackUrl(home, source) {
  if (!isGofileDownloadUrl(source)) {
    throw new Error('Gofile playback needs an HTTPS gofile.io download URL.');
  }
  if (!home?.post) {
    throw new Error('Gofile playback needs an authenticated home server.');
  }

  if (!isNativeShellRuntime()) {
    const payload = await home.post('/_telium/v1/media/external/gofile/playback', {
      url: source,
    });
    if (!payload?.url) {
      throw new Error('The homeserver returned no Gofile playback URL.');
    }
    return payload.url;
  }

  if (isIOS) {
    throw new Error('Direct Gofile playback is not implemented for the iOS shell yet.');
  }

  const token = await getViewerGuestToken(home);
  if (isAndroid) {
    await prepareAndroidGofile(source, token);
  } else if (isElectronRuntime()) {
    await window.teliumDesktop.prepareGofilePlayback(source, token);
  } else if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('prepare_gofile_playback', { source, token });
  }
  return source;
}

async function getViewerGuestToken(home) {
  const homeKey = String(home.base || '');
  if (viewerGuestToken && viewerGuestTokenHome === homeKey) return viewerGuestToken;
  if (viewerGuestTokenPromise && viewerGuestTokenHome === homeKey) return viewerGuestTokenPromise;

  viewerGuestToken = null;
  viewerGuestTokenHome = homeKey;
  viewerGuestTokenPromise = home
    .post('/_telium/v1/media/external/gofile/session', {})
    .then((payload) => validateGuestToken(payload?.token))
    .then((token) => {
      viewerGuestToken = token;
      return token;
    })
    .finally(() => { viewerGuestTokenPromise = null; });

  return viewerGuestTokenPromise;
}

function validateGuestToken(token) {
  if (typeof token !== 'string'
    || token.length < 16
    || token.length > 2048
    || !/^[A-Za-z0-9._-]+$/.test(token)
  ) {
    throw new Error('Gofile returned an invalid guest session.');
  }
  return token;
}

function prepareAndroidGofile(source, token) {
  const bridge = typeof window !== 'undefined' ? window.teliumAndroidGofileBridge : null;
  if (!bridge?.postMessage || !bridge?.addEventListener) {
    return Promise.reject(new Error('Android Gofile playback bridge is unavailable.'));
  }

  const requestId = `gofile-${++androidRequestSerial}`;
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
        finish(reject, new Error(message.message || 'Android could not prepare Gofile playback.'));
        return;
      }
      finish(resolve);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Android did not prepare Gofile playback in time.')),
      5000,
    );
    bridge.addEventListener('message', onMessage);
    try {
      bridge.postMessage(JSON.stringify({
        op: 'session',
        request_id: requestId,
        source,
        token,
      }));
    } catch (error) {
      finish(reject, error);
    }
  });
}
