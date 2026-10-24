// Killed-app DM notification hints, sealed to the native notification device key rather than MLS.

const ALGORITHM = 'P256-HKDF-SHA256-A256GCM';
const PREFIX = new TextEncoder().encode('telium-notification-v1');
const INFO_PREFIX = new TextEncoder().encode('Telium notification v1\0');
const encoder = new TextEncoder();

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodedPart(value) {
  const bytes = encoder.encode(String(value ?? ''));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, bytes.length, false);
  return concat(size, bytes);
}

function aad(userId, deviceId, origin, sourceId, kind) {
  return concat(
    PREFIX,
    encodedPart(userId),
    encodedPart(deviceId),
    encodedPart(origin),
    encodedPart(sourceId),
    encodedPart(''),
    encodedPart(kind),
  );
}

function encode64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decode64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Notification public key is malformed.');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function dmNotificationId() {
  return encode64(crypto.getRandomValues(new Uint8Array(18)));
}

export async function sealDmNotificationHint(target, sequencer, notificationId, notify) {
  if (target?.algorithm !== ALGORITHM) {
    throw new Error('Unsupported DM notification key algorithm.');
  }
  const publicBytes = decode64(target.public_key);
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error('DM notification public key is not P-256.');
  }

  const recipient = await crypto.subtle.importKey(
    'raw',
    publicBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: recipient },
    ephemeral.privateKey,
    256,
  ));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const associatedData = aad(
    target.user_id,
    target.device_id,
    sequencer,
    notificationId,
    'dm_hint',
  );
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const rawKey = new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: concat(INFO_PREFIX, associatedData),
    },
    hkdf,
    256,
  ));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);

  // 0 and 1 have identical JSON length, so ciphertext size reveals nothing.
  const descriptor = encoder.encode(JSON.stringify({ v: 1, kind: 'dm_hint', notify: notify ? 1 : 0 }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: associatedData, tagLength: 128 },
    key,
    descriptor,
  ));
  const ephemeralPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey),
  );

  return {
    user_id: target.user_id,
    device_id: target.device_id,
    public_key: target.public_key,
    ciphertext: {
      v: 1,
      alg: ALGORITHM,
      ephemeral: encode64(ephemeralPublic),
      salt: encode64(salt),
      nonce: encode64(nonce),
      ciphertext: encode64(ciphertext),
    },
  };
}

export async function sealDmNotificationHints(targets, sequencer, notificationId, notify) {
  if (!Array.isArray(targets) || targets.length > 256) {
    throw new Error('Too many DM notification targets.');
  }
  return Promise.all(
    targets.map((target) => sealDmNotificationHint(target, sequencer, notificationId, notify)),
  );
}
