// Seals sync-store values with a key derived (HKDF) from the MLS recovery keyring; AES-256-GCM with associated data.
import { b64url } from './util.js';

const LABEL = 'telium/sealed-sync/v1';
export const ENVELOPE_VERSION = 'v1';

const te = new TextEncoder();
const td = new TextDecoder();

/// `unknown-key`: no such key here; `tampered`: key held, value fails auth; `version`: later envelope; `malformed`: not an envelope.
export class SealedSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function unb64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new SealedSyncError('malformed', 'not base64url');
  }
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveSyncKey(raw) {
  const ikm = await crypto.subtle.importKey(
    'raw', new Uint8Array(raw), 'HKDF', false, ['deriveKey', 'deriveBits'],
  );
  const params = (info) => ({
    name: 'HKDF', hash: 'SHA-256', salt: te.encode(LABEL), info: te.encode(info),
  });
  const key = await crypto.subtle.deriveKey(
    params('aead'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const kid = b64url(new Uint8Array(await crypto.subtle.deriveBits(params('key-id'), ikm, 64)));
  return { kid, key };
}

export async function syncKeys(ring) {
  if (!ring?.raw) return null;
  const live = await deriveSyncKey(ring.raw);
  const byKid = new Map([[live.kid, live.key]]);
  for (const old of ring.retired || []) {
    const derived = await deriveSyncKey(old);
    if (!byKid.has(derived.kid)) byKid.set(derived.kid, derived.key);
  }
  return { kid: live.kid, key: live.key, byKid };
}

export function isSealed(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.sealed === 'string' && typeof value.ct === 'string';
}

function associatedData(kid, name) {
  return te.encode(`${LABEL}\n${kid}\n${name}`);
}

/// Padded length: 256 at least, then next power of two, then 64 KiB steps. The server sees the bucket.
export function paddedLength(n) {
  if (n <= 256) return 256;
  if (n <= 65536) return 2 ** Math.ceil(Math.log2(n));
  return Math.ceil(n / 65536) * 65536;
}

function pad(body) {
  const out = new Uint8Array(paddedLength(body.length + 4));
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

function unpad(bytes) {
  if (bytes.length < 4) throw new SealedSyncError('tampered', 'short plaintext');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (length > bytes.length - 4) throw new SealedSyncError('tampered', 'bad padding');
  return bytes.subarray(4, 4 + length);
}

export async function seal(keys, name, doc) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(keys.kid, name) },
    keys.key,
    pad(te.encode(JSON.stringify(doc))),
  );
  return { sealed: ENVELOPE_VERSION, kid: keys.kid, iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

export async function open(keys, name, envelope) {
  if (!isSealed(envelope)) throw new SealedSyncError('malformed', 'not a sealed value');
  if (envelope.sealed !== ENVELOPE_VERSION) {
    throw new SealedSyncError('version', `sealed ${envelope.sealed} is newer than this client`);
  }
  const key = keys?.byKid.get(envelope.kid);
  if (!key) throw new SealedSyncError('unknown-key', 'sealed under a key this device does not hold');
  const iv = unb64url(envelope.iv);
  if (iv.length !== 12) throw new SealedSyncError('tampered', 'bad nonce');
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: associatedData(envelope.kid, name) },
      key,
      unb64url(envelope.ct),
    ));
  } catch {
    throw new SealedSyncError('tampered', `${name} does not authenticate`);
  }
  let doc;
  try { doc = JSON.parse(td.decode(unpad(plain))); } catch (e) {
    if (e instanceof SealedSyncError) throw e;
    throw new SealedSyncError('tampered', 'unreadable plaintext');
  }
  if (!doc || typeof doc !== 'object' || !Number.isSafeInteger(doc.n) || doc.n < 1
    || !Number.isFinite(doc.t) || !('v' in doc)) {
    throw new SealedSyncError('tampered', 'unexpected plaintext');
  }
  return { doc, kid: envelope.kid };
}
