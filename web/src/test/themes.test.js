import { describe, expect, it } from 'vitest';
import {
  applyMarketTheme, applyMarketThemeFromPrefs, cacheCatalog, cachedCatalog, catalogIsFresh,
  downloadTheme, favoriteIds, fetchThemes, formatDownloads, installTheme, installedTheme,
  installedThemeIds, isFavorite, isoWeek, localInstallCount, marketThemeCss, noteLocalInstall,
  parseCatalog, parseThemeMeta, refreshThemes, removeTheme, searchThemes, THEME_ERRORS,
  toggleFavorite, trendingThemes,
} from '../lib/themes.js';

const META_CSS = `/**
 * @name Midnight Glass
 * @author nova
 * @version 1.2.0
 * @description A glassy dark theme with blur everywhere.
 * @website https://example.org/midnight-glass
 * @license MIT
 * @tags dark, glass, blur
*/

:root {
  --background: oklch(14% 0.02 286);
}
.theme-card { backdrop-filter: blur(8px); }
`;

const store = () => {
  const data = new Map();
  return {
    get: (key, fallback) => (data.has(key) ? JSON.parse(data.get(key)) : fallback),
    set: (key, value) => { data.set(key, JSON.stringify(value)); },
  };
};

const fetchReturning = (body, ok = true) => async () => ({
  ok,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

const CATALOG_TEXT = JSON.stringify({
  generatedAt: '2026-11-20T00:00:00Z',
  themes: [
    {
      id: 'midnight-glass', name: 'Midnight Glass', author: 'nova', version: '1.2.0',
      description: 'A glassy dark theme.', tags: ['dark', 'glass'], downloads: 12400,
      thumbnailUrl: 'https://cdn.jsdelivr.net/gh/telium-chat/themes@main/themes/midnight-glass/thumbnail.png',
      cssUrl: 'https://cdn.jsdelivr.net/gh/telium-chat/themes@main/themes/midnight-glass/midnight-glass.theme.css',
    },
    {
      id: 'solar-flare', name: 'Solar Flare', author: 'ray', version: '0.1.0',
      description: 'Warm light theme.', tags: ['light'], downloads: 930,
      thumbnailUrl: null,
      cssUrl: 'https://cdn.jsdelivr.net/gh/telium-chat/themes@main/themes/solar-flare/solar-flare.theme.css',
    },
  ],
});

describe('parseThemeMeta', () => {
  it('reads a BetterDiscord-style header', () => {
    const meta = parseThemeMeta(META_CSS);
    expect(meta.name).toBe('Midnight Glass');
    expect(meta.author).toBe('nova');
    expect(meta.version).toBe('1.2.0');
    expect(meta.description).toBe('A glassy dark theme with blur everywhere.');
    expect(meta.license).toBe('MIT');
    expect(meta.tags).toEqual(['dark', 'glass', 'blur']);
  });

  it('requires name, author and description', () => {
    expect(parseThemeMeta(':root { --accent: red; }')).toBeNull();
    expect(parseThemeMeta(`/**
 * @name No author
 * @description half a theme
*/
:root {}`)).toBeNull();
    expect(parseThemeMeta('')).toBeNull();
    expect(parseThemeMeta(null)).toBeNull();
  });

  it('caps runaway fields rather than trusting the file', () => {
    const meta = parseThemeMeta(`/**
 * @name ${'x'.repeat(500)}
 * @author nova
 * @description ${'y'.repeat(900)}
*/
:root {}`);
    expect(meta.name.length).toBeLessThanOrEqual(64);
    expect(meta.description.length).toBeLessThanOrEqual(400);
    expect(meta.name.endsWith('…')).toBe(true);
  });

  it('takes tags from a comma list and caps the count', () => {
    const meta = parseThemeMeta(`/**
 * @name T
 * @author a
 * @description d
 * @tags a,b,c,d,e,f,g,h,i,j
*/
:root {}`);
    expect(meta.tags).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });
});

describe('parseCatalog', () => {
  it('parses a catalog and fills defaults', () => {
    const catalog = parseCatalog(CATALOG_TEXT);
    expect(catalog.generatedAt).toBe('2026-11-20T00:00:00Z');
    expect(catalog.themes).toHaveLength(2);
    expect(catalog.themes[0].downloads).toBe(12400);
  });

  it('rejects anything malformed wholesale', () => {
    expect(parseCatalog('not json')).toBeNull();
    expect(parseCatalog('{}')).toBeNull();
    expect(parseCatalog('{"themes": [{}]}')).toBeNull();
    expect(parseCatalog('{"themes": [{"id": "UPPER", "name": "n", "author": "a", "cssUrl": "https://x/y.css"}]}')).toBeNull();
    expect(parseCatalog('{"themes": [{"id": "ok-id", "name": "n", "author": "a", "cssUrl": "http://x/y.css"}]}')).toBeNull();
    expect(parseCatalog(`{"themes": [
      {"id": "one", "name": "n", "author": "a", "cssUrl": "https://x/1.css"},
      {"id": "one", "name": "n", "author": "a", "cssUrl": "https://x/2.css"}
    ]}`)).toBeNull();
  });

  it('loopback http is the one non-https exception, so a local dev catalog loads', () => {
    const local = `{"themes": [
      {"id": "one", "name": "n", "author": "a", "cssUrl": "http://127.0.0.1:8787/themes/one/one.theme.css", "thumbnailUrl": "http://127.0.0.1:8787/themes/one/thumbnail.svg"},
      {"id": "two", "name": "n", "author": "a", "cssUrl": "http://localhost:8787/two.theme.css"}
    ]}`;
    const catalog = parseCatalog(local);
    expect(catalog.themes).toHaveLength(2);
    // Plain http to a real host is still refused: only loopback is trusted.
    expect(parseCatalog('{"themes": [{"id": "one", "name": "n", "author": "a", "cssUrl": "http://10.0.0.5/x.css"}]}')).toBeNull();
    expect(parseCatalog('{"themes": [{"id": "one", "name": "n", "author": "a", "cssUrl": "http://cdn.example.com/x.css"}]}')).toBeNull();
  });

  it('clamps negative downloads and drops bad thumbnails', () => {
    const catalog = parseCatalog(`{"themes": [
      {"id": "one", "name": "n", "author": "a", "cssUrl": "https://x/1.css", "downloads": -5, "thumbnailUrl": "ftp://x/t.png"}
    ]}`);
    expect(catalog.themes[0].downloads).toBe(0);
    expect(catalog.themes[0].thumbnailUrl).toBeNull();
  });
});

describe('fetch and cache', () => {
  it('fetches a catalog and caches it', async () => {
    const storageImpl = store();
    const parsed = await refreshThemes({ fetchImpl: fetchReturning(CATALOG_TEXT) }, storageImpl);
    expect(parsed.themes).toHaveLength(2);
    expect(cachedCatalog(storageImpl).themes).toHaveLength(2);
    expect(catalogIsFresh(storageImpl)).toBe(true);
  });

  it('reports unreachable and too-large like the changelog does', async () => {
    expect((await fetchThemes({ fetchImpl: fetchReturning('', false) })).error).toBe('unreachable');
    const big = { arrayBuffer: async () => new ArrayBuffer(300 * 1024) };
    expect((await fetchThemes({ fetchImpl: async () => ({ ok: true, ...big }) })).error).toBe('too_large');
  });

  it('shares one in-flight refresh', async () => {
    const storageImpl = store();
    const fetchImpl = vi_like(fetchReturning(CATALOG_TEXT));
    const [a, b] = [refreshThemes({ fetchImpl }, storageImpl), refreshThemes({ fetchImpl }, storageImpl)];
    expect(await a).toBe(await b);
  });
});

const vi_like = (impl) => {
  let calls = 0;
  return async (...args) => { calls += 1; return impl(...args); };
};

describe('searchThemes', () => {
  const catalog = parseCatalog(CATALOG_TEXT);

  it('empty query keeps catalog order', () => {
    expect(searchThemes(catalog, '  ').map((theme) => theme.id)).toEqual(['midnight-glass', 'solar-flare']);
  });

  it('ranks name hits over description hits', () => {
    const hit = searchThemes(catalog, 'solar');
    expect(hit).toHaveLength(1);
    expect(hit[0].id).toBe('solar-flare');
    expect(searchThemes(catalog, 'glassy').map((theme) => theme.id)).toEqual(['midnight-glass']);
    expect(searchThemes(catalog, 'ray')).toHaveLength(1);
    expect(searchThemes(catalog, 'zzz')).toHaveLength(0);
  });

  it('is null-safe without a catalog', () => {
    expect(searchThemes(null, '')).toEqual([]);
    expect(searchThemes(null, 'x')).toEqual([]);
  });
});

describe('boostThemeCss', () => {
  it('lifts :root and bare data-theme selectors above the app palette', async () => {
    const { boostThemeCss } = await import('../lib/themes.js');
    const boosted = boostThemeCss(`:root { --background: red; }
[data-theme="dark"] & { x } [data-theme='light'] { --accent: blue; }`);
    expect(boosted).toContain(':root:root { --background: red; }');
    expect(boosted).toContain(":root[data-theme=dark]");
    expect(boosted).toContain(":root[data-theme=light]");
  });

  it('already-prefixed selectors keep working and gain the boost too', async () => {
    const { boostThemeCss } = await import('../lib/themes.js');
    // Quoting is normalized away — unquoted attribute values are valid CSS.
    expect(boostThemeCss(':root[data-theme="dark"] { a }')).toContain(':root:root:root[data-theme=dark]');
  });
});

describe('install, apply and remove', () => {
  it('installTheme requires a parseable meta header', () => {
    const storageImpl = store();
    expect(installTheme('no-header', ':root {}', storageImpl)).toBeNull();
    expect(installedThemeIds(storageImpl)).toEqual([]);
    expect(installTheme('midnight-glass', META_CSS, storageImpl).meta.name).toBe('Midnight Glass');
    expect(installedTheme('midnight-glass', storageImpl).css).toBe(META_CSS);
  });

  it('applyMarketTheme keeps exactly one style element', () => {
    applyMarketTheme(META_CSS);
    const el = document.getElementById('telium-market-theme');
    expect(el).toBeTruthy();
    expect(el.textContent).toContain(":root:root");
    applyMarketTheme('/* replaced */');
    expect(document.getElementById('telium-market-theme')).toBe(el);
    expect(el.textContent).toBe('/* replaced */');
    applyMarketTheme(null);
    expect(document.getElementById('telium-market-theme')).toBeNull();
  });

  it('marketThemeCss answers the device copy for a synced id', () => {
    const storageImpl = store();
    installTheme('midnight-glass', META_CSS, storageImpl);
    expect(marketThemeCss('midnight-glass', storageImpl)).toBe(META_CSS);
    expect(marketThemeCss('unknown', storageImpl)).toBeNull();
    expect(marketThemeCss(null, storageImpl)).toBeNull();
    applyMarketThemeFromPrefs('unknown', storageImpl);
    expect(document.getElementById('telium-market-theme')).toBeNull();
  });

  it('removeTheme clears the active id', () => {
    const storageImpl = store();
    installTheme('midnight-glass', META_CSS, storageImpl);
    const row = storageImpl.get('telium.themes.v1');
    row.active = 'midnight-glass';
    storageImpl.set('telium.themes.v1', row);
    expect(removeTheme('midnight-glass', storageImpl)).toBe(true);
    expect(removeTheme('midnight-glass', storageImpl)).toBe(false);
    expect(storageImpl.get('telium.themes.v1')).toEqual({ installed: {}, active: null });
  });
});

describe('downloadTheme', () => {
  const streamBody = (chunks) => new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

  it('reports byte progress while the body streams', async () => {
    const storageImpl = store();
    const seen = [];
    const outcome = await downloadTheme({
      id: 'midnight-glass',
      cssUrl: 'https://cdn.example/x.css',
      onProgress: ({ received, total }) => seen.push({ received, total }),
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (name) => (name === 'content-length' ? String(META_CSS.length + 20) : null) },
        body: streamBody([META_CSS.slice(0, 20), META_CSS.slice(20)]),
      }),
    }, storageImpl);
    expect(outcome.error).toBeUndefined();
    expect(outcome.theme.meta.name).toBe('Midnight Glass');
    expect(seen.length).toBe(2);
    expect(seen.at(-1).received).toBe(META_CSS.length);
    expect(seen.at(-1).total).toBe(META_CSS.length + 20);
  });

  it('enforces the byte cap mid-stream', async () => {
    const storageImpl = store();
    const big = 'x'.repeat(600 * 1024);
    const outcome = await downloadTheme({
      id: 'big',
      cssUrl: 'https://x/x.css',
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => null },
        body: streamBody([big.slice(0, 400 * 1024), big.slice(400 * 1024)]),
      }),
    }, storageImpl);
    expect(outcome.error).toBe('too_large');
    expect(installedThemeIds(storageImpl)).toEqual([]);
  });

  it('still installs through a fake without a streamable body', async () => {
    const storageImpl = store();
    const outcome = await downloadTheme({
      id: 'midnight-glass',
      cssUrl: 'https://x/x.css',
      fetchImpl: fetchReturning(META_CSS),
    }, storageImpl);
    expect(outcome.theme.meta.name).toBe('Midnight Glass');
  });

  it('refuses a file without a meta header and never stores it', async () => {
    const storageImpl = store();
    const outcome = await downloadTheme({ id: 'x', cssUrl: 'https://x/x.css', fetchImpl: fetchReturning(':root {}') }, storageImpl);
    expect(outcome.error).toBe(THEME_ERRORS.noMeta);
    expect(installedThemeIds(storageImpl)).toEqual([]);
  });

  it('fails soft on unreachable and oversized files', async () => {
    expect((await downloadTheme({ id: 'x', cssUrl: 'https://x/x.css', fetchImpl: fetchReturning('', false) }, store())).error).toBe('unreachable');
    const big = { arrayBuffer: async () => new ArrayBuffer(600 * 1024) };
    expect((await downloadTheme({ id: 'x', cssUrl: 'https://x/x.css', fetchImpl: async () => ({ ok: true, ...big }) }, store())).error).toBe('too_large');
  });
});

