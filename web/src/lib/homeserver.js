// Turns typed text into a base URL. A missing scheme would make `fetch` treat the address as a relative path on whichever server served the client.

export const prettyHost = (value) => String(value ?? '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/+$/, '');

/// Loopback and `.localhost` names run plain http in development; promoting them to https fails the TLS handshake.
const isLoopback = (host) => host === 'localhost'
  || host === '127.0.0.1'
  || host === '[::1]'
  || host === '::1'
  || host.endsWith('.localhost');

/// An input that already carries a scheme keeps it unexamined. Empty string if not an address, so callers hit their usual error.
export function normalizeHomeserver(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  // Only `://` counts as a scheme: `localhost:8448` would otherwise parse as scheme `localhost:`.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const bareHost = text.split(/[/?#]/, 1)[0].replace(/:\d*$/, '').toLowerCase();
  const candidate = hasScheme
    ? text
    : `${isLoopback(bareHost) ? 'http' : 'https'}://${text}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (!url.hostname) return '';
  // Refusing credentials also keeps `mailto:someone@example.org` from being read as host `example.org`.
  if (url.username || url.password) return '';

  // Rebuilt from parts so trailing slash, query and capitalisation all arrive as the same server.
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/// Drops the scheme only when putting it back yields the same address, so a plain-http server keeps its prefix.
export function displayHomeserver(value) {
  const bare = prettyHost(value);
  return normalizeHomeserver(bare) === normalizeHomeserver(value) ? bare : String(value ?? '').trim();
}

/// Whether this page is the portal: the same client build, served by the official site rather
/// than by a homeserver. The merge that puts the client on the site stamps the marker into the
/// shell, so the invite screen knows that a code with no `@server` behind it names nothing —
/// on a homeserver's own copy, the page origin is the server.
export function isPortalHost() {
  try {
    return document.querySelector('meta[name="telium-portal"]')?.content === '1';
  } catch {
    return false;
  }
}
