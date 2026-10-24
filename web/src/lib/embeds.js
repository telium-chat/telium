// Raw-link unfurls fetched by the guild server so the member's IP never reaches the host. `readEmbed` normalizes the untrusted JSON; keep in step with `interactions.js`.

import { destinationOf } from './link-trust.js';
import { plainText } from './interactions.js';

const LINK = /https?:\/\/[^\s<>"']+/g;
// Trailing punctuation more likely belongs to the prose.
const TRAILING = /[)\]}>.,;:!?'"]+$/;
// A URL in code is being talked about, not referenced.
const CODE = /```[\s\S]*?```|`[^`]*`/g;

export const MAX_EMBEDS = 3;

export function linksIn(content) {
  const found = (content || '').replace(CODE, ' ').match(LINK) || [];
  const out = [];
  for (const raw of found) {
    const url = raw.replace(TRAILING, '');
    if (url && !out.includes(url)) out.push(url);
    if (out.length === MAX_EMBEDS) break;
  }
  return out;
}

/// `description` is 512; our scraper stops at 300 but federated servers may differ.
const EMBED_LIMITS = { title: 256, description: 512, hash: 128, type: 128 };

const EMBED_KINDS = new Set(['link', 'image', 'video']);

const MIME = /^[a-z0-9][a-z0-9!#$&^_+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}(?:\s*;\s*codecs\s*=\s*"[\w.,\s-]{1,120}")?$/i;

const PROXY_PATH = /^\/_telium\/v1\/(camo|media)\//;

/// An asset on the answering server's origin under a re-hosting path, else null; no placeholder, since the request itself leaks.
export function proxiedAsset(base, raw) {
  if (typeof raw !== 'string' || !raw || !base) return null;
  let origin;
  try { origin = new URL(String(base)).origin; } catch { return null; }
  const found = destinationOf(raw);
  if (!found) return null;
  let asset;
  try { asset = new URL(found.href); } catch { return null; }
  // Reject userinfo: it would reach the server as an Authorization header.
  if (asset.username || asset.password) return null;
  if (asset.origin !== origin) return null;
  return PROXY_PATH.test(asset.pathname) ? asset.href : null;
}

function size(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 16384 ? Math.round(n) : null;
}

/// `url` and `site` come from the link we found, not the server's echo, so the host line can't be spoofed.
export function readEmbed(raw, { base, url }) {
  if (!raw || typeof raw !== 'object' || raw.status !== 'ok') return null;
  const destination = destinationOf(url);
  if (!destination) return null;

  const video = proxiedAsset(base, raw.video);
  const type = plainText(raw.video_type, EMBED_LIMITS.type);
  return {
    status: 'ok',
    url: destination.href,
    site: destination.host,
    url_hash: plainText(raw.url_hash, EMBED_LIMITS.hash),
    kind: EMBED_KINDS.has(raw.kind) ? raw.kind : 'link',
    title: plainText(raw.title, EMBED_LIMITS.title),
    description: plainText(raw.description, EMBED_LIMITS.description, { multiline: true }),
    image: proxiedAsset(base, raw.image),
    video,
    video_type: video && MIME.test(type) ? type : null,
    video_width: size(raw.video_width),
    video_height: size(raw.video_height),
  };
}

// Keyed by server and url; the separator is an escape, not a raw NUL.
const pending = new Map();

/// Null TTLs: refusals and unanswered requests must not pin forever (rich presence shares this map).
const REFUSAL_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 15 * 1000;

/// Keys can be stranger-chosen; evicts least recently used.
const EMBED_CACHE_MAX = 512;

export function embedFor(api, url) {
  if (!api) return Promise.resolve(null);
  const key = `${api.base}\0${url}`;

  // `until` is Infinity while in flight, so concurrent rows share one request.
  const held = pending.get(key);
  if (held && (held.until === Infinity || held.until > Date.now())) return held.promise;

  const entry = { promise: null, until: Infinity };
  entry.promise = api.embed(url).then(
    (e) => {
      const card = readEmbed(e, { base: api.base, url });
      entry.until = card ? Infinity : Date.now() + REFUSAL_TTL_MS;
      return card;
    },
    () => {
      entry.until = Date.now() + FAILURE_TTL_MS;
      return null;
    },
  );

  // Delete first so a refreshed entry moves to the back of the eviction order.
  pending.delete(key);
  pending.set(key, entry);
  while (pending.size > EMBED_CACHE_MAX) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
  return entry.promise;
}

export function forgetEmbeds() { pending.clear(); }
