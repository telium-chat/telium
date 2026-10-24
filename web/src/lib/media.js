// Profile assets are owned by the user's home server; a foreign object is fetched through the guild host's cache.

import { domainOf } from './util.js';

export function remoteMediaOrigin(userId, localDomain) {
  const origin = domainOf(userId);
  return origin && origin !== localDomain ? origin : null;
}

export function mediaUrl(base, mediaRef, origin = null) {
  if (!base || !mediaRef) return null;

  // Escape the hash on both branches: a foreign `avatar_ref` could close the CSS `url("...")` it is rendered into. The query is split off first so `?cap=` stays URL syntax.
  const [hash, query] = String(mediaRef).split('?', 2);
  const suffix = query ? `?${query}` : '';
  if (!origin) return `${base}/_telium/v1/media/${encodeURIComponent(hash)}${suffix}`;

  return `${base}/_telium/v1/media/remote/${encodeURIComponent(origin)}/${encodeURIComponent(hash)}${suffix}`;
}
