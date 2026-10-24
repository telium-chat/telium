import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  decryptInboxRow,
  drainNotificationInbox,
  enrollBrowserNotificationInbox,
  loadBrowserNotificationRegistration,
  notificationAad,
  notificationForInboxRow,
} from '../lib/browser-notification-inbox.js';

const ALGORITHM = 'P256-HKDF-SHA256-A256GCM';
const encoder = new TextEncoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function b64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function seal(publicKey, aad, descriptor) {
  const peer = await crypto.subtle.importKey(
    'raw', publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peer }, ephemeral.privateKey, 256,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const keyBytes = await crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info: concat(encoder.encode('Telium notification v1\0'), aad),
  }, hkdf, 256);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128,
  }, key, encoder.encode(JSON.stringify(descriptor)));
  return {
    v: 1,
    alg: ALGORITHM,
    ephemeral: b64(new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))),
    salt: b64(salt),
    nonce: b64(nonce),
    ciphertext: b64(new Uint8Array(ciphertext)),
  };
}

async function browserRegistration() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  return {
    home_base: 'https://home.example',
    user_id: '@alice:home.example',
    device_id: 'browser-1',
    private_key: pair.privateKey,
    public_key: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    background_token: 'notification-token',
  };
}

async function guildRow(registration, overrides = {}) {
  const row = {
    id: '01ROW1',
    origin: 'guild.example',
    source_id: 'message-1',
    kind: 'mention',
    guild_id: 'guild-1',
    created_at: 1_700_000_000_000,
    ...overrides,
  };
  const descriptor = {
    v: 1,
    kind: row.kind,
    title: 'Alice',
    body: 'hello',
    destination: {
      type: 'guild_message',
      guild_origin: row.origin,
      guild_id: row.guild_id,
      channel_id: 'channel-1',
      message_id: row.source_id,
    },
    created_at: row.created_at,
  };
  row.ciphertext = await seal(
    registration.public_key,
    notificationAad(
      registration.user_id,
      registration.device_id,
      row.origin,
      row.source_id,
      row.guild_id,
      row.kind,
    ),
    descriptor,
  );
  return { row, descriptor };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('browser notification inbox', () => {
  it('decrypts the notification suite and rejects row metadata tampering', async () => {
    const registration = await browserRegistration();
    const { row, descriptor } = await guildRow(registration);
    await expect(decryptInboxRow(row, registration)).resolves.toEqual(descriptor);
    await expect(decryptInboxRow({ ...row, origin: 'evil.example' }, registration)).rejects.toThrow();
    await expect(decryptInboxRow({ ...row, source_id: 'message-2' }, registration)).rejects.toThrow();
    await expect(decryptInboxRow({ ...row, guild_id: 'guild-2' }, registration)).rejects.toThrow();
    expect(() => notificationForInboxRow(row, {
      ...descriptor,
      destination: { ...descriptor.destination, channel_id: '', message_id: 'message-2' },
    })).toThrow();
  });

  it('consumes quiet DM hints silently and exposes only generic visible DM text', async () => {
    const registration = await browserRegistration();
    for (const notify of [0, 1]) {
      const row = {
        id: `01DM${notify}`,
        origin: 'dm:conversation-1',
        source_id: `hint-${notify}`,
        kind: 'dm_hint',
        guild_id: null,
        created_at: 1_700_000_000_000,
      };
      const envelope = await seal(
        registration.public_key,
        notificationAad(
          registration.user_id, registration.device_id, row.origin, row.source_id, '', row.kind,
        ),
        { v: 1, kind: 'dm_hint', notify },
      );
      row.ciphertext = { envelope, conversation_id: 'conversation-1', sender: '@bob:b.example' };
      const descriptor = await decryptInboxRow(row, registration);
      const notification = notificationForInboxRow(row, descriptor);
      if (notify === 0) expect(notification).toEqual({ silent: true });
      else expect(notification).toMatchObject({
        title: 'Telium',
        body: 'Encrypted message',
        destination: { type: 'conversation', conversation_id: 'conversation-1' },
      });
    }
  });

  it('acks only the contiguous rows processed before a malformed row', async () => {
    const registration = await browserRegistration();
    const first = await guildRow(registration, { id: '01A', source_id: 'message-a' });
    const second = await guildRow(registration, { id: '01B', source_id: 'message-b' });
    const third = { ...second.row, id: '01C', source_id: 'message-c', ciphertext: { bad: true } };
    const acks = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (url.endsWith('/_telium/v1/notifications?limit=50')) {
        return new Response(JSON.stringify({ notifications: [first.row, second.row, third] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      acks.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const shown = [];
    await expect(drainNotificationInbox(registration, {
      fetchImpl,
      onNotification: async (notification) => shown.push(notification),
    })).resolves.toEqual({ processed: 2, blocked: true });
    expect(shown).toHaveLength(2);
    expect(acks).toEqual([{ through: '01B' }]);
  });

  it('enrolls a browser key only when the homeserver advertises native notifications', async () => {
    const session = {
      base: 'https://home.example', user_id: '@alice:home.example', device_id: 'browser-1',
    };
    const unsupported = {
      capabilities: vi.fn(async () => ({ features: { native_notifications: false } })),
    };
    await expect(enrollBrowserNotificationInbox(unsupported, session)).resolves.toBe(false);

    const home = {
      capabilities: vi.fn(async () => ({ features: { native_notifications: true } })),
      put: vi.fn(async (_path, body) => ({
        device_id: session.device_id,
        algorithm: body.algorithm,
        background_token: 'scoped-token',
      })),
      del: vi.fn(async () => ({ ok: true })),
    };
    await expect(enrollBrowserNotificationInbox(home, session)).resolves.toBe(true);
    const saved = await loadBrowserNotificationRegistration();
    expect(saved).toMatchObject({
      home_base: session.base,
      user_id: session.user_id,
      device_id: session.device_id,
      algorithm: ALGORITHM,
      background_token: 'scoped-token',
    });
    expect(saved.private_key.type).toBe('private');
  });
});
