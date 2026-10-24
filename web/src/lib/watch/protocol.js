// Sealed under an MLS-derived key in conversations; in guild voice channels notes go in the clear.

import { providerById, sourceFor } from './providers.js';
import { b64, unb64 } from '../util.js';

/// Distinct label so a watch key is no use against hellos or media.
export const WATCH_LABEL = 'telium watch sync v1';

const te = new TextEncoder();
const td = new TextDecoder();

function aad(conversationId, sender) {
  return te.encode(`telium watch|${conversationId}|${sender}`);
}

async function importKey(raw, use) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [use]);
}

/// The epoch travels in the clear so a receiver can tell an epoch it no longer holds from a forgery.
export async function sealNote(raw, { conversationId, sender, epoch }, note) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(raw, 'encrypt');
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(conversationId, sender) },
    key, te.encode(JSON.stringify(note)),
  ));
  return { v: 1, epoch, iv: b64(iv), ct: b64(ct) };
}

/// Null is silence: failures are key turnover or someone trying something.
export async function openNote(raw, { conversationId, sender, epoch }, sealed) {
  if (!sealed || sealed.v !== 1 || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') return null;
  if (epoch !== undefined && epoch !== null && sealed.epoch !== epoch) return null;
  try {
    const key = await importKey(raw, 'decrypt');
    const body = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: aad(conversationId, sender) },
      key, unb64(sealed.ct),
    );
    return readNote(JSON.parse(td.decode(body)));
  } catch {
    return null;
  }
}

// Everything below is treated as written by a stranger: `Infinity` or a zero `rate` wedges an iframe.

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function str(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function count(value) {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

/// Rebuilt from fields a provider's parser would produce; it decides the URL an iframe is pointed at.
export function readSource(value) {
  if (!value || typeof value !== 'object') return null;
  const provider = providerById(str(value.provider, 32));
  if (!provider) return null;
  if (provider.id === 'file') {
    const url = str(value.url, 2048);
    // Round-tripped through the parser so `providers.js` alone decides what a playable URL is.
    return url ? sourceFor(url) : null;
  }
  const id = str(value.id, 64);
  if (!id) return null;
  const rebuilt = { provider: provider.id, id, start: count(value.start) || 0 };
  if (provider.id === 'vimeo') rebuilt.hash = str(value.hash, 32);
  return provider.embed(rebuilt) ? rebuilt : null;
}

export function readTimeline(value) {
  if (!value || typeof value !== 'object') return null;
  const seq = count(value.seq);
  const at = count(value.at);
  const position = count(value.position);
  if (seq === null || at === null || position === null) return null;
  const rate = RATES.includes(value.rate) ? value.rate : null;
  if (rate === null) return null;
  return { seq, by: str(value.by, 128) || '', at, position, rate, paused: Boolean(value.paused) };
}

export function readNote(value) {
  if (!value || typeof value !== 'object') return null;
  const id = str(value.id, 64);
  if (!id) return null;
  switch (value.k) {
    case 'state': {
      const source = readSource(value.source);
      const timeline = readTimeline(value.timeline);
      if (!source || !timeline) return null;
      return { k: 'state', id, source, timeline, by: str(value.by, 128) || '' };
    }
    case 'line': {
      const timeline = readTimeline(value.timeline);
      return timeline ? { k: 'line', id, timeline } : null;
    }
    case 'ping': {
      const t0 = count(value.t0);
      return t0 === null ? null : { k: 'ping', id, t0 };
    }
    case 'pong': {
      const t0 = count(value.t0);
      const t1 = count(value.t1);
      return t0 === null || t1 === null ? null : { k: 'pong', id, t0, t1 };
    }
    case 'stall':
      return { k: 'stall', id, on: Boolean(value.on) };
    case 'end':
      return { k: 'end', id };
    default:
      return null;
  }
}
