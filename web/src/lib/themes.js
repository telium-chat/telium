// Community themes, distributed through GitHub and applied as arbitrary CSS,
// in the style of BetterDiscord themes: one `.theme.css` file whose meta
// header (`@name`, `@author`, …) is read by machines and whose body is
// injected verbatim over the app's own palette. Like the changelog this is
// display-only data fetched over plain HTTPS and deliberately unsigned — the
// worst a hostile theme can do is look bad, and the report is one click away.
// Fetches are throttled and cached; installed theme CSS is device-local so a
// theme survives offline, while only the chosen id syncs with the account.

import { storage } from './util.js';

export const THEMES_URL = import.meta.env?.VITE_TELIUM_THEMES_URL
  || 'https://raw.githubusercontent.com/telium-chat/themes/main/catalog.json';

export const THEMES_PAGE = 'https://github.com/telium-chat/themes';
export const THEMES_SUBMIT_URL = 'https://github.com/telium-chat/themes/issues/new?template=submit-theme.yml';

const CATALOG_KEY = 'telium.themes.catalog.v1';
const INSTALLED_KEY = 'telium.themes.v1';
const STYLE_ID = 'telium-market-theme';

const REFRESH_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_THEME_BYTES = 512 * 1024;

export const FETCH_ERRORS = { unreachable: 'unreachable', tooLarge: 'too_large', invalid: 'invalid' };

// ------------------------------------------------------------------- the meta

/// BetterDiscord-style header: the first `/** ... *​/` block, one `@key value`
/// per line. Name, author and description are required; a theme without them
/// is not a theme the marketplace can show.
const META_LIMITS = { name: 64, author: 64, description: 400, license: 64 };

export function parseThemeMeta(css) {
  if (typeof css !== 'string' || !css.trim()) return null;
  const block = css.match(/\/\*\*([\s\S]*?)\*\//);
  if (!block) return null;
  const meta = {};
  for (const line of block[1].split(/\r?\n/)) {
    const match = line.match(/^\s*\**\s*@([A-Za-z][A-Za-z-]*)\s+(.+?)\s*$/);
    if (!match) continue;
    const [, key, value] = match;
    if (meta[key] === undefined) meta[key] = value;
  }
  const tags = typeof meta.tags === 'string'
    ? meta.tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 8)
    : [];
  if (tags.length) meta.tags = tags;
  else delete meta.tags;
  for (const [key, cap] of Object.entries(META_LIMITS)) {
    if (typeof meta[key] === 'string' && meta[key].length > cap) meta[key] = `${meta[key].slice(0, cap - 1)}…`;
    else if (meta[key] === undefined) delete meta[key];
  }
  if (!meta.name || !meta.author || !meta.description) return null;
  return meta;
}

// ---------------------------------------------------------------- the catalog

/// Catalog URLs must be https — except loopback http, which is how a local
/// `dev-serve` catalog is tested (THEMES_CDN_BASE=http://127.0.0.1:8787).
/// Production entries can never be downgraded to plain http, and loopback
/// can never be anything a stranger controls.
function catalogUrlOk(url) {
  if (typeof url !== 'string') return false;
  if (/^https:\/\//.test(url)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(url);
}

/// Contract: `{ generatedAt, themes: [{ id, name, author, version, description,
/// tags, downloads, thumbnailUrl, cssUrl }] }`, ids unique and slug-shaped.
/// Anything else fails whole — a half-read catalog shows a half-marketplace.
export function parseCatalog(text) {
  if (!text) return null;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.themes)) return null;
  const seen = new Set();
  const themes = [];
  for (const entry of doc.themes) {
    if (!entry || typeof entry !== 'object') return null;
    const { id, name, author, cssUrl } = entry;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(id) || seen.has(id)) return null;
    if (typeof name !== 'string' || !name || typeof author !== 'string' || !author) return null;
    if (!catalogUrlOk(cssUrl)) return null;
    seen.add(id);
    themes.push({
      id,
      name: String(name).slice(0, META_LIMITS.name),
      author: String(author).slice(0, META_LIMITS.author),
      version: typeof entry.version === 'string' ? entry.version : null,
      description: typeof entry.description === 'string' ? entry.description.slice(0, META_LIMITS.description) : '',
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string').slice(0, 8) : [],
      downloads: Number.isFinite(entry.downloads) ? Math.max(0, Math.floor(entry.downloads)) : 0,
      thumbnailUrl: catalogUrlOk(entry.thumbnailUrl) ? entry.thumbnailUrl : null,
      cssUrl,
    });
  }
  return { generatedAt: typeof doc.generatedAt === 'string' ? doc.generatedAt : null, themes };
}

