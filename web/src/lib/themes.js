// Community themes, distributed through GitHub and applied as arbitrary CSS,
// in the style of BetterDiscord themes: one `.theme.css` file whose meta
// header (`@name`, `@author`, …) is read by machines and whose body is
// injected verbatim over the app's own palette. Like the changelog this is
// display-only data fetched over plain HTTPS and deliberately unsigned. CSS is
// not harmless, though: any url() is a network request, so a theme could log
// the IP and online times of everyone wearing it. Every theme therefore passes
// a network policy before it is stored or applied (see `checkThemeUrls`):
// files may load only from the theme catalog itself, never from a host the
// author controls. Text overrides skip security and safety wording.
// Fetches are throttled and cached; installed theme CSS is device-local so a
// theme survives offline, while only the chosen id syncs with the account.

import { setThemeStrings } from './i18n/index.js';
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

const ASSET_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_ASSETS = 10;
const MAX_STRINGS = 400;
const MAX_STRING_KEY = 120;
const MAX_STRING_VALUE = 200;
const STRING_KEY = /^[A-Za-z0-9._-]{1,120}$/;

/// Per-theme image assets: `{ filename: url }`. The theme CSS references them
/// by bare filename inside `url(...)`; the rewrite at injection time swaps in
/// these URLs. Same origin rules as every catalog URL.
function parseAssets(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let count = 0;
  for (const [name, url] of Object.entries(raw)) {
    if (count >= MAX_ASSETS) break;
    if (!ASSET_NAME.test(name) || !catalogUrlOk(url)) continue;
    out[name] = url;
    count += 1;
  }
  return out;
}

/// Per-theme UI string overrides: `{ 'settings.market.title': '…' }`. Keys
/// the running build does not know are dropped later, at apply time — here
/// they are only shape-checked.
function parseStrings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_STRINGS) break;
    if (!STRING_KEY.test(key) || typeof value !== 'string' || !value) continue;
    out[key] = value.slice(0, MAX_STRING_VALUE);
    count += 1;
  }
  return out;
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
      assets: parseAssets(entry.assets),
      strings: parseStrings(entry.strings),
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

/// Null when the CSS has no usable header; false when storage refused the
/// write (quota) — the two are different problems with different fixes.
export function installTheme(id, css, storageImpl = storage, extras = {}) {
  const meta = parseThemeMeta(css);
  if (!id || typeof css !== 'string' || !meta) return null;
  const row = readInstalled(storageImpl);
  row.installed[id] = {
    meta,
    css,
    installedAt: Date.now(),
    source: extras.source === 'local' ? 'local' : 'catalog',
    // Images and string overrides ride along; both were sanitized when the
    // catalog was parsed, and both are re-checked at apply time.
    assets: parseAssets(extras.assets),
    strings: parseStrings(extras.strings),
  };
  return writeInstalled(row, storageImpl) ? { id, meta } : false;
}

export function removeTheme(id, storageImpl = storage) {
  const row = readInstalled(storageImpl);
  if (!row.installed[id]) return false;
  delete row.installed[id];
  if (row.active === id) row.active = null;
  return writeInstalled(row, storageImpl);
}

// -------------------------------------------------------------------- applied

/// Relative `url(...)` references in a theme's CSS resolve against the app's
/// origin, which is wrong for everything — so filenames that match one of the
/// theme's declared assets are rewritten to the asset's catalog URL before
/// injection. Absolute URLs pass through untouched; anything else is left
/// exactly as authored (BetterDiscord parity).
export function rewriteAssetUrls(css, assets = {}) {
  if (!css || typeof css !== 'string' || !Object.keys(assets).length) return css;
  return css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (whole, quote, name) => {
    // The validator accepts `url(images/bg.svg)` by its last segment, and the
    // catalog keys assets by bare filename — so a relative path resolves by
    // basename too. Absolute and root-relative references are left alone.
    const relative = !/^([a-z][a-z0-9+.-]*:|\/)/i.test(name);
    const url = assets[name] || (relative ? assets[name.split('/').pop()] : undefined);
    return url ? `url(${quote}${url}${quote})` : whole;
  });
}

// ------------------------------------------------------------ network policy