describe('formatDownloads', () => {
  it('rounds the way a card would print it', () => {
    expect(formatDownloads(0)).toBe('0');
    expect(formatDownloads(930)).toBe('930');
    expect(formatDownloads(12400)).toBe('12.4k');
    expect(formatDownloads(1_000_000)).toBe('1M');
    expect(formatDownloads(2_500_000)).toBe('2.5M');
    expect(formatDownloads(undefined)).toBe('0');
  });
});

describe('trending', () => {
  const date = (iso) => new Date(`${iso}T12:00:00Z`);
  const weekCatalog = (n) => ({
    themes: Array.from({ length: n }, (_, i) => ({
      id: `theme-${String(i).padStart(2, '0')}`,
      name: `Theme ${i}`,
      author: 'a',
      description: 'd',
      downloads: n - i, // descending, catalog order == popularity order
    })),
  });

  it('isoWeek answers known weeks', () => {
    expect(isoWeek(date('2026-01-01'))).toBe(1); // a Thursday
    expect(isoWeek(date('2026-11-20'))).toBe(47);
    expect(isoWeek(date('2027-01-03'))).toBe(53); // 2026 has 53 ISO weeks
  });

  it('shows the most downloaded, capped to the page size', () => {
    const page = trendingThemes(weekCatalog(20), { now: date('2026-11-20') });
    expect(page).toHaveLength(6);
    expect(page.map((theme) => theme.downloads)).toEqual([20, 19, 18, 17, 16, 15]);
  });

  it('a short catalog shows everything it has', () => {
    const page = trendingThemes(weekCatalog(2), { now: date('2026-11-20') });
    expect(page).toHaveLength(2);
    expect(trendingThemes({ themes: [] })).toEqual([]);
    expect(trendingThemes(null)).toEqual([]);
  });

  it('everyone on the same week sees the same page, and the page rotates', () => {
    const catalog = weekCatalog(20);
    const week47a = trendingThemes(catalog, { now: date('2026-11-20') });
    const week47b = trendingThemes(catalog, { now: date('2026-11-22') }); // still that Sunday
    expect(week47a.map((t) => t.id)).toEqual(week47b.map((t) => t.id));
    const week48 = trendingThemes(catalog, { now: date('2026-11-23') }); // Monday
    expect(week48.map((t) => t.id)).not.toEqual(week47a.map((t) => t.id));
    // The pool is 12 and the page 6: two weeks later the whole pool has cycled.
    const week49 = trendingThemes(catalog, { now: date('2026-11-30') });
    expect(week49.map((t) => t.id)).toEqual(week47a.map((t) => t.id));
  });
});