export async function fetchThemes({
  url = THEMES_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_CATALOG_BYTES,
} = {}) {
  const controller = new AbortController();
  const attempt = Promise.resolve()
    .then(() => fetchImpl(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }))
    .catch(() => null);
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const response = await Promise.race([attempt, timeout]);
    if (!response || !response.ok) return { error: FETCH_ERRORS.unreachable };
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) return { error: FETCH_ERRORS.tooLarge };
    return { text: new TextDecoder().decode(bytes) };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ------------------------------------------------------- catalog cache (device)

function readCatalogRow(storageImpl = storage) {
  try {
    const row = storageImpl.get(CATALOG_KEY, null);
    return row && typeof row === 'object' ? row : null;
  } catch {
    return null;
  }
}

function writeCatalogRow(storageImpl = storage, row) {
  try {
    storageImpl.set(CATALOG_KEY, row);
  } catch {
    /* private browsing, full quota: the list refetches next launch */
  }
}

/// Null when none or it no longer parses.
export function cachedCatalog(storageImpl = storage) {
  const row = readCatalogRow(storageImpl);
  if (!row || typeof row.text !== 'string') return null;
  return parseCatalog(row.text);
}

export function catalogIsFresh(storageImpl = storage, ttlMs = REFRESH_TTL_MS) {
  const row = readCatalogRow(storageImpl);
  return Boolean(row?.at) && Date.now() - row.at < ttlMs;
}

export function cacheCatalog(text, storageImpl = storage) {
  writeCatalogRow(storageImpl, { at: Date.now(), text });
}

let inflight = null;

