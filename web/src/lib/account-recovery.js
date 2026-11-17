// Recovery key: a random 32-byte seed; HMAC-SHA256 subkeys give the Ed25519 reset key and the vault wrapper.

import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, unb64 } from './util.js';

const PREFIX = 'telium-recovery-v1-';
export const PENDING_RECOVERY_STORAGE_KEY = 'telium.pending-account-recovery.v1';
const RESET_DOMAIN = 'telium-password-reset:v1';
const RESET_START_DOMAIN = 'telium-password-reset-start:v1';
const COPY_RESTORE_DOMAIN = 'telium-recovery-k1-restore:v1';
const te = new TextEncoder();
const SIGN_LABEL = te.encode('telium/account-recovery-sign/v1');
const VAULT_LABEL = te.encode('telium/account-recovery-vault/v1');

/// The key out of whatever was pasted, including the whole saved note and one-line fields that flattened line breaks.
const EMBEDDED = new RegExp(`${PREFIX}[A-Za-z0-9_-]{43}`);
function keyText(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith(PREFIX)) {
    const found = EMBEDDED.exec(raw);
    if (found) return found[0];
  }
  return raw.replace(/\s+/g, '');
}

function seedBytes(value) {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) throw new Error('recovery key must contain 32 bytes');
    return new Uint8Array(value);
  }
  const text = keyText(value);
  if (!text.startsWith(PREFIX)) {
    throw new Error('That is not a Telium recovery key.');
  }
  let seed;
  try { seed = unb64(text.slice(PREFIX.length)); }
  catch { throw new Error('That recovery key is malformed.'); }
  if (seed.length !== 32) throw new Error('That recovery key is malformed.');
  return seed;
}

function signingSeed(value) {
  return new Uint8Array(hmac(sha256, seedBytes(value), SIGN_LABEL));
}

export function generateAccountRecovery() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  return {
    text: PREFIX + b64url(seed),
    publicKey: b64url(ed25519.getPublicKey(signingSeed(seed))),
    vaultWrapper: recoveryVaultWrapper(seed),
  };
}

export function recoveryPublicKey(value) {
  return b64url(ed25519.getPublicKey(signingSeed(value)));
}

export function recoveryVaultWrapper(value) {
  return new Uint8Array(hmac(sha256, seedBytes(value), VAULT_LABEL));
}

/// `vault` ({ ciphertext, version }) is the re-wrapped vault the reset replaces the old one with; it is inside the signature,
/// so the server cannot swap it, and a reset that carries none signs the shorter form.
export function passwordResetPayload(
  userId,
  resetId,
  challenge,
  registrationRecord,
  vault = null,
  unopenableVersion = null,
) {
  let text = `${RESET_DOMAIN}|${userId}|${resetId}|${challenge}|${registrationRecord}`;
  if (vault) text += `|${vault.version}|${vault.ciphertext}`;
  // "The recovery copy of vault `version` does not open under this key; reset anyway." Only the key's holder can say it.
  if (unopenableVersion != null) text += `|vault-unopenable|${unopenableVersion}`;
  return te.encode(text);
}

export function signPasswordReset(
  recoveryKey,
  userId,
  resetId,
  challenge,
  registrationRecord,
  vault = null,
  unopenableVersion = null,
) {
  return b64url(ed25519.sign(
    passwordResetPayload(userId, resetId, challenge, registrationRecord, vault, unopenableVersion),
    signingSeed(recoveryKey),
  ));
}

/// Proves the caller holds the recovery key before the server hands back the recovery copy of the vault. `user` is
/// exactly what is sent in the request.
export function passwordResetStartPayload(user, registrationRequest) {
  return te.encode(`${RESET_START_DOMAIN}|${user}|${registrationRequest}`);
}

export function signPasswordResetStart(recoveryKey, user, registrationRequest) {
  return b64url(ed25519.sign(
    passwordResetStartPayload(user, registrationRequest),
    signingSeed(recoveryKey),
  ));
}

export function recoveryCopyPayload(userId, attemptId, challenge, ciphertext) {
  return te.encode(
    `${COPY_RESTORE_DOMAIN}|${userId}|${attemptId}|${challenge}|${ciphertext}`,
  );
}

export function signRecoveryCopyRestore(recoveryKey, userId, attemptId, challenge, ciphertext) {
  return b64url(ed25519.sign(
    recoveryCopyPayload(userId, attemptId, challenge, ciphertext),
    signingSeed(recoveryKey),
  ));
}

/// For statements whose payload already carries its own domain string (an identity reset).
export function signWithRecoveryKey(recoveryKey, payload) {
  return b64url(ed25519.sign(payload, signingSeed(recoveryKey)));
}

export function normalizeRecoveryKey(value) {
  const seed = seedBytes(value);
  return PREFIX + b64url(seed);
}

/// Only the prefix is looked at: a malformed key is refused as a key, not tried as a passphrase.
export function looksLikeRecoveryKey(value) {
  return keyText(value).startsWith(PREFIX);
}