describe('favorites', () => {
  const fakeStore = () => {
    const prefs = {};
    return {
      prefs,
      saved: 0,
      savePrefs() { this.saved += 1; },
    };
  };

  it('an absent or malformed list answers empty, never an error', () => {
    expect(favoriteIds({})).toEqual([]);
    expect(favoriteIds({ themeFavorites: 'nope' })).toEqual([]);
    expect(favoriteIds({ themeFavorites: [1, 'ok', null, 'also-ok'] })).toEqual(['ok', 'also-ok']);
    expect(isFavorite({ themeFavorites: ['a'] }, 'a')).toBe(true);
    expect(isFavorite({}, 'a')).toBe(false);
  });

  it('toggles on and off through savePrefs', () => {
    const store = fakeStore();
    expect(toggleFavorite(store, 'midnight-glass')).toBe(true);
    expect(store.prefs.themeFavorites).toEqual(['midnight-glass']);
    expect(store.saved).toBe(1);
    expect(toggleFavorite(store, 'midnight-glass')).toBe(false);
    expect(store.prefs.themeFavorites).toEqual([]);
    expect(store.saved).toBe(2);
  });

  it('is a toggle: re-starring an unfavorite removes it, junk ids change nothing', () => {
    const store = fakeStore();
    toggleFavorite(store, 'one');
    // Toggling again is how the star un-favorites; `false` says "now off".
    expect(toggleFavorite(store, 'one')).toBe(false);
    expect(store.prefs.themeFavorites).toEqual([]);
    expect(toggleFavorite(store, null)).toBeNull();
    expect(toggleFavorite(store, '')).toBeNull();
    expect(store.prefs.themeFavorites).toEqual([]);
  });

  it('caps the list rather than growing it forever', () => {
    const store = fakeStore();
    for (let i = 0; i < 100; i += 1) toggleFavorite(store, `theme-${i}`);
    expect(store.prefs.themeFavorites).toHaveLength(100);
    expect(toggleFavorite(store, 'one-too-many')).toBe(false);
    expect(store.prefs.themeFavorites).toHaveLength(100);
    // Freeing a slot makes room again.
    toggleFavorite(store, 'theme-0');
    expect(toggleFavorite(store, 'one-too-many')).toBe(true);
  });
});

