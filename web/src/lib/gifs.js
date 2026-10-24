// GIF provider adapter. Providers are contacted by the browser; Telium never downloads or proxies the media.

import { KEYS, MAX_GIF_FAVORITES } from './sync.js';

export const BUNDLED_KLIPY_API_KEY = import.meta.env.VITE_KLIPY_API_KEY || '';
export const DEFAULT_KLIPY_BASE_URL = 'https://api.klipy.com/api/v1';
export const DEFAULT_KLIPY_MEDIA_HOSTS = [
  'klipy.com',
  'static.klipy.com',
  'static.klipy.co',
  'media.klipy.com',
  'media.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'i.giphy.com',
  'images.giphy.com',
  'media.tenor.com',
  'media1.tenor.com',
  'media.tenor.co',
  'media1.tenor.co',
  'c.tenor.com',
];
// Tenor's public web key, not a secret; VITE_TENOR_API_KEY can replace it.
export const BUNDLED_TENOR_API_KEY = import.meta.env.VITE_TENOR_API_KEY
  || 'AIzaSyCZt6SSh5VgVPzD9fhyzG1DprdPRhtoaR4';
export const BUNDLED_TENOR_CLIENT_KEY = import.meta.env.VITE_TENOR_CLIENT_KEY || 'tenor_web';
export const DEFAULT_TENOR_API_BASE_URL = 'https://tenor.googleapis.com/v2';
export { MAX_GIF_FAVORITES };

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[)\]}>.,;:!?'"]+$/;

function cleanUrl(raw) {
  return String(raw || '').replace(TRAILING, '');
}

/// An explicit disabled value is never replaced by the bundled fallback.
export function klipyConfig(storeOrDocument = null) {
  const document = storeOrDocument?.gif_provider
    || storeOrDocument?.caps?.get?.(storeOrDocument?.session?.home?.domain)
    ?.gif_provider
    || {};
  const enabled = document.enabled !== false;
  const mediaHosts = [...new Set([
    ...DEFAULT_KLIPY_MEDIA_HOSTS,
    ...(Array.isArray(document.media_hosts) ? document.media_hosts : []),
  ].map((host) => String(host).toLowerCase().trim()).filter(Boolean))];
  return {
    enabled,
    provider: document.provider || 'klipy',
    apiKey: document.api_key || document.apiKey || BUNDLED_KLIPY_API_KEY,
    apiBaseUrl: (document.api_base_url || document.apiBaseUrl || DEFAULT_KLIPY_BASE_URL).replace(/\/+$/, ''),
    mediaHosts,
  };
}

export function normalizeGifUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/// Share pages are HTML; keep the slug so the browser can resolve it through Klipy's API.
export function klipyShareSlug(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'klipy.com') return null;
    const match = url.pathname.match(/^\/gifs?\/([^/]+)\/?$/i);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function isKlipyShareUrl(value) {
  return Boolean(klipyShareSlug(value));
}

