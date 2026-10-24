// The changelog is display-only prose fetched over plain HTTPS and deliberately unsigned: the worst a hostile file can do is put wrong words in a dialog. Fetches are throttled and cached. The read marker is device-local; losing it costs a badge and a refetch.

import { storage } from './util.js';

export const CHANGELOG_URL = import.meta.env?.VITE_TELIUM_CHANGELOG_URL
  || 'https://raw.githubusercontent.com/telium-chat/telium/main/CHANGELOG.md';

// The rendered page, not the raw file.
export const CHANGELOG_PAGE = 'https://github.com/telium-chat/telium/blob/main/CHANGELOG.md';

const READ_KEY = 'telium.changelog.v1';

const REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 256 * 1024;

export const FETCH_ERRORS = { unreachable: 'unreachable', tooLarge: 'too_large' };

/// Never throws: returns `{ text }` or `{ error }`.
export async function fetchChangelog({
  url = CHANGELOG_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_BYTES,
} = {}) {
  const controller = new AbortController();
  // The await races the timer too: a fetch that ignores the abort signal must not hold the rail open.
  const attempt = Promise.resolve()
    .then(() => fetchImpl(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }))
    .catch(() => null);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    clearTimeout(timer);
    clearTimeout(timeoutId);
  }
}

/// Contract: `## ` sections newest-first, `### ` sub-headings, `- ` bullets, blank-line-separated paragraphs. Content before the first `## ` is skipped. `latest` is the topmost heading. Null when nothing is readable.
export function parseChangelog(text) {
  if (!text || !text.trim()) return null;
  const sections = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), blocks: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('### ')) {
      current.blocks.push({ kind: 'subheading', text: line.slice(4).trim() });
    } else if (/^- /.test(line)) {
      current.blocks.push({ kind: 'bullet', text: line.slice(2) });
    } else if (line.trim() !== '') {
      current.blocks.push({ kind: 'para', text: line });
    }
  }
  if (!sections.length) return null;
  return { latest: sections[0].heading, sections };
}

function readRow(storageImpl = storage) {
  try {
    const row = storageImpl.get(READ_KEY, null);
    return row && typeof row === 'object' ? row : null;
  } catch {
    return null;
  }
}

function writeRow(storageImpl = storage, row) {
  try {
    storageImpl.set(READ_KEY, row);
  } catch {
    /* private browsing, full quota: the badge comes back next launch */
  }
}

/// Null when none or it no longer parses.
export function cachedChangelog(storageImpl = storage) {
  const row = readRow(storageImpl);
  if (!row || typeof row.text !== 'string') return null;
  return parseChangelog(row.text);
}

export function readMarker(storageImpl = storage) {
  const row = readRow(storageImpl);
  return row && typeof row.read === 'string' ? row.read : null;
}

export function cacheChangelog(text, storageImpl = storage) {
  writeRow(storageImpl, { read: readMarker(storageImpl), at: Date.now(), text });
}

export function markRead(latest, text, storageImpl = storage) {
  const row = readRow(storageImpl);
  writeRow(storageImpl, {
    read: latest,
    at: Date.now(),
    text: typeof text === 'string' ? text : row?.text,
  });
}

export function hasUnreadChangelog(cached, marker) {
  return Boolean(cached?.latest) && cached.latest !== marker;
}

export function cacheIsFresh(storageImpl = storage, ttlMs = REFRESH_TTL_MS) {
  const row = readRow(storageImpl);
  return Boolean(row?.at) && Date.now() - row.at < ttlMs;
}

let inflight = null;

/// Concurrent callers share one fetch.
export function refreshChangelog(deps = {}, storageImpl = storage) {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { text } = await fetchChangelog(deps);
      if (typeof text !== 'string') return null;
      const parsed = parseChangelog(text);
      if (!parsed) return null;
      cacheChangelog(text, storageImpl);
      return parsed;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function refreshChangelogIfStale(deps = {}, storageImpl = storage) {
  if (cacheIsFresh(storageImpl)) {
    return Promise.resolve(cachedChangelog(storageImpl));
  }
  return refreshChangelog(deps, storageImpl);
}