describe('local install bumps', () => {
  it('counts installs per device so the number moves before the CDN reports', () => {
    const storageImpl = store();
    expect(localInstallCount('midnight-glass', storageImpl)).toBe(0);
    expect(noteLocalInstall('midnight-glass', storageImpl)).toBe(1);
    expect(noteLocalInstall('midnight-glass', storageImpl)).toBe(2);
    expect(localInstallCount('midnight-glass', storageImpl)).toBe(2);
    expect(localInstallCount('solar-flare', storageImpl)).toBe(0);
  });

  it('refuses junk ids and survives a broken store', () => {
    expect(noteLocalInstall(null, store())).toBe(0);
    expect(localInstallCount(undefined, store())).toBe(0);
    const broken = { get: () => { throw new Error('boom'); }, set: () => {} };
    expect(localInstallCount('x', broken)).toBe(0);
    expect(noteLocalInstall('x', broken)).toBe(1); // counted in memory, write tolerated
  });
});

describe('catalog cache', () => {
  it('an unreadable or missing cache answers null', () => {
    expect(cachedCatalog(store())).toBeNull();
    cacheCatalog(CATALOG_TEXT, store());
  });

  it('a cached catalog survives without refetching while fresh', () => {
    const storageImpl = store();
    cacheCatalog(CATALOG_TEXT, storageImpl);
    expect(catalogIsFresh(storageImpl)).toBe(true);
    expect(cachedCatalog(storageImpl).themes).toHaveLength(2);
  });
});
