// Android's native side of two things the WebView cannot do for itself.
//
// 1. Read a public document from another origin. The app runs at
//    `http://tauri.localhost`, so a cross-origin `fetch` needs the other site to
//    send `Access-Control-Allow-Origin`, and a website's `/telium.txt`, the
//    signed recommendation feed and a GitHub release asset do not. The desktop
//    shell is not bound by this; Android's WebView is. `androidFetch` asks the
//    native side for a bounded, HTTPS-only, GET-only copy instead.
// 2. Replace the installed APK (`androidUpdater`).
//
// Both are `addWebMessageListener` bridges that Android injects only into
// Telium's own origin (see `MainActivity.kt`), the same shape as the file-save
// and Gofile bridges.

import { isMobileTauri } from './platform.js';

let serial = 0;

const bridge = (name) => (typeof window !== 'undefined' ? window[name] || null : null);

const usable = (b) => Boolean(b?.postMessage && b?.addEventListener);

/// Bodies with these statuses must not carry one (`new Response` throws).
const NULL_BODY = new Set([101, 204, 205, 304]);

const unb64 = (text) => {
  const binary = atob(text || '');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

export const androidFetchAvailable = () => isMobileTauri && usable(bridge('teliumAndroidFetchBridge'));

/// Resolves with the first reply carrying this request's id; `onMessage`
/// returns true to finish and may call `emit` for progress.
function exchange(b, payload, { timeoutMs, onMessage }) {
  const requestId = `${payload.op}-${++serial}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      b.removeEventListener?.('message', listener);
      fn(value);
    };
    const listener = (event) => {
      let message;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (message.request_id !== requestId) return;
      onMessage(message, (v) => finish(resolve, v), (e) => finish(reject, e));
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Android did not answer in time.')),
      timeoutMs,
    );
    b.addEventListener('message', listener);
    try {
      b.postMessage(JSON.stringify({ ...payload, request_id: requestId }));
    } catch (error) {
      finish(reject, error);
    }
  });
}

/// A `fetch` stand-in for public, unauthenticated GETs. Throws `TypeError`
/// like a blocked `fetch` does, so callers that already treat that as
/// "unreachable" need no new branch.
export async function androidFetch(url, init = {}) {
  const b = bridge('teliumAndroidFetchBridge');
  if (!usable(b)) throw new TypeError('Android network bridge is unavailable.');
  const method = String(init.method || 'GET').toUpperCase();
  if (method !== 'GET') throw new TypeError('Android network bridge only reads.');
  const redirect = init.redirect === 'follow' || init.redirect === undefined ? 'follow' : init.redirect;
  const headers = new Headers(init.headers || {});

  const timeoutMs = 20_000;
  const reply = await exchange(b, {
    op: 'get',
    url: String(url),
    accept: headers.get('accept') || '',
    redirect: redirect === 'follow' ? 'follow' : 'manual',
    max_bytes: 1024 * 1024,
  }, {
    timeoutMs,
    onMessage: (message, ok, fail) => {
      if (message.ok) ok(message);
      else fail(new TypeError(message.message || 'Android could not fetch that address.'));
    },
  });

  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (redirect === 'error' && reply.status >= 300 && reply.status < 400) {
    throw new TypeError('Redirect was refused.');
  }
  const body = NULL_BODY.has(reply.status) ? null : unb64(reply.body_b64);
  const response = new Response(body, {
    status: reply.status,
    headers: reply.content_type ? { 'content-type': reply.content_type } : {},
  });
  // `url` is read-only on Response; the discovery code compares the final URL.
  Object.defineProperty(response, 'url', { value: reply.url || String(url) });
  return response;
}

/// The self-update half. `null` anywhere but the Android shell.
export function androidUpdater() {
  const b = isMobileTauri ? bridge('teliumAndroidUpdateBridge') : null;
  if (!usable(b)) return null;
  return {
    /// `{ canInstall }`: whether Android already lets Telium install packages.
    status: () => exchange(b, { op: 'status' }, {
      timeoutMs: 5000,
      onMessage: (m, ok, fail) => (m.ok ? ok(m) : fail(new Error(m.message || 'unavailable'))),
    }),
    /// Downloads, verifies and hands the APK to Android's installer.
    /// Resolves `{ result: 'installer' | 'needs-permission' }`; rejects with a sentence.
    install: ({ url, sha256, size }, onProgress = () => {}) => exchange(b, {
      op: 'install', url, sha256, size,
    }, {
      timeoutMs: 15 * 60 * 1000,
      onMessage: (m, ok, fail) => {
        if (m.stage === 'progress') { onProgress(m); return; }
        if (m.stage === 'verifying') { onProgress(m); return; }
        if (!m.ok) { fail(new Error(m.message || 'The update could not be installed.')); return; }
        ok(m);
      },
    }),
  };
}
