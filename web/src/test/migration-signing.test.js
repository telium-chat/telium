import { describe, expect, it } from 'vitest';
import { signBytes } from '../views/user-settings/MigrationDialog.jsx';
import { b64url, unb64 } from '../lib/util.js';

function hex(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytes(value) {
  return new Uint8Array(value.match(/../g).map((part) => Number.parseInt(part, 16)));
}

describe('migration signing', () => {
  it('matches the RFC 8032 Ed25519 test vector without WebCrypto', async () => {
    const seed = bytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
    const expected = [
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155',
      '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    ].join('');

    const signature = await signBytes(b64url(seed), new Uint8Array());
    expect(hex(unb64(signature))).toBe(expected);
  });
});
