// A link card must never become an iframe; a watch session may, for a listed service, because it names its host before loading.
// The list is the security boundary: operators can narrow it, never widen it.

const PROVIDERS = [
  {
    id: 'youtube',
    name: 'YouTube',
    embedHost: 'www.youtube-nocookie.com',
    origins: ['https://www.youtube-nocookie.com'],
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'],
    parse: parseYouTube,
    embed: youTubeEmbed,
    kind: 'iframe',
    protocol: 'youtube',
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    embedHost: 'player.vimeo.com',
    origins: ['https://player.vimeo.com'],
    hosts: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
    parse: parseVimeo,
    embed: vimeoEmbed,
    kind: 'iframe',
    protocol: 'vimeo',
  },
  {
    id: 'file',
    name: 'Direct video file',
    embedHost: null,
    origins: [],
    hosts: null,
    parse: parseFile,
    embed: (source) => source.url,
    kind: 'file',
    protocol: 'file',
  },
];

export const WATCH_PROVIDERS = PROVIDERS.map(
  ({ id, name, embedHost, kind }) => ({ id, name, embedHost, kind }),
);

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/// `.m3u8` is best effort: HLS plays natively only on Safari.
const FILE_EXTENSIONS = ['.mp4', '.m4v', '.webm', '.ogv', '.ogg', '.mov', '.m3u8'];

/// The result carries provider, id and start offset, not the original URL, so a crafted URL carries nothing into the frame.
export function sourceFor(raw, { allowed = null } = {}) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  for (const provider of PROVIDERS) {
    if (provider.hosts && !provider.hosts.includes(host)) continue;
    if (allowed && !allowed.includes(provider.id)) continue;
    const parsed = provider.parse(url);
    if (parsed) return { provider: provider.id, ...parsed };
  }
  return null;
}

export function hostOf(source) {
  const provider = source && providerById(source.provider);
  if (!provider) return null;
  if (provider.embedHost) return provider.embedHost;
  try { return new URL(source.url).hostname.toLowerCase(); } catch { return null; }
}

export function embedUrl(source) {
  const provider = source && providerById(source.provider);
  return provider ? provider.embed(source) : null;
}

export function trustsOrigin(source, origin) {
  const provider = source && providerById(source.provider);
  if (!provider) return false;
  if (provider.origins.length) return provider.origins.includes(origin);
  return false;
}

/// Silence means everything built in; a list means exactly those; `enabled = false` means none.
export function narrow(registry) {
  const policy = registry?.watch_together;
  if (!policy) return WATCH_PROVIDERS.map((p) => p.id);
  if (policy.enabled === false) return [];
  const listed = Array.isArray(policy.providers) ? policy.providers : null;
  if (!listed || !listed.length) return WATCH_PROVIDERS.map((p) => p.id);
  return WATCH_PROVIDERS.map((p) => p.id).filter((id) => listed.includes(id));
}

/// Empty on a packaged desktop build: its `file://` origin never completes the player handshake.
function drivingOrigin() {
  if (typeof window === 'undefined') return '';
  const origin = window.location.origin;
  return /^https?:\/\//.test(origin) ? origin : '';
}

/// A YouTube video id contains no `/` or `?`, so interpolating one into a URL is safe.
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function parseYouTube(url) {
  const path = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (url.hostname.toLowerCase() === 'youtu.be') id = path[0];
  else if (path[0] === 'watch') id = url.searchParams.get('v');
  else if (['embed', 'shorts', 'live', 'v'].includes(path[0])) id = path[1];
  if (!id || !YOUTUBE_ID.test(id)) return null;
  return { id, start: startSeconds(url.searchParams.get('t') || url.searchParams.get('start')) };
}

function youTubeEmbed(source) {
  // Checked here too: a note off the wire reaches this by a second path (`protocol.js`).
  if (!YOUTUBE_ID.test(String(source.id || ''))) return null;
  const params = new URLSearchParams({
    enablejsapi: '1',
    // YouTube refuses commands whose posting window does not match.
    origin: drivingOrigin(),
    rel: '0',
    modestbranding: '1',
    playsinline: '1',
    // The room decides when it starts, so the frame must not.
    autoplay: '0',
    controls: '0',
    disablekb: '1',
  });
  if (source.start) params.set('start', String(source.start));
  return `https://www.youtube-nocookie.com/embed/${source.id}?${params}`;
}

const VIMEO_ID = /^[0-9]{6,12}$/;
const VIMEO_HASH = /^[A-Za-z0-9]{6,20}$/;

function parseVimeo(url) {
  const path = url.pathname.split('/').filter(Boolean);
  const at = path[0] === 'video' ? 1 : 0;
  const id = path[at];
  if (!id || !VIMEO_ID.test(id)) return null;
  const hash = path[at + 1] && VIMEO_HASH.test(path[at + 1]) ? path[at + 1] : url.searchParams.get('h');
  return {
    id,
    hash: hash && VIMEO_HASH.test(hash) ? hash : null,
    start: startSeconds((url.hash || '').replace(/^#/, '')),
  };
}

function vimeoEmbed(source) {
  if (!VIMEO_ID.test(String(source.id || ''))) return null;
  const params = new URLSearchParams({ dnt: '1', autoplay: '0', controls: '0', playsinline: '1' });
  if (source.hash && VIMEO_HASH.test(source.hash)) params.set('h', source.hash);
  if (source.start) params.set('t', `${source.start}s`);
  return `https://player.vimeo.com/video/${source.id}?${params}`;
}

function parseFile(url) {
  const path = url.pathname.toLowerCase();
  if (!FILE_EXTENSIONS.some((ext) => path.endsWith(ext))) return null;
  return { url: url.href, hls: path.endsWith('.m3u8') };
}

function startSeconds(raw) {
  const text = String(raw || '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!parts || !parts.slice(1).some(Boolean)) return 0;
  return Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0);
}
