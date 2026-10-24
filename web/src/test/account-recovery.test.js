import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  generateAccountRecovery,
  normalizeRecoveryKey,
  passwordResetPayload,
  recoveryPublicKey,
  recoveryVaultWrapper,
  signPasswordReset,
} from '../lib/account-recovery.js';
import { unb64 } from '../lib/util.js';

describe('account recovery keys', () => {
  it('are client-generated and authorize the exact password reset record', () => {
    const recovery = generateAccountRecovery();
    expect(recovery.text).toMatch(/^telium-recovery-v1-/);
    expect(unb64(recovery.publicKey)).toHaveLength(32);
    expect(recovery.vaultWrapper).toHaveLength(32);
    expect(normalizeRecoveryKey('  ' + recovery.text + '  ')).toBe(recovery.text);
    expect(recoveryPublicKey(recovery.text)).toBe(recovery.publicKey);
    expect(Array.from(recoveryVaultWrapper(recovery.text)))
      .toEqual(Array.from(recovery.vaultWrapper));

    const payload = passwordResetPayload(
      '@alice:test.example',
      'reset-id',
      'challenge',
      'opaque-registration-record',
    );
    const signature = unb64(signPasswordReset(
      recovery.text,
      '@alice:test.example',
      'reset-id',
      'challenge',
      'opaque-registration-record',
    ));
    expect(ed25519.verify(signature, payload, unb64(recovery.publicKey))).toBe(true);

    const changed = passwordResetPayload(
      '@alice:test.example',
      'reset-id',
      'challenge',
      'different-registration-record',
    );
    expect(ed25519.verify(signature, changed, unb64(recovery.publicKey))).toBe(false);
  });

  it('rejects malformed human input before making a recovery request', () => {
    expect(() => recoveryPublicKey('not-a-recovery-key')).toThrow(/not a Telium recovery key/i);
    expect(() => recoveryVaultWrapper('telium-recovery-v1-AA')).toThrow(/malformed/i);
  });
});