/// Concurrent callers share one fetch.
export function refreshThemes(deps = {}, storageImpl = storage) {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { text } = await fetchThemes(deps);
      if (typeof text !== 'string') return null;
      const parsed = parseCatalog(text);
      if (!parsed) return null;
      cacheCatalog(text, storageImpl);
      return parsed;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function refreshThemesIfStale(deps = {}, storageImpl = storage) {
  if (catalogIsFresh(storageImpl)) {
    return Promise.resolve(cachedCatalog(storageImpl));
  }
  return refreshThemes(deps, storageImpl);
}

// --------------------------------------------------------------------- search

/// Case-folded match over name, author, description and tags, best first:
/// whole-phrase name hits, then name starts-with, then name includes, then
/// author, then anything. Stable within a rank so the catalog's own order
/// (the CI sorts by downloads) survives a broad query.
export function searchThemes(catalog, query) {
  const themes = catalog?.themes || [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return themes.slice();
  const rank = (theme) => {
    const name = theme.name.toLowerCase();
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (name.includes(needle)) return 2;
    if (theme.author.toLowerCase().includes(needle)) return 3;
    if (theme.description.toLowerCase().includes(needle)) return 4;
    if (theme.tags.some((tag) => tag.toLowerCase().includes(needle))) return 5;
    return 6;
  };
  return themes
    .map((theme) => [rank(theme), theme])
    .filter(([rank]) => rank < 6)
    .sort((a, b) => a[0] - b[0])
    .map(([, theme]) => theme);
}

// ------------------------------------------------------------------ installed

function readInstalled(storageImpl = storage) {
  try {
    const row = storageImpl.get(INSTALLED_KEY, null);
    if (!row || typeof row !== 'object' || typeof row.installed !== 'object' || !row.installed) {
      return { installed: {}, active: null };
    }
    return { installed: row.installed, active: typeof row.active === 'string' ? row.active : null };
  } catch {
    return { installed: {}, active: null };
  }
}

function writeInstalled(row, storageImpl = storage) {
  try {
    storageImpl.set(INSTALLED_KEY, row);
  } catch {
    /* full quota: the install reports failure rather than half-landing */
    return false;
  }
  return true;
}

export function installedTheme(id, storageImpl = storage) {
  const theme = readInstalled(storageImpl).installed[id];
  return theme && typeof theme === 'object' && typeof theme.css === 'string' ? theme : null;
}

export function installedThemeIds(storageImpl = storage) {
  return Object.keys(readInstalled(storageImpl).installed);
}

/// The CSS to inject for the synced choice, or null when the id has no local
/// copy (a fresh device before its first fetch) — the base scheme then shows.
export function marketThemeCss(id, storageImpl = storage) {
  if (!id) return null;
  return installedTheme(id, storageImpl)?.css || null;
}

export function installTheme(id, css, storageImpl = storage) {
  const meta = parseThemeMeta(css);
  if (!id || typeof css !== 'string' || !meta) return null;
  const row = readInstalled(storageImpl);
  row.installed[id] = { meta, css, installedAt: Date.now() };
  return writeInstalled(row, storageImpl) ? { id, meta } : null;
}

export function removeTheme(id, storageImpl = storage) {
  const row = readInstalled(storageImpl);
  if (!row.installed[id]) return false;
  delete row.installed[id];
  if (row.active === id) row.active = null;
  return writeInstalled(row, storageImpl);
}

// -------------------------------------------------------------------- applied

/// One reusable style element, replaced rather than appended: a previous
/// theme's rules must never outlive its uninstall.
///
/// The injected CSS is specificity-boosted first. Telium's own palette rules
/// are written on `[data-theme="dark"]` / `[data-theme="light"]`
/// (specificity 0,2,0) while BetterDiscord-style themes declare their tokens
/// on plain `:root` (0,1,0) — unmodified, the app's palette would legally
/// out-rank every community theme and the theme would apply to nothing.
/// `:root` doubles to `:root:root` and bare `[data-theme=…]` gains a `:root`
/// prefix, so theme rules tie the app's and win by cascade order (the style
/// element sits last in `<head>`). A theme that names its mode in the header
/// also moves `data-theme`, so light themes bring light component styling
/// with them.
export function boostThemeCss(css) {
  return css
    .replace(/:root(?![\w-])/g, ':root:root')
    .replace(/\[data-theme=(["'])(light|dark)\1\]/g, ':root[data-theme=$2]');
}

export function applyMarketTheme(css) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(STYLE_ID);
  if (typeof css !== 'string' || !css.trim()) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.append(el);
  }
  el.textContent = boostThemeCss(css);
  const mode = parseThemeMeta(css)?.mode;
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
}

/// Reads the synced choice and applies whatever is on this device for it.
export function applyMarketThemeFromPrefs(id, storageImpl = storage) {
  applyMarketTheme(marketThemeCss(id, storageImpl));
}

// ------------------------------------------------------------------ trending

/// ISO 8601 week number, in UTC. The marketplace's rotation clock: everyone
/// on the same week sees the same trending page, and the page turns over
/// when the week does — no server round-trip involved.
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
}

export const TRENDING = { pool: 12, page: 6 };

/// The week's trending page: the most downloaded themes, paged through so a
/// deep catalog still gives every theme its week in front. Deterministic per
/// week — the catalog's own numbers and order decide, and equal counts keep
/// the catalog's ordering (the CI sorts it by downloads).
export function trendingThemes(catalog, {
  poolSize = TRENDING.pool,
  pageSize = TRENDING.page,
  now = new Date(),
} = {}) {
  const pool = (catalog?.themes || [])
    .slice()
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, poolSize);
  if (!pool.length) return [];
  const start = ((isoWeek(now) - 1) * pageSize) % pool.length;
  const out = [];
  const count = Math.min(pageSize, pool.length);
  for (let i = 0; i < count; i += 1) out.push(pool[(start + i) % pool.length]);
  return out;
}

// ------------------------------------------------------------------ favorites

/// Local install bumps: the catalog's download counts refresh hourly from the
/// CDN, so a fresh install would otherwise sit at "0 downloads" until the next
/// catalog round-trip — and in a local test the CDN never sees the install at
/// all. Each device counts its own installs and adds them at display time.
const BUMPS_KEY = 'telium.themes.bumps.v1';

function readBumps(storageImpl = storage) {
  try {
    const row = storageImpl.get(BUMPS_KEY, null);
    return row && typeof row === 'object' ? row : {};
  } catch {
    return {};
  }
}

export function noteLocalInstall(id, storageImpl = storage) {
  if (typeof id !== 'string' || !id) return 0;
  const row = readBumps(storageImpl);
  const next = (Number(row[id]) || 0) + 1;
  row[id] = next;
  try {
    storageImpl.set(BUMPS_KEY, row);
  } catch { /* full quota: the count display loses nothing that matters */ }
  return next;
}

export function localInstallCount(id, storageImpl = storage) {
  if (typeof id !== 'string' || !id) return 0;
  return Number(readBumps(storageImpl)[id]) || 0;
}

/// Favorites ride `prefs.themeFavorites` (an id array, capped) so they sync
/// with the account the way the applied theme's id does. A favorite of a
/// theme not installed is still meaningful — it is a bookmark; the card in
/// the marketplace stays findable from the favorites section either way.
export const MAX_FAVORITES = 100;

/// Normalised: an unreadable or oversized value is never read as permission.
export function favoriteIds(prefs) {
  const list = prefs?.themeFavorites;
  return Array.isArray(list)
    ? list.filter((id) => typeof id === 'string').slice(0, MAX_FAVORITES)
    : [];
}

export function isFavorite(prefs, id) {
  return favoriteIds(prefs).includes(id);
}

/// Writes through `savePrefs` (the caller's store), so the change syncs and
/// emits `prefs`. Returns the new state; `false` when the cap was hit.
export function toggleFavorite(store, id) {
  if (!id || typeof id !== 'string') return null;
  const current = favoriteIds(store.prefs);
  const next = current.includes(id)
    ? current.filter((seen) => seen !== id)
    : current.length >= MAX_FAVORITES
      ? null
      : [...current, id];
  if (next === null) return false;
  if (next.length === current.length) return false;
  store.prefs.themeFavorites = next;
  store.savePrefs();
  return current.includes(id) ? false : true;
}

// ------------------------------------------------------------------- fetching

export const THEME_ERRORS = {
  ...FETCH_ERRORS,
  noMeta: 'no_meta',
  quota: 'quota',
};

/// Downloads a theme's CSS and stores it device-local. Never throws.
/// `onProgress` receives `{ received, total }` as the body streams in —
/// `total` is null when the server sent no Content-Length, and the cap is
/// enforced mid-stream, not just after.
export async function downloadTheme({
  id,
  cssUrl,
  onProgress = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_THEME_BYTES,
} = {}, storageImpl = storage) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const attempt = Promise.resolve()
      .then(() => fetchImpl(cssUrl, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }))
      .catch(() => null);
    const response = await Promise.race([attempt, timeout]);
    if (!response || !response.ok) return { error: THEME_ERRORS.unreachable };

    let css;
    const reader = response.body && typeof response.body.getReader === 'function'
      ? response.body.getReader()
      : null;
    if (reader) {
      let total = null;
      try {
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > 0) total = declared;
      } catch { /* fakes without headers still stream fine */ }
      let received = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          controller.abort();
          return { error: THEME_ERRORS.tooLarge };
        }
        chunks.push(value);
        onProgress?.({ received, total });
      }
      const bytes = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      css = new TextDecoder().decode(bytes);
    } else {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > maxBytes) return { error: THEME_ERRORS.tooLarge };
      css = new TextDecoder().decode(bytes);
    }

    const installed = installTheme(id, css, storageImpl);
    if (!installed) return { error: THEME_ERRORS.noMeta };
    return { theme: installed };
  } catch {
    return { error: THEME_ERRORS.unreachable };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ------------------------------------------------------------------ formatting

export function formatDownloads(count) {
  const n = Number(count) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}