/// The id at the end of the path lets the browser ask Tenor for the media URL.
export function tenorPostId(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || !/^(?:www\.)?tenor\.com$/i.test(url.hostname)) return null;
    const path = decodeURIComponent(url.pathname);
    const match = path.match(/(?:^|-)gif-(\d+)\/?$/i) || path.match(/\/(\d+)\/?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function isTenorShareUrl(value) {
  return Boolean(tenorPostId(value));
}

/// The id at the end of the slug maps to a stable public media URL.
export function giphyGifId(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || !/^(?:www\.)?giphy\.com$/i.test(url.hostname)) return null;
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    const segments = path.split('/').filter(Boolean);
    if (segments.length !== 2 || segments[0].toLowerCase() !== 'gifs') return null;
    const slug = segments[1];
    const suffix = slug.match(/-([A-Za-z0-9]+)$/)?.[1];
    if (suffix) return suffix;
    return /^[A-Za-z0-9]+$/.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

export function isGiphyShareUrl(value) {
  return Boolean(giphyGifId(value));
}

export function giphyMediaUrl(id) {
  return `https://media.giphy.com/media/${encodeURIComponent(id)}/giphy.gif`;
}

export function tenorConfig(storeOrDocument = null) {
  const document = storeOrDocument?.tenor_provider
    || storeOrDocument?.caps?.get?.(storeOrDocument?.session?.home?.domain)
    ?.tenor_provider
    || {};
  return {
    enabled: document.enabled !== false,
    apiKey: document.api_key || document.apiKey || BUNDLED_TENOR_API_KEY,
    clientKey: document.client_key || document.clientKey || BUNDLED_TENOR_CLIENT_KEY,
    apiBaseUrl: (document.api_base_url || document.apiBaseUrl || DEFAULT_TENOR_API_BASE_URL).replace(/\/+$/, ''),
  };
}

function hostMatches(host, allowed) {
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function isTeliumMediaUrl(value) {
  try {
    const url = typeof value === 'string' ? new URL(value.trim()) : value;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return /^\/_telium\/v1\/media\/(?!external\/)[^/]+/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isLikelyGifUrl(value, config = {}) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (isKlipyShareUrl(url.href) || isTenorShareUrl(url.href) || isGiphyShareUrl(url.href)) return true;
  if (/\.gif(?:$|[?#])/i.test(url.pathname + url.search + url.hash)) return true;
  if (isTeliumMediaUrl(url)) return true;
  const hosts = config.mediaHosts || DEFAULT_KLIPY_MEDIA_HOSTS;
  return hostMatches(url.hostname.toLowerCase(), hosts.map((host) => String(host).toLowerCase()));
}

export function gifUrlsIn(content, config = {}) {
  const out = [];
  for (const raw of String(content || '').match(URL_RE) || []) {
    const url = normalizeGifUrl(cleanUrl(raw));
    if (url && isLikelyGifUrl(url, config) && !out.includes(url)) out.push(url);
  }
  return out;
}

export function isGifOnlyContent(content, config = {}) {
  const text = String(content || '').trim();
  const urls = gifUrlsIn(text, config);
  return urls.length === 1 && urls[0] === text;
}

export function gifFavorites(sync) {
  const values = sync?.get?.(KEYS.gifFavorites) || [];
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const url = normalizeGifUrl(value);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= MAX_GIF_FAVORITES) break;
  }
  return out;
}

/// GIF dimensions by URL; favourites are bare URLs, so this outlives the picker. Insertion-ordered and bounded; reads re-insert.
const GIF_SIZE_LIMIT = 1000;
const gifSizes = new Map();

export function gifSizeOf(url) {
  const known = url ? gifSizes.get(url) : undefined;
  if (!known) return null;
  gifSizes.delete(url);
  gifSizes.set(url, known);
  return known;
}

/// True when the dimensions were news, so a decoded image relayouts once per GIF, not per frame.
export function noteGifSize(url, width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!url || !(w > 0) || !(h > 0)) return false;
  const previous = gifSizes.get(url);
  if (previous && previous.width === w && previous.height === h) return false;
  gifSizes.delete(url);
  gifSizes.set(url, { width: w, height: h });
  if (gifSizes.size > GIF_SIZE_LIMIT) gifSizes.delete(gifSizes.keys().next().value);
  return true;
}

export function removeGifFavorite(store, value) {
  const url = normalizeGifUrl(value);
  if (!store?.sync) return [];
  const current = gifFavorites(store.sync);
  const next = url ? current.filter((entry) => entry !== url) : current;
  // Emit even when already removed: a stale Favorites tile must reconcile rather than turn removal into an add.
  store.sync.set(KEYS.gifFavorites, next);
  store.emit?.('gif-favorites');
  return next;
}

export function toggleGifFavorite(store, value) {
  const url = normalizeGifUrl(value);
  if (!url || !store?.sync) return gifFavorites(store?.sync);
  const current = gifFavorites(store.sync);
  const next = current.includes(url)
    ? current.filter((entry) => entry !== url)
    : [url, ...current].slice(0, MAX_GIF_FAVORITES);
  store.sync.set(KEYS.gifFavorites, next);
  store.emit?.('gif-favorites');
  return next;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function abortError() {
  const error = new Error('The request was aborted.');
  error.name = 'AbortError';
  return error;
}

function mediaUrl(item) {
  return first(
    item?.file?.md?.gif?.url,
    item?.file?.hd?.gif?.url,
    item?.file?.sm?.gif?.url,
    item?.media_formats?.gif?.url,
    item?.images?.original?.url,
    item?.images?.fixed_width?.url,
    item?.gif?.url,
    item?.url,
    item?.image_url,
  );
}

function previewUrl(item, url) {
  return first(
    item?.file?.sm?.gif?.url,
    item?.file?.md?.gif?.url,
    item?.media_formats?.tinygif?.url,
    item?.images?.fixed_width_small?.url,
    item?.images?.fixed_width?.url,
    url,
  );
}

export function normalizeKlipyResult(item, index = 0) {
  if (!item || typeof item !== 'object') return null;
  const url = normalizeGifUrl(mediaUrl(item));
  if (!url) return null;
  const width = Number(first(
    item?.file?.hd?.gif?.width,
    item?.file?.md?.gif?.width,
    item?.width,
  )) || null;
  const height = Number(first(
    item?.file?.hd?.gif?.height,
    item?.file?.md?.gif?.height,
    item?.height,
  )) || null;
  return {
    id: String(first(item.id, item.slug, item.title, url, index)),
    slug: first(item.slug, item.slug_text, null),
    url,
    previewUrl: normalizeGifUrl(previewUrl(item, url)) || url,
    title: String(first(item.title, item.name, item.caption, 'GIF')),
    width,
    height,
    provider: 'klipy',
  };
}

function tenorMediaUrl(item) {
  return first(
    item?.media_formats?.mediumgif?.url,
    item?.media_formats?.gif?.url,
    item?.media_formats?.tinygif?.url,
    item?.media_formats?.nanogif?.url,
  );
}

export function normalizeTenorResult(item) {
  if (!item || typeof item !== 'object') return null;
  const url = normalizeGifUrl(tenorMediaUrl(item));
  if (!url) return null;
  const previewUrl = normalizeGifUrl(first(
    item?.media_formats?.tinygif?.url,
    item?.media_formats?.nanogif?.url,
    item?.media_formats?.gifpreview?.url,
    url,
  )) || url;
  return {
    id: String(first(item.id, url)),
    url,
    previewUrl,
    title: String(first(item.title, item.content_description, 'GIF')),
    width: Number(first(
      item?.media_formats?.mediumgif?.dims?.[0],
      item?.media_formats?.gif?.dims?.[0],
    )) || null,
    height: Number(first(
      item?.media_formats?.mediumgif?.dims?.[1],
      item?.media_formats?.gif?.dims?.[1],
    )) || null,
    provider: 'tenor',
  };
}

function resultArray(payload) {
  const candidates = [
    payload?.data?.data,
    payload?.data,
    payload?.results,
    payload?.gifs,
  ];
  return candidates.find(Array.isArray) || [];
}

function nextPageOf(payload, page, count, perPage) {
  const explicit = first(
    payload?.meta?.next_page,
    payload?.meta?.nextPage,
    payload?.pagination?.next_page,
    payload?.pagination?.nextPage,
  );
  if (explicit === false || explicit === null) return null;
  if (explicit !== undefined) return Number(explicit) || null;
  return count >= perPage ? page + 1 : null;
}

export class KlipyProviderError extends Error {
  constructor(message, code = 'klipy_error') {
    super(message);
    this.name = 'KlipyProviderError';
    this.code = code;
  }
}

/// (query, page) answers remembered per provider.
const CACHE_LIMIT = 48;

export class KlipyProvider {
  /// `debounceMs` is zero; debounce belongs at the keystroke.
  constructor(config, { fetcher = null, debounceMs = 0 } = {}) {
    this.config = config || {};
    // `window.fetch` must be called on its owning object.
    this.fetcher = fetcher || ((...args) => globalThis.fetch(...args));
    this.debounceMs = debounceMs;
    this.controllers = new Map();
    this.timers = new Map();
    // Per instance, so tests don't leak answers; `gifProviderFor` returns the same instance.
    this.cache = new Map();
  }

  /// Oldest evicted first; `list` re-inserts on read.
  remember(key, value) {
    this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > CACHE_LIMIT) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  cancel(kind = null) {
    const keys = kind ? [kind] : [...this.controllers.keys()];
    for (const key of keys) {
      this.controllers.get(key)?.abort();
      this.controllers.delete(key);
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  async list({ query = '', page = 1, perPage = 24, signal, requestKey = null } = {}) {
    if (!this.config.enabled) throw new KlipyProviderError('GIF search is disabled by this server.', 'disabled');
    if (!this.config.apiKey) throw new KlipyProviderError('GIF search is not configured yet.', 'unconfigured');
    if (typeof this.fetcher !== 'function') throw new KlipyProviderError('GIF search is unavailable in this browser.');

    const mode = query.trim() ? 'search' : 'trending';
    const kind = requestKey || mode;
    this.cancel(kind);
    // Answered from memory before a controller exists, so a keystroke can't abort it.
    const cacheKey = `${mode} ${query.trim()} ${page} ${perPage}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.remember(cacheKey, cached);
      return cached;
    }
    const controller = new AbortController();
    this.controllers.set(kind, controller);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      if (controller.signal.aborted) throw abortError();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.debounceMs);
        this.timers.set(kind, timer);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(abortError());
        }, { once: true });
      });
      if (controller.signal.aborted) throw abortError();
      const endpoint = `${this.config.apiBaseUrl}/${encodeURIComponent(this.config.apiKey)}/gifs/${mode}`;
      const params = new URLSearchParams({ page: String(page), limit: String(perPage), per_page: String(perPage) });
      if (mode === 'search') params.set('q', query.trim());
      const response = await this.fetcher(`${endpoint}?${params}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response?.ok) throw new KlipyProviderError(`Klipy returned HTTP ${response?.status || 0}.`, 'http_error');
      const payload = await response.json();
      const raw = resultArray(payload);
      const items = raw.map(normalizeKlipyResult).filter(Boolean);
      const result = { items, page, nextPage: nextPageOf(payload, page, items.length, perPage) };
      this.remember(cacheKey, result);
      return result;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (this.controllers.get(kind) === controller) this.controllers.delete(kind);
      this.timers.delete(kind);
    }
  }

  trending(options = {}) { return this.list({ ...options, query: '' }); }
  search(query, options = {}) { return this.list({ ...options, query }); }

  async resolveShareUrl(value, { signal } = {}) {
    const slug = klipyShareSlug(value);
    if (!slug) return null;
    const result = await this.list({
      query: slug,
      page: 1,
      perPage: 24,
      signal,
      requestKey: `resolve:${slug}`,
    });
    const wanted = slug.toLowerCase();
    return result.items.find((item) => {
      const candidate = item.slug?.toLowerCase();
      return candidate === wanted || candidate?.startsWith(`${wanted}--`);
    })?.url || null;
  }
}

/// One provider per configuration for the tab's lifetime, so the cache survives the popover closing.
const providers = new Map();

export function gifProviderFor(config) {
  const key = `${config?.enabled ? '1' : '0'} ${config?.apiKey || ''} ${config?.apiBaseUrl || ''}`;
  let provider = providers.get(key);
  if (!provider) {
    provider = new KlipyProvider(config);
    providers.set(key, provider);
  }
  return provider;
}

export class TenorProviderError extends Error {
  constructor(message, code = 'tenor_error') {
    super(message);
    this.name = 'TenorProviderError';
    this.code = code;
  }
}

export class TenorProvider {
  constructor(config, { fetcher = null } = {}) {
    this.config = config || {};
    this.fetcher = fetcher || ((...args) => globalThis.fetch(...args));
    this.controllers = new Map();
  }

  cancel() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  async resolveShareUrl(value, { signal } = {}) {
    const id = tenorPostId(value);
    if (!id) return null;
    if (!this.config.enabled) throw new TenorProviderError('Tenor GIF resolution is disabled.', 'disabled');
    if (!this.config.apiKey) throw new TenorProviderError('Tenor GIF resolution is not configured.', 'unconfigured');
    if (typeof this.fetcher !== 'function') throw new TenorProviderError('Tenor GIF resolution is unavailable in this browser.');

    const controller = new AbortController();
    const key = id;
    this.controllers.get(key)?.abort();
    this.controllers.set(key, controller);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      if (controller.signal.aborted) throw abortError();
      const endpoint = `${this.config.apiBaseUrl}/posts`;
      const params = new URLSearchParams({
        ids: id,
        key: this.config.apiKey,
        client_key: this.config.clientKey,
        media_filter: 'gif,mediumgif,tinygif,nanogif',
      });
      const response = await this.fetcher(`${endpoint}?${params}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response?.ok) throw new TenorProviderError(`Tenor returned HTTP ${response?.status || 0}.`, 'http_error');
      const payload = await response.json();
      // Older Tenor share URLs carry the legacy post id under `legacy_info.post_id`, not `result.id`.
      const item = payload?.results?.find((result) => (
        String(result?.id) === id || String(result?.legacy_info?.post_id) === id
      ));
      return normalizeTenorResult(item)?.url || null;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
    }
  }
}

export class GiphyProvider {
  async resolveShareUrl(value) {
    const id = giphyGifId(value);
    return id ? giphyMediaUrl(id) : null;
  }
}
