import { afterEach, describe, expect, it, vi } from 'vitest';

// `isMobileTauri` is computed when platform.js loads, so make the page look like
// Tauri on Android first and load the modules fresh.
const load = async () => {
  vi.resetModules();
  window.__TAURI_INTERNALS__ = {};
  Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 14)', configurable: true });
  return import('../lib/android-native.js');
};

const fakeBridge = (respond) => {
  const listeners = new Set();
  return {
    postMessage: (raw) => {
      const request = JSON.parse(raw);
      for (const reply of respond(request)) {
        queueMicrotask(() => listeners.forEach((l) => l({ data: JSON.stringify({ request_id: request.request_id, ...reply }) })));
      }
    },
    addEventListener: (_, l) => listeners.add(l),
    removeEventListener: (_, l) => listeners.delete(l),
  };
};

afterEach(() => { delete window.teliumAndroidFetchBridge; delete window.teliumAndroidUpdateBridge; });

describe('android native fetch', () => {
  it('turns the native reply into a Response and asks for a bounded GET', async () => {
    let seen;
    window.teliumAndroidFetchBridge = fakeBridge((req) => {
      seen = req;
      return [{ ok: true, status: 200, url: req.url, content_type: 'text/plain', body_b64: btoa('homeserver.example\n') }];
    });
    const { androidFetch } = await load();
    const response = await androidFetch('https://example.org/telium.txt', { redirect: 'error', headers: { Accept: 'text/plain' } });
    expect(await response.text()).toBe('homeserver.example\n');
    expect(response.url).toBe('https://example.org/telium.txt');
    expect(seen).toMatchObject({ op: 'get', accept: 'text/plain', redirect: 'manual' });
    expect(seen.max_bytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('refuses a redirect when the caller said redirects are an error', async () => {
    window.teliumAndroidFetchBridge = fakeBridge(() => [{ ok: true, status: 302, url: 'x', body_b64: '' }]);
    const { androidFetch } = await load();
    await expect(androidFetch('https://example.org/telium.txt', { redirect: 'error' })).rejects.toBeInstanceOf(TypeError);
  });

  it('surfaces a native refusal as a TypeError, like a blocked fetch', async () => {
    window.teliumAndroidFetchBridge = fakeBridge(() => [{ ok: false, message: 'Only HTTPS addresses can be read.' }]);
    const { androidFetch } = await load();
    await expect(androidFetch('http://example.org/')).rejects.toThrow(/HTTPS/);
  });

  it('never sends anything but a GET', async () => {
    window.teliumAndroidFetchBridge = fakeBridge(() => []);
    const { androidFetch } = await load();
    await expect(androidFetch('https://example.org/', { method: 'POST' })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('android updater', () => {
  it('reports progress and resolves with the installer hand-off', async () => {
    window.teliumAndroidUpdateBridge = fakeBridge(() => [
      { ok: true, stage: 'progress', received: 5, total: 10 },
      { ok: true, stage: 'verifying' },
      { ok: true, stage: 'done', result: 'installer' },
    ]);
    const { androidUpdater } = await load();
    const stages = [];
    const result = await androidUpdater().install({ url: 'https://x/a.apk', sha256: 'a'.repeat(64), size: 10 }, (m) => stages.push(m.stage));
    expect(result.result).toBe('installer');
    expect(stages).toEqual(['progress', 'verifying']);
  });

  it('is absent without the bridge', async () => {
    const { androidUpdater } = await load();
    expect(androidUpdater()).toBeNull();
  });
});