/// Where theme CSS may load files from. Everything a theme fetches is a
/// request someone can log, so the list is the catalog's own reviewed files
/// and nothing an author can point somewhere else: the jsDelivr path is
/// scoped to this repository's `main` branch, because the bare host serves
/// any GitHub repository (and any commit SHA, fork commits included).
/// `VITE_TELIUM_THEME_HOSTS` adds comma-separated https prefixes at build
/// time; the catalog's own directory is always allowed, which is how a
/// loopback `dev-serve` catalog keeps working.
const DEFAULT_ALLOWED_PREFIXES = [
  'https://cdn.jsdelivr.net/gh/telium-chat/themes@main/',
  'https://raw.githubusercontent.com/telium-chat/themes/main/',
];

function normalizedPrefix(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !catalogUrlOk(url.href)) return null;
    return url.href.endsWith('/') ? url.href : `${url.href}/`;
  } catch {
    return null;
  }
}

export function allowedThemePrefixes() {
  const extra = String(import.meta.env?.VITE_TELIUM_THEME_HOSTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^https:\/\//.test(entry));
  let catalogDir = null;
  try { catalogDir = new URL('./', THEMES_URL).href; } catch { /* malformed override */ }
  return [...new Set([...DEFAULT_ALLOWED_PREFIXES, ...extra, catalogDir]
    .map((entry) => (entry ? normalizedPrefix(entry) : null))
    .filter(Boolean))];
}

const HEX = /[0-9a-fA-F]/;
const SPACE = /[ \t\n\r\f]/;
const isNameChar = (c) => c !== undefined && (/[A-Za-z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80);
const validEscape = (css, i) => css[i] === '\\' && css[i + 1] !== undefined && !/[\n\r\f]/.test(css[i + 1]);

function consumeEscape(css, i) {
  let j = i + 1;
  if (j >= css.length) return ['\uFFFD', j];
  if (!HEX.test(css[j])) return [css[j], j + 1];
  let hex = '';
  while (j < css.length && hex.length < 6 && HEX.test(css[j])) hex += css[j++];
  if (css[j] === '\r' && css[j + 1] === '\n') j += 2;
  else if (SPACE.test(css[j] || '')) j += 1;
  const cp = parseInt(hex, 16);
  const bad = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff);
  return [bad ? '\uFFFD' : String.fromCodePoint(cp), j];
}

/// A tokenizer just deep enough for the policy, following CSS Syntax 3 where
/// it matters: comments are skipped, strings and unquoted `url()` bodies are
/// read with escapes decoded, and identifiers are decoded too — so `\75rl(`
/// and `@\69mport` are seen for what the browser will see. Regexes over the
/// raw text cannot be trusted with this; escapes and quote games walk past
/// them. Strings inside `[...]` are attribute-selector operands (never
/// fetched) and are left out, so `a[href^="https://…"]` is not a violation.
export function scanThemeCss(css) {
  const refs = [];
  let imports = 0;
  if (typeof css !== 'string') return { refs, imports };
  const n = css.length;
  let i = 0;
  let brackets = 0;
  const readName = () => {
    let name = '';
    while (i < n) {
      if (isNameChar(css[i])) { name += css[i]; i += 1; } else if (validEscape(css, i)) {
        const [ch, j] = consumeEscape(css, i);
        name += ch;
        i = j;
      } else break;
    }
    return name;
  };
  const readString = (quote) => {
    i += 1;
    let value = '';
    while (i < n) {
      const c = css[i];
      if (c === quote) { i += 1; break; }
      if (c === '\n' || c === '\r' || c === '\f') break;
      if (c === '\\') {
        const next = css[i + 1];
        if (next === undefined) { i += 1; break; }
        if (next === '\n' || next === '\f') { i += 2; continue; }
        if (next === '\r') { i += css[i + 2] === '\n' ? 3 : 2; continue; }
        const [ch, j] = consumeEscape(css, i);
        value += ch;
        i = j;
        continue;
      }
      value += c;
      i += 1;
    }
    return value;
  };
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const value = readString(c);
      if (brackets === 0) refs.push(value);
      continue;
    }
    if (c === '[') { brackets += 1; i += 1; continue; }
    if (c === ']') { brackets = Math.max(0, brackets - 1); i += 1; continue; }
    if (c === '{' || c === '}' || c === ';') { brackets = 0; i += 1; continue; }
    if (c === '@') {
      i += 1;
      if (readName().toLowerCase() === 'import') imports += 1;
      continue;
    }
    if (isNameChar(c) || validEscape(css, i)) {
      const name = readName();
      if (css[i] === '(' && name.toLowerCase() === 'url') {
        i += 1;
        while (i < n && SPACE.test(css[i])) i += 1;
        // A quoted argument is an ordinary string token: the branch above
        // reads it on the next turn of the loop.
        if (css[i] === '"' || css[i] === "'") continue;
        let value = '';
        while (i < n && css[i] !== ')') {
          if (validEscape(css, i)) {
            const [ch, j] = consumeEscape(css, i);
            value += ch;
            i = j;
          } else { value += css[i]; i += 1; }
        }
        i += 1;
        refs.push(value.trim());
      }
      continue;
    }
    i += 1;
  }
  return { refs, imports };
}

