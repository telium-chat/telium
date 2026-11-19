import { describe, expect, it } from 'vitest';
import { KSF_CURRENT, KSF_VERSIONS, ksfFor } from '../lib/opaque-auth.js';
import { passwordResetPayload, passwordResetStartPayload } from '../lib/account-recovery.js';

describe('key-stretching versions', () => {
  it('version 1 is the documented memory-constrained Argon2id (64 MiB), not a bigger one', () => {
    expect(KSF_CURRENT).toBe(1);
    expect(ksfFor(1)).toBe('memory-constrained');
  });

  it('the current version is one the table knows, and an unknown one is refused with a reason', () => {
    expect(KSF_VERSIONS[KSF_CURRENT]).toBeTruthy();
    expect(() => ksfFor(2)).toThrow(/does not know/);
    expect(() => ksfFor(undefined)).toThrow();
  });
});

describe('password reset signatures', () => {
  const dec = (bytes) => new TextDecoder().decode(bytes);

  it('the shorter form is unchanged, and a re-wrapped vault and its version are inside the longer one', () => {
    expect(dec(passwordResetPayload('@a:h', 'r', 'c', 'rec')))
      .toBe('telium-password-reset:v1|@a:h|r|c|rec');
    expect(dec(passwordResetPayload('@a:h', 'r', 'c', 'rec', { ciphertext: 'ct', version: 4 })))
      .toBe('telium-password-reset:v1|@a:h|r|c|rec|4|ct');
  });

  it('the start signature names the user and the registration request', () => {
    expect(dec(passwordResetStartPayload('alice', 'req'))).toBe('telium-password-reset-start:v1|alice|req');
  });
});
