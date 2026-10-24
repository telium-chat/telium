import { describe, expect, it, vi } from 'vitest';
import {
  GiphyProvider, KlipyProvider, giphyGifId, giphyMediaUrl, isGifOnlyContent, isGiphyShareUrl,
  isKlipyShareUrl, isLikelyGifUrl, isTeliumMediaUrl, isTenorShareUrl,
  klipyConfig, klipyShareSlug, normalizeGifUrl, normalizeKlipyResult, normalizeTenorResult,
  removeGifFavorite, tenorConfig, tenorPostId, TenorProvider, toggleGifFavorite,
} from '../lib/gifs.js';

import { KEYS, MAX_GIF_FAVORITES, SyncStore } from '../lib/sync.js';

describe('GIF provider adapter', () => {
  const config = {
    enabled: true,
    apiKey: 'public-test-key',
    apiBaseUrl: 'https://api.klipy.com/api/v1',
    mediaHosts: ['media.klipy.com'],
  };

  it('normalizes nested media and ignores malformed results', () => {
    expect(normalizeKlipyResult({
      id: 'one',
      file: { md: { gif: { url: 'https://media.klipy.com/one.gif', width: 320, height: 180 } } },
    })).toMatchObject({
      id: 'one', url: 'https://media.klipy.com/one.gif', previewUrl: 'https://media.klipy.com/one.gif',
      width: 320, height: 180,
    });
    expect(normalizeKlipyResult({ id: 'bad', file: { md: { gif: {} } } })).toBeNull();
  });

  it('requests trending and search with pagination', async () => {
    const fetcher = vi.fn(async (url) => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'one', url: 'https://media.klipy.com/one.gif' }],
        meta: { next_page: 4 },
      }),
    }));
    const provider = new KlipyProvider(config, { fetcher, debounceMs: 0 });
    await provider.trending({ page: 2, perPage: 12 });
    await provider.search('cats', { page: 4, perPage: 12 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toContain('/public-test-key/gifs/trending?');
    expect(fetcher.mock.calls[0][0]).toContain('page=2');
    expect(fetcher.mock.calls[1][0]).toContain('/public-test-key/gifs/search?');
    expect(fetcher.mock.calls[1][0]).toContain('q=cats');
  });

  it('cancels the previous request for the same mode', async () => {
    const fetcher = vi.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const provider = new KlipyProvider(config, { fetcher, debounceMs: 0 });
    const first = provider.search('cat');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = provider.search('cats');
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    second.catch(() => {});
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('normalizes URLs and recognizes direct provider media', () => {
    expect(normalizeGifUrl('http://media.klipy.com/a.gif')).toBeNull();
    expect(normalizeGifUrl(' https://media.klipy.com/a.gif ')).toBe('https://media.klipy.com/a.gif');
    expect(klipyShareSlug('https://klipy.com/gifs/big-brother-is-watching-you-5')).toBe('big-brother-is-watching-you-5');
    expect(isKlipyShareUrl('https://klipy.com/gifs/big-brother-is-watching-you-5')).toBe(true);
    expect(tenorPostId('https://tenor.com/view/hypergamy-admin-learns-about-hypergamy-oy-vey-admin-gif-6459198981897272921'))
      .toBe('6459198981897272921');
    expect(isTenorShareUrl('https://tenor.com/view/reaction-gif-123')).toBe(true);
    expect(giphyGifId('https://giphy.com/gifs/RespectiveCollective-side-eye-cute-cat-fluffy-GAXXHdS0zXawVLOJLY'))
      .toBe('GAXXHdS0zXawVLOJLY');
    expect(isGiphyShareUrl('https://giphy.com/gifs/GAXXHdS0zXawVLOJLY')).toBe(true);
    expect(isLikelyGifUrl('https://media.klipy.com/a', config)).toBe(true);
    expect(isLikelyGifUrl('https://example.com/a.gif', config)).toBe(true);
    expect(isLikelyGifUrl('https://klipy.com/gifs/funny-cat', config)).toBe(true);
    expect(isLikelyGifUrl('https://klipy.com/gif/funny-cat.gif', config)).toBe(true);
    expect(isLikelyGifUrl('https://tenor.com/view/reaction-gif-123', config)).toBe(true);
    expect(isLikelyGifUrl('https://giphy.com/gifs/RespectiveCollective-side-eye-cute-cat-fluffy-GAXXHdS0zXawVLOJLY', config)).toBe(true);
    expect(isGifOnlyContent('https://media.klipy.com/a', config)).toBe(true);
    expect(isGifOnlyContent('https://klipy.com/gifs/funny-cat', config)).toBe(true);
    expect(isGifOnlyContent('https://tenor.com/view/reaction-gif-123', config)).toBe(true);
    const stagingMediaUrl = 'https://staging.telium.chat/_telium/v1/media/56f76a51c49770ed186029f72e4cde37dbb238eae652ce58247cf603a8f5073f?cap=SmnvnGCZyUUwB88e-02kQeo-K16XBhww';
    expect(isTeliumMediaUrl(stagingMediaUrl)).toBe(true);
    expect(isTeliumMediaUrl('https://staging.telium.chat/_telium/v1/media/remote/home.example/12345?cap=abc')).toBe(true);
    expect(isTeliumMediaUrl('https://staging.telium.chat/_telium/v1/media/external/gofile/play?sig=signed')).toBe(false);
    expect(isTeliumMediaUrl('https://example.com/other')).toBe(false);
    expect(isLikelyGifUrl(stagingMediaUrl, config)).toBe(true);
    expect(isGifOnlyContent(stagingMediaUrl, config)).toBe(true);
    expect(isGifOnlyContent(`look ${stagingMediaUrl}`, config)).toBe(false);
    expect(isGifOnlyContent('look https://media.klipy.com/a', config)).toBe(false);
  });


  it('resolves a Klipy share page to its direct media URL', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{
          id: 'one',
          slug: 'big-brother-is-watching-you-5--kNcWQFFAe',
          file: { md: { gif: { url: 'https://static.klipy.com/one.gif' } } },
        }],
        meta: { next_page: null },
      }),
    }));
    const provider = new KlipyProvider(config, { fetcher, debounceMs: 0 });
    await expect(provider.resolveShareUrl(
      'https://klipy.com/gifs/big-brother-is-watching-you-5',
    )).resolves.toBe('https://static.klipy.com/one.gif');
    expect(fetcher.mock.calls[0][0]).toContain('q=big-brother-is-watching-you-5');
  });

  it('calls the browser fetch method with the correct receiver', async () => {
    const previous = globalThis.fetch;
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [], meta: { next_page: null } }),
    }));
    globalThis.fetch = fetcher;
    try {
      await new KlipyProvider(config, { debounceMs: 0 }).trending();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('resolves a Tenor share page to its direct GIF URL', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{
          id: '6459198981897272921',
          media_formats: {
            mediumgif: { url: 'https://media1.tenor.com/test/hypergamy.gif', dims: [373, 266] },
            gif: { url: 'https://media1.tenor.com/test/hypergamy-full.gif', dims: [498, 355] },
            tinygif: { url: 'https://media1.tenor.com/test/hypergamy-small.gif', dims: [165, 118] },
          },
        }],
      }),
    }));
    const config = tenorConfig({ tenor_provider: {
      api_key: 'public-test-key',
      client_key: 'test-client',
      api_base_url: 'https://tenor.googleapis.com/v2',
    } });
    const provider = new TenorProvider(config, { fetcher });
    await expect(provider.resolveShareUrl(
      'https://tenor.com/view/hypergamy-admin-learns-about-hypergamy-oy-vey-admin-gif-6459198981897272921',
    )).resolves.toBe('https://media1.tenor.com/test/hypergamy.gif');
    expect(fetcher.mock.calls[0][0]).toContain('/v2/posts?');
    expect(fetcher.mock.calls[0][0]).toContain('ids=6459198981897272921');
    expect(normalizeTenorResult({ media_formats: { gif: { url: 'https://media.tenor.com/a.gif' } } })).toMatchObject({
      url: 'https://media.tenor.com/a.gif', provider: 'tenor',
    });
  });

  it('resolves a Tenor share page whose URL uses a legacy post id', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{
          id: '13629125742923910469',
          legacy_info: { post_id: '23651813' },
          media_formats: {
            mediumgif: { url: 'https://media1.tenor.com/m/test/clapping-wow.gif', dims: [640, 640] },
          },
        }],
      }),
    }));
    const config = tenorConfig({ tenor_provider: {
      api_key: 'public-test-key',
      client_key: 'test-client',
      api_base_url: 'https://tenor.googleapis.com/v2',
    } });
    const provider = new TenorProvider(config, { fetcher });
    await expect(provider.resolveShareUrl(
      'https://tenor.com/view/clapping-wow-wow-starts-clapping-gif-23651813',
    )).resolves.toBe('https://media1.tenor.com/m/test/clapping-wow.gif');
  });

  it('resolves a Giphy share page to its stable direct GIF URL', async () => {
    const provider = new GiphyProvider();
    const shareUrl = 'https://giphy.com/gifs/RespectiveCollective-side-eye-cute-cat-fluffy-GAXXHdS0zXawVLOJLY';
    await expect(provider.resolveShareUrl(shareUrl)).resolves.toBe(
      'https://media.giphy.com/media/GAXXHdS0zXawVLOJLY/giphy.gif',
    );
    expect(giphyMediaUrl('GAXXHdS0zXawVLOJLY')).toBe(
      'https://media.giphy.com/media/GAXXHdS0zXawVLOJLY/giphy.gif',
    );
  });

  it('supports runtime overrides and disabled providers', () => {
    expect(klipyConfig({ gif_provider: { api_key: 'runtime', enabled: true } })).toMatchObject({
      apiKey: 'runtime', enabled: true,
    });
    expect(klipyConfig({ gif_provider: { api_key: 'runtime', enabled: false } }).enabled).toBe(false);
  });

  it('deduplicates, validates, and caps favorites', () => {
    const values = ['http://bad.example/a.gif', ...Array.from({ length: MAX_GIF_FAVORITES + 5 }, (_, i) => `https://media.klipy.com/${i}.gif`), 'https://media.klipy.com/1.gif'];
    const store = {
      sync: { get: () => values, set: vi.fn() },
      emit: vi.fn(),
    };
    toggleGifFavorite(store, 'https://media.klipy.com/new.gif');
    expect(store.sync.set).toHaveBeenCalledWith('gif.favorites.v1', expect.any(Array));
    expect(store.sync.set.mock.calls[0][1]).toHaveLength(MAX_GIF_FAVORITES);
    expect(store.sync.set.mock.calls[0][1]).not.toContain('http://bad.example/a.gif');
  });

  it('removes a favorite idempotently instead of toggling a stale tile back on', () => {
    const set = vi.fn();
    const emit = vi.fn();
    const store = {
      sync: { get: () => [], set },
      emit,
    };
    expect(removeGifFavorite(store, 'https://media.klipy.com/stale.gif')).toEqual([]);
    expect(set).toHaveBeenCalledWith(KEYS.gifFavorites, []);
    expect(emit).toHaveBeenCalledWith('gif-favorites');
  });

  it('sanitizes the synced value before mirroring or pushing it', () => {
    const sync = new SyncStore();
    sync.set(KEYS.gifFavorites, ['http://bad.example/a.gif', 'https://example.com/a.gif', 'https://example.com/a.gif']);
    expect(sync.get(KEYS.gifFavorites)).toEqual(['https://example.com/a.gif']);
  });
});
