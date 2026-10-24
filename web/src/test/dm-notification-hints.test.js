import { describe, expect, it } from 'vitest';
import { sealDmNotificationHint } from '../lib/dm-notification-hints.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function unb64(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function part(value) {
  const bytes = encoder.encode(value);
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, bytes.length, false);
  return concat(size, bytes);
}

function aad(user, device, origin, source) {
  return concat(
    encoder.encode('telium-notification-v1'),
    part(user),
    part(device),
    part(origin),
    part(source),
    part(''),
    part('dm_hint'),
  );
}

async function open(privateKey, target, origin, source, envelope) {
  const ephemeral = await crypto.subtle.importKey(
    'raw',
    unb64(envelope.ephemeral),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephemeral },
    privateKey,
    256,
  );
  const associatedData = aad(target.user_id, target.device_id, origin, source);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const rawKey = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: unb64(envelope.salt),
      info: concat(encoder.encode('Telium notification v1\0'), associatedData),
    },
    hkdf,
    256,
  );
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: unb64(envelope.nonce),
      additionalData: associatedData,
      tagLength: 128,
    },
    key,
    unb64(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext));
}

describe('DM notification hints', () => {
  it('hides notify versus quiet inside equal-shape per-device ciphertext', async () => {
    const recipient = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    );
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', recipient.publicKey));
    const target = {
      user_id: '@bob:bob.example',
      device_id: 'phone-1',
      algorithm: 'P256-HKDF-SHA256-A256GCM',
      public_key: b64(publicKey),
    };
    const origin = 'dm:01CONVERSATION';
    const source = 'notification-token-123456789';

    const visible = await sealDmNotificationHint(target, origin, source, true);
    const quiet = await sealDmNotificationHint(target, origin, source, false);

    expect(visible.user_id).toBe(target.user_id);
    expect(visible.device_id).toBe(target.device_id);
    expect(visible.public_key).toBe(target.public_key);
    expect(JSON.stringify(visible)).not.toContain('"notify"');
    expect(JSON.stringify(quiet)).not.toContain('"notify"');
    expect(visible.ciphertext.ciphertext.length).toBe(quiet.ciphertext.ciphertext.length);

    await expect(open(recipient.privateKey, target, origin, source, visible.ciphertext))
      .resolves.toEqual({ v: 1, kind: 'dm_hint', notify: 1 });
    await expect(open(recipient.privateKey, target, origin, source, quiet.ciphertext))
      .resolves.toEqual({ v: 1, kind: 'dm_hint', notify: 0 });
  });
});
