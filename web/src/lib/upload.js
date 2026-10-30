import { discover } from './api.js';
import { b64url, unb64 } from './util.js';
import { gcm } from '@noble/ciphers/aes.js';
import { uploadExternal } from './external-upload.js';
import { domainOf, effectiveMode, teliumFetch } from './net/transport.js';
// The bare `t`: the preset table stores keys, since constants evaluate before a language is chosen.
import { t } from './i18n/index.js';

export { uploadExternal } from './external-upload.js';

/// Tier 1: your own homeserver on your home token (default). Tier 2: any other origin, on a short-lived voucher the guild signs. `uploadAttachment` tries them in order unless the account picked a tier.

async function send(base, path, headers, file, opts = {}) {
  // A dead signal must not start anything, and XHR has no native way to know.
  if (opts.signal?.aborted) {
    return Promise.reject(new DOMException('The upload was cancelled.', 'AbortError'));
  }
  const requestHeaders = {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Telium-Filename': encodeURIComponent(file.name),
    ...headers,
  };
  // XHR reports progress but can't go through a tunnel, so protected mode relays without a percentage rather than going direct.
  const url = `${base}${path}`;
  const relayed = effectiveMode(domainOf(url) || '').route === 'protected';
  const resp = opts.onProgress && !relayed
    ? await xhrSend(url, requestHeaders, file, opts.onProgress, opts.signal)
    : await teliumFetch(url, {
      method: 'POST', headers: requestHeaders, body: file, signal: opts.signal,
    }, { purpose: 'upload' });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    const error = new Error(payload.message || 'upload failed');
    error.status = resp.status;
    throw error;
  }
  const media = await resp.json();
  // `mime` and `size` come from the origin, the only party that read the bytes.
  return {
    origin: media.origin,
    hash: media.hash,
    ref: media.hash,
    reference: media.reference,
    capability: media.capability,
    url: media.url,
    filename: media.filename || file.name,
    name: media.filename || file.name,
    mime: media.mime || file.type,
    size: media.size ?? file.size,
    expires_at: media.expires_at ?? null,
  };
}

/// `null` is "never", last so a cap can cut the tail. Keys resolve in `expiryOptions`; the thirty-day preset has no key because `describeLimit` derives it.
export const EXPIRY_PRESETS = [
  { secs: 60 * 60, labelKey: 'chat.upload.expiryHour' },
  { secs: 24 * 60 * 60, labelKey: 'chat.upload.expiryDay' },
  { secs: 7 * 24 * 60 * 60, labelKey: 'chat.upload.expiryWeek' },
  { secs: 30 * 24 * 60 * 60 },
  { secs: null, labelKey: 'chat.upload.expiryNever' },
];

/// Mirrors the server's resolution (channel > guild > server).
export function narrowestLimit(...caps) {
  const set = caps.filter((c) => typeof c === 'number' && c > 0);
  return set.length ? Math.min(...set) : null;
}

export function expiryOptions(limitSecs) {
  // Under a cap "Never" is dropped; the origin would trim it anyway.
  const fitting = EXPIRY_PRESETS
    .filter((p) => limitSecs === null || (p.secs !== null && p.secs <= limitSecs))
    .map((p) => ({ secs: p.secs, label: p.labelKey ? t(p.labelKey) : describeLimit(p.secs) }));
  if (limitSecs !== null && !fitting.some((p) => p.secs === limitSecs)) {
    fitting.push({ secs: limitSecs, label: describeLimit(limitSecs), capped: true });
  }
  return fitting;
}

/// Uses ICU plurals and `#` so numbers are locale-formatted.
export function describeLimit(secs) {
  if (secs % (24 * 60 * 60) === 0) {
    return t('chat.upload.limitDays', { count: secs / (24 * 60 * 60) });
  }
  if (secs % (60 * 60) === 0) {
    return t('chat.upload.limitHours', { count: secs / (60 * 60) });
  }
  return t('chat.upload.limitMinutes', { count: Math.max(1, Math.round(secs / 60)) });
}

export function defaultExpiry(options) {
  const month = options.find((o) => o.secs === 30 * 24 * 60 * 60);
  if (month) return month.secs;
  return Math.max(...options.map((o) => o.secs));
}

function expiryHeaders(opts = {}) {
  const headers = {};
  if (opts.ttlSecs > 0) headers['X-Telium-Ttl-Secs'] = String(Math.round(opts.ttlSecs));
  if (opts.channelId) headers['X-Telium-Channel-Id'] = opts.channelId;
  if (opts.guildId) headers['X-Telium-Guild-Id'] = opts.guildId;
  return headers;
}

