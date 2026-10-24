import { describe, expect, it } from 'vitest';
import { load, open, seal } from '../lib/vault.js';

const b64 = (hex) => btoa(String.fromCharCode(...hex.match(/../g).map((part) => Number.parseInt(part, 16))));
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('portable recovery vault crypto', () => {
  it('opens the standard AES-256-GCM ciphertext layout the WebCrypto client used', async () => {
    const key = new Uint8Array(32);
    const iv = b64('000000000000000000000000');
    const ciphertext = b64('530f8afbc74536b9a963b4f1c4cb738b');

    expect(await open(key, `${iv}.${ciphertext}`)).toEqual(new Uint8Array());
  });

  it('opens a self-custody vault produced with the original PBKDF2/WebCrypto format', async () => {
    const existing = {
      exists: true,
      mode: 'self_custody',
      ciphertext: 'AAECAwQFBgcICQoL.OG+YnYpG5eN9IYURADCrUhKjt4M2g7yVlQ2L8OfO3exs3eAA/Cg8cpncyZNdl6HG',
    };
    const home = { vault: async () => existing };

    const loaded = await load(home, 'android-vault-test');
    expect(hex(loaded.raw)).toBe(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    expect(loaded.mode).toBe('self_custody');
  });

  it('still round-trips newly sealed recovery material', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const plain = crypto.getRandomValues(new Uint8Array(96));
    expect(await open(key, await seal(key, plain))).toEqual(plain);
  });
});
