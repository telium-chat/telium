import { describe, expect, it } from 'vitest';
import { open, seal } from '../lib/vault.js';

const b64 = (hex) => btoa(String.fromCharCode(...hex.match(/../g).map((part) => Number.parseInt(part, 16))));

describe('portable recovery vault crypto', () => {
  it('opens the standard AES-256-GCM ciphertext layout the WebCrypto client used', async () => {
    const key = new Uint8Array(32);
    const iv = b64('000000000000000000000000');
    const ciphertext = b64('530f8afbc74536b9a963b4f1c4cb738b');

    expect(await open(key, `${iv}.${ciphertext}`)).toEqual(new Uint8Array());
  });

  it('still round-trips newly sealed recovery material', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const plain = crypto.getRandomValues(new Uint8Array(96));
    expect(await open(key, await seal(key, plain))).toEqual(plain);
  });
});