function documentBase() {
  try {
    if (typeof document !== 'undefined' && document.baseURI) return document.baseURI;
  } catch { /* detached documents in tests */ }
  return 'http://localhost/';
}

/// `{ ok, blocked, imports }`: `blocked` lists the hosts a theme would reach
/// that are not allowed. `@import` is refused outright — it pulls a whole
/// stylesheet nobody reviewed, from anywhere. `data:` URLs and the app's own
/// origin are fine (no third party sees them); so are the theme's declared
/// asset URLs, which the catalog itself produced.
export function checkThemeUrls(css, assets = {}, { prefixes = allowedThemePrefixes(), base = documentBase() } = {}) {
  const { refs, imports } = scanThemeCss(css);
  const exact = new Set(Object.values(assets || {}).filter((url) => typeof url === 'string'));
  let origin = null;
  try { origin = new URL(base).origin; } catch { /* opaque base */ }
  const blocked = new Set();
  for (const ref of refs) {
    let url;
    try {
      url = new URL(ref.trim(), base);
    } catch {
      continue; // not a URL a browser could fetch either
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (origin && origin !== 'null' && url.origin === origin) continue;
    if (exact.has(url.href) || exact.has(ref.trim())) continue;
    if (prefixes.some((prefix) => url.href.startsWith(prefix))) continue;
    blocked.add(url.host || url.href);
  }
  const hosts = [...blocked];
  return { ok: hosts.length === 0 && imports === 0, blocked: hosts, imports };
}

/// The CSS exactly as it will be injected, or null with the reason when the
/// policy refuses it. One place, so the pane's banner and the injector can
/// never disagree about whether a theme is on.
export function preparedThemeCss(theme, opts) {
  if (!theme || typeof theme.css !== 'string') return { css: null, policy: null };
  const rewritten = rewriteAssetUrls(theme.css, theme.assets || {});
  const policy = checkThemeUrls(rewritten, theme.assets || {}, opts);
  return { css: policy.ok ? rewritten : null, policy };
}

/// The installed theme for an id, only when it is actually wearable: on this
/// device and allowed by the policy.
export function usableTheme(id, storageImpl = storage) {
  const theme = id ? installedTheme(id, storageImpl) : null;
  if (!theme) return null;
  return preparedThemeCss(theme).css ? theme : null;
}

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

/// Returns the policy verdict: a theme the policy refuses is not injected at
/// all (fail closed — half a theme with its tracking rule cut out is still a
/// theme someone wrote to track), and the pane says why.
export function applyMarketTheme(css, assets = {}) {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(STYLE_ID);
  const prepared = typeof css === 'string' && css.trim()
    ? preparedThemeCss({ css, assets })
    : { css: null, policy: null };
  if (!prepared.css) {
    el?.remove();
    return prepared.policy;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.append(el);
  }
  el.textContent = boostThemeCss(prepared.css);
  const mode = parseThemeMeta(css)?.mode;
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  return prepared.policy;
}

/// Reads the synced choice and applies whatever is on this device for it:
/// the boosted CSS with asset URLs resolved, plus the theme's string
/// overrides (cleared when the id is empty, the file is missing, or the
/// policy refused the CSS).
export function applyMarketThemeFromPrefs(id, storageImpl = storage) {
  const theme = id ? installedTheme(id, storageImpl) : null;
  const policy = applyMarketTheme(theme?.css ?? null, theme?.assets ?? {});
  setThemeStrings(policy?.ok ? (theme?.strings ?? null) : null);
  return policy;
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
  blocked: 'blocked',
};

/// Downloads a theme's CSS and stores it device-local. Never throws.
/// `onProgress` receives `{ received, total }` as the body streams in —
/// `total` is null when the server sent no Content-Length, and the cap is
/// enforced mid-stream, not just after. The deadline covers the WHOLE
/// download, stream included: a server that stalls mid-body aborts the
/// controller and the caller sees `unreachable` within `timeoutMs`, never a
/// bar frozen at its last percentage.
export async function downloadTheme({
  id,
  cssUrl,
  assets = {},
  strings = {},
  onProgress = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_THEME_BYTES,
} = {}, storageImpl = storage) {
  const controller = new AbortController();
  // One deadline for everything — connect, headers, and every stream chunk.
  // Enforced two ways: the abort signal for fetches that honor it, and a
  // wall-clock check per chunk for fakes/servers that ignore it. Either path
  // lands in `unreachable` within `timeoutMs`; neither leaves a bar frozen.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = Date.now() + timeoutMs;
  try {
    const response = await Promise.resolve()
      .then(() => fetchImpl(cssUrl, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }))
      .catch(() => null);
    if (!response || !response.ok) return { error: THEME_ERRORS.unreachable };

    let css;
    const reader = response.body && typeof response.body.getReader === 'function'
      ? response.body.getReader()
      : null;
    if (reader) {
      let total = null;
      try {
        const declared = Number(response.headers?.get?.('content-length'));
        // Content-Length counts the bytes on the wire. jsDelivr and GitHub
        // serve CSS brotli/gzip-compressed, while the reader yields decoded
        // bytes — a 3.6 kB header for a 70 kB file would pin the bar at 100%
        // after one chunk. When the encoding is visible (jsDelivr exposes
        // all headers) a compressed length is ignored outright; when it is
        // not, overrunning the length below drops the bar to the pulse.
        const encoding = String(response.headers?.get?.('content-encoding') || '').trim().toLowerCase();
        const compressed = encoding && encoding !== 'identity';
        if (!compressed && Number.isFinite(declared) && declared > 0) total = declared;
      } catch { /* fakes without headers still stream fine */ }
      let received = 0;
      const chunks = [];
      for (;;) {
        // A stalled `read()` rejects with the abort; one that never resolves
        // at all is raced off the same deadline, so no chunk wait can outlive
        // the download's budget.
        const over = new Promise((resolve) => setTimeout(() => resolve('over'), Math.max(1, deadline - Date.now())));
        const raced = await Promise.race([reader.read(), over]);
        if (raced === 'over' || Date.now() > deadline) {
          controller.abort();
          return { error: THEME_ERRORS.unreachable };
        }
        const { done, value } = raced;
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          controller.abort();
          return { error: THEME_ERRORS.tooLarge };
        }
        chunks.push(value);
        if (total !== null && received > total) total = null;
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

    if (!parseThemeMeta(css)) return { error: THEME_ERRORS.noMeta };
    const policy = checkThemeUrls(rewriteAssetUrls(css, parseAssets(assets)), parseAssets(assets));
    if (!policy.ok) return { error: THEME_ERRORS.blocked, blocked: policy.blocked, imports: policy.imports };
    const installed = installTheme(id, css, storageImpl, { assets, strings });
    if (installed === false) return { error: THEME_ERRORS.quota };
    if (!installed) return { error: THEME_ERRORS.noMeta };
    return { theme: installed };
  } catch {
    // An aborted signal lands here — reported like any other unreachable.
    return { error: THEME_ERRORS.unreachable };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- local themes

/// Themes that never went through the catalog: imported from a `.theme.css`
/// a friend sent, pasted, or written in the editor. They live in the same
/// installed row as catalog themes (so applying, the ghost banner and the
/// palette lock all work unchanged) under an id the catalog can never use —
/// catalog ids are `[a-z0-9-]` slugs, so nothing ever overwrites a `local:`.
export const LOCAL_PREFIX = 'local:';

export function isLocalThemeId(id) {
  return typeof id === 'string' && id.startsWith(LOCAL_PREFIX) && id.length > LOCAL_PREFIX.length;
}

function slugify(name) {
  return String(name || 'theme').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'theme';
}

export function themeFileName(meta) {
  return `${slugify(meta?.name)}.theme.css`;
}

/// A starter for "New theme": the header the format requires and the
/// variables worth knowing about, so a blank editor is never the first step.
export const STARTER_THEME = `/**
 * @name My theme
 * @author me
 * @description A theme I made in Telium.
 * @version 1.0.0
 * @mode dark
 */
:root {
  --background: oklch(18% 0.02 260);
  --accent: oklch(72% 0.15 250);
  /* Fonts: ship your own with @font-face (a data: URL works for a theme
     you share as one file), then point the app at it. */
  --font-sans: system-ui, sans-serif;
}
`;

/// A local theme's id lives in its own header as `@localId`, so it travels
/// with the file. `prefs.marketTheme` syncs across devices: if importing the
/// same file on a second device minted a fresh id, applying it there would
/// sync that id back and knock the first device's theme off, and the two
/// would take turns forever. With the id in the file, every device that
/// imports it agrees, and re-importing an updated file replaces it in place.
const LOCAL_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

function withLocalId(css, localId) {
  return css.replace(/(\/\*\*[\s\S]*?)([ \t]*\*\/)/, (whole, head, close) => {
    const cleaned = head.replace(/\r?\n[ \t]*\*?[ \t]*@localId\b[^\r\n]*/g, '');
    return `${cleaned.replace(/[ \t]*$/, '')}${cleaned.endsWith('\n') ? '' : '\n'} * @localId ${localId}\n ${close.trimStart()}`;
  });
}

/// Validates and stores a local theme. Never throws. `id` re-saves an
/// existing local theme in place (the editor's Save); otherwise the file's
/// own `@localId` is used, or a new one is minted and written into the
/// header. Returns `{ theme }` or `{ error, blocked? }`.
export function saveLocalTheme(css, { id = null, strings = null, freshId = false } = {}, storageImpl = storage) {
  if (typeof css !== 'string' || !css.trim()) return { error: THEME_ERRORS.noMeta };
  if (new TextEncoder().encode(css).byteLength > MAX_THEME_BYTES) return { error: THEME_ERRORS.tooLarge };
  const meta = parseThemeMeta(css);
  if (!meta) return { error: THEME_ERRORS.noMeta };
  const policy = checkThemeUrls(css);
  if (!policy.ok) return { error: THEME_ERRORS.blocked, blocked: policy.blocked, imports: policy.imports };
  const fromFile = !freshId && LOCAL_ID.test(meta.localId || '') ? meta.localId : null;
  const localId = isLocalThemeId(id)
    ? id.slice(LOCAL_PREFIX.length)
    : fromFile || `${slugify(meta.name)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const themeId = `${LOCAL_PREFIX}${localId}`;
  const stamped = withLocalId(css, localId);
  // Re-saving keeps the theme's rewording (a copy of a catalog theme carries
  // its strings.json over); a file carries none of its own.
  const keep = strings ?? installedTheme(themeId, storageImpl)?.strings ?? {};
  const installed = installTheme(themeId, stamped, storageImpl, { source: 'local', strings: keep });
  if (installed === false) return { error: THEME_ERRORS.quota };
  if (!installed) return { error: THEME_ERRORS.noMeta };
  return { theme: installed };
}

export async function importLocalThemeFile(file, storageImpl = storage) {
  if (!file || typeof file.text !== 'function') return { error: THEME_ERRORS.invalid };
  if (Number(file.size) > MAX_THEME_BYTES) return { error: THEME_ERRORS.tooLarge };
  let css;
  try {
    css = await file.text();
  } catch {
    return { error: THEME_ERRORS.invalid };
  }
  return saveLocalTheme(css, {}, storageImpl);
}

/// Local themes, newest first, as `{ id, meta, css }`.
export function localThemes(storageImpl = storage) {
  const { installed } = readInstalled(storageImpl);
  return Object.entries(installed)
    .filter(([id, theme]) => isLocalThemeId(id) && theme && typeof theme.css === 'string')
    .sort((a, b) => (b[1].installedAt || 0) - (a[1].installedAt || 0))
    .map(([id, theme]) => ({ id, meta: theme.meta, css: theme.css }));
}

/// One self-contained `.theme.css` for any installed theme: catalog asset
/// filenames become their absolute catalog URLs (allowed by the policy), so
/// the file works on its own once imported elsewhere.
export function exportThemeCss(id, storageImpl = storage) {
  const theme = installedTheme(id, storageImpl);
  if (!theme) return null;
  return rewriteAssetUrls(theme.css, theme.assets || {});
}

/// "Edit a copy": a catalog theme becomes a local one the editor can change,
/// renamed in its header so the two are never confused on the cards.
export function copyThemeForEditing(id, suffix = '(edited)', storageImpl = storage) {
  const css = exportThemeCss(id, storageImpl);
  if (!css) return { error: THEME_ERRORS.invalid };
  const renamed = css.replace(/(\/\*\*[\s\S]*?@name[ \t]+)([^\r\n]+?)([ \t]*\r?\n)/, (whole, head, name, tail) => (
    name.endsWith(suffix) ? whole : `${head}${name} ${suffix}${tail}`
  ));
  const strings = installedTheme(id, storageImpl)?.strings || {};
  return saveLocalTheme(renamed, { strings, freshId: true }, storageImpl);
}

// ------------------------------------------------------------------ formatting

export function formatDownloads(count) {
  const n = Number(count) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}