/// `purpose` matters: a server hosting no general uploads still takes avatars and banners. The origin may store a shorter life than `opts.ttlSecs`, never a longer one.
export function uploadMedia(home, file, purpose = 'attachment', opts = {}) {
  return send(home.base, '/_telium/v1/media', {
    Authorization: `Bearer ${home.token}`,
    'X-Telium-Purpose': purpose,
    ...expiryHeaders(opts),
  }, file, opts);
}

const bases = new Map();
async function originBase(origin) {
  if (!bases.has(origin)) bases.set(origin, discover(origin).then((doc) => doc.api));
  try { return await bases.get(origin); }
  catch (e) { bases.delete(origin); throw e; }
}

/// The guild vouches; the origin verifies the signature.
export async function uploadVouched(guild, guildId, origin, file, opts = {}) {
  const base = origin === guild.domain ? guild.base : await originBase(origin);
  const { voucher } = await guild.mediaVoucher({
    guild_id: guildId,
    origin,
    max_bytes: file.size,
  });
  const encoded = b64url(new TextEncoder().encode(JSON.stringify(voucher)));
  const purpose = opts.purpose ? { 'X-Telium-Purpose': opts.purpose } : {};
  return send(base, '/_telium/v1/media/voucher-upload', {
    'X-Telium-Voucher': encoded,
    ...purpose,
    ...expiryHeaders(opts),
  }, file, opts);
}

export async function uploadGuildIcon(api, guildId, file) {
  const media = await uploadVouched(api, guildId, api.domain, file, { purpose: 'profile' });
  const iconRef = profileRef(media);
  await api.patchGuild(guildId, { icon_ref: iconRef });
  return iconRef;
}

/// A chosen tier never falls back; only a 403/413 falls through, since a network error means nothing was decided.
export async function uploadAttachment(store, channel, file, opts = {}) {
  const pref = store.mediaPreference || { tier: 1, origin: null };
  // Tier 3: the provider is passed per upload, not stored on the account.
  if (pref.tier === 3) {
    if (!opts.externalHost) throw new Error('Choose an external upload host first.');
    return uploadExternal(store.home, opts.externalHost, file, { onProgress: opts.onProgress });
  }
  const where = { channelId: channel.id, guildId: channel.guild_id, ...opts };
  if (pref.tier === 2 && pref.origin) {
    const guild = store.apiForChannel(channel.id);
    if (!guild) throw new Error('No guild session to vouch for this upload.');
    return uploadVouched(guild, channel.guild_id, pref.origin, file, where);
  }
  try {
    return await uploadMedia(store.home, file, 'attachment', where);
  } catch (e) {
    if (e.status !== 403 && e.status !== 413) throw e;
    const guild = store.apiForChannel(channel.id);
    if (!guild) throw e;
    return uploadVouched(guild, channel.guild_id, guild.domain, file, where);
  }
}

function xhrSend(url, headers, file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onerror = () => reject(new Error('Upload failed.'));
    xhr.onabort = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('The upload was cancelled.', 'AbortError'));
    };
    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        json: async () => JSON.parse(xhr.responseText),
      });
    };
    xhr.send(file);
  });
}

/// Encrypted under a per-file key, only ciphertext uploaded; the key travels in the MLS message body. No tier 2: a DM has no guild to sign vouchers.
export async function uploadEncrypted(home, file, opts = {}) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // AES-GCM descriptor format: 32-byte key, 12-byte IV, ciphertext plus 16-byte tag.
  const sealed = gcm(raw, iv).encrypt(new Uint8Array(await file.arrayBuffer()));
  // A per-upload key also stops hash de-duplication revealing shared documents.
  const blob = new File([sealed], 'attachment.bin', { type: 'application/octet-stream' });
  const media = await uploadMedia(home, blob, 'attachment', opts);
  return {
    ref: media.ref,
    url: media.url,
    capability: media.capability,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    expires_at: media.expires_at,
    key: b64url(raw),
    iv: b64url(iv),
  };
}

export async function fetchEncrypted(base, att) {
  const url = att.url
    || `${base}/_telium/v1/media/${att.ref}?cap=${encodeURIComponent(att.capability || '')}`;
  const resp = await teliumFetch(url, {}, { purpose: 'attachment' });
  // Two whole sentences, not a substituted noun phrase, so other languages can inflect.
  if (!resp.ok) {
    throw new Error(att.name
      ? t('chat.upload.fetchFailedNamed', { name: att.name })
      : t('chat.upload.fetchFailed'));
  }
  const plain = gcm(unb64(att.key), unb64(att.iv))
    .decrypt(new Uint8Array(await resp.arrayBuffer()));
  return new Blob([plain], { type: att.mime || 'application/octet-stream' });
}

export function profileRef(media) {
  return `${media.hash}?cap=${media.capability}`;
}
