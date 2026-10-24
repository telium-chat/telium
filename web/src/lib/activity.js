export const RICH_ACTIVITY_PREFIX = 'telium-rich-v1:';

const MAX_TEXT = 128;
const MAX_APP_ID = 64;
const MAX_URL = 1024;
const MAX_ARTWORK_URL = 512;
const MAX_MEDIA_ORIGIN = 255;
const MAX_MEDIA_CAPABILITY = 256;
const MAX_PARTY = 1_000_000;
const MAX_ENVELOPE_BYTES = 4096;

function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? [...trimmed].slice(0, max).join('') : null;
}

function integer(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function safeUrl(raw) {
  const value = text(raw, MAX_URL);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeArtworkUrl(raw) {
  const value = text(raw, MAX_ARTWORK_URL);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function mediaAsset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const origin = text(value.origin, MAX_MEDIA_ORIGIN);
  const hash = text(value.hash, 64);
  const capability = text(value.capability, MAX_MEDIA_CAPABILITY);
  if (!origin || !hash || !capability) return null;
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(origin)) return null;
  if (!/^[0-9a-f]{64}$/i.test(hash)) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(capability)) return null;
  return { origin, hash: hash.toLowerCase(), capability };
}

function artwork(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const largeImage = safeArtworkUrl(value.large_image);
  const smallImage = safeArtworkUrl(value.small_image);
  const largeMedia = mediaAsset(value.large_media);
  if (!largeImage && !smallImage && !largeMedia) return null;
  return {
    large_image: largeImage,
    large_text: (largeImage || largeMedia) ? text(value.large_text) : null,
    ...(largeMedia ? { large_media: largeMedia } : {}),
    small_image: smallImage,
    small_text: smallImage ? text(value.small_text) : null,
  };
}

/// Presence is network input: re-validate before rendering rich fields, artwork or URLs.
export function normalizeRichActivity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const applicationId = text(value.application_id, MAX_APP_ID);
  const suppliedName = text(value.name);
  const details = text(value.details);
  const state = text(value.state);
  const typeValue = Number(value.type);
  const type = Number.isInteger(typeValue) && typeValue >= 0 && typeValue <= 5 ? typeValue : 0;

  const timestamps = {};
  const start = integer(value.timestamps?.start);
  const end = integer(value.timestamps?.end);
  if (start) timestamps.start = start;
  if (end) timestamps.end = end;

  let party = null;
  const size = value.party?.size;
  if (Array.isArray(size) && size.length >= 2) {
    const current = integer(size[0]);
    const maximum = integer(size[1]);
    if (current !== null && maximum !== null && current <= maximum && maximum <= MAX_PARTY) {
      party = { size: [current, maximum] };
    }
  }

  const buttons = [];
  for (const candidate of Array.isArray(value.buttons) ? value.buttons.slice(0, 2) : []) {
    const label = text(candidate?.label, 32);
    const url = safeUrl(candidate?.url);
    if (label && url) buttons.push({ label, url });
  }

  const name = suppliedName || ((applicationId || details || state) ? 'Desktop activity' : null);
  if (!name) return null;
  return {
    application_id: applicationId,
    name,
    type,
    details,
    state,
    timestamps: Object.keys(timestamps).length ? timestamps : null,
    party,
    buttons,
    assets: artwork(value.assets),
  };
}

function activitySlot(activity) {
  if (activity?.type === 2) return 'music';
  if (activity?.type === 1 || activity?.type === 3) return 'video';
  return 'game';
}

/// De-duplicated again at the viewer: a patched client must not be able to overfill the profile section.
export function normalizeRichActivities(value) {
  if (!Array.isArray(value)) return [];
  const slots = new Set();
  const out = [];
  for (const candidate of value) {
    const activity = normalizeRichActivity(candidate);
    if (!activity) continue;
    const slot = activitySlot(activity);
    if (slots.has(slot)) continue;
    slots.add(slot);
    out.push(activity);
    if (out.length >= 3) break;
  }
  return out;
}

export function encodeRichActivity(activity) {
  const normalized = normalizeRichActivity(activity);
  if (!normalized) return null;
  try {
    const payload = JSON.stringify(normalized);
    if (payload.length > MAX_ENVELOPE_BYTES) return null;
    return RICH_ACTIVITY_PREFIX + payload;
  } catch {
    return null;
  }
}

/// Older servers may return the envelope untouched, so decode it here too.
export function decodeRichActivity(value) {
  if (typeof value !== 'string' || !value.startsWith(RICH_ACTIVITY_PREFIX)) return null;
  const raw = value.slice(RICH_ACTIVITY_PREFIX.length);
  if (!raw || raw.length > MAX_ENVELOPE_BYTES) return null;
  try {
    return normalizeRichActivity(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function richActivitiesOf(presence) {
  const many = normalizeRichActivities(presence?.rich_activities);
  if (many.length) return many;
  const one = normalizeRichActivity(presence?.rich_activity) || decodeRichActivity(presence?.activity);
  return one ? [one] : [];
}

export function richActivityOf(presence) {
  return richActivitiesOf(presence)[0] || null;
}
