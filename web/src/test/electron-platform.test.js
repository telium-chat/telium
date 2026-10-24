import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  delete window.teliumDesktop;
  vi.resetModules();
});

describe('Electron desktop shell', () => {
  it('uses the preload bridge for external links and native-shell behavior', async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    window.teliumDesktop = { runtime: 'electron', openExternal };
    vi.resetModules();

    const platform = await import('../lib/platform.js');
    expect(platform.isElectron).toBe(true);
    expect(platform.isNativeShell).toBe(true);
    expect(platform.isTauriRuntime()).toBe(true);

    await platform.openExternal('https://example.com/a');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a');
  });

  it('keeps Gofile playback direct instead of falling back to the homeserver proxy', async () => {
    const prepareGofilePlayback = vi.fn().mockResolvedValue(true);
    window.teliumDesktop = { runtime: 'electron', prepareGofilePlayback };
    vi.resetModules();

    const { gofilePlaybackUrl } = await import('../lib/external-media.js');
    const post = vi.fn(async (path) => {
      if (path === '/_telium/v1/media/external/gofile/session') {
        return { token: 'abcdefghijklmnop' };
      }
      throw new Error(`unexpected homeserver route: ${path}`);
    });
    const home = { base: 'https://home.example', post };
    const source = 'https://store-na-phx-5.gofile.io/download/web/file/movie.mp4';

    await expect(gofilePlaybackUrl(home, source)).resolves.toBe(source);
    expect(prepareGofilePlayback).toHaveBeenCalledWith(source, 'abcdefghijklmnop');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not register the browser service worker inside Electron', async () => {
    window.teliumDesktop = { runtime: 'electron' };
    vi.resetModules();
    const serviceWorker = await import('../lib/serviceworker.js');
    expect(serviceWorker.workerSupported).toBe(false);
    expect(serviceWorker.supported).toBe(false);
  });
});
