// OPAQUE (RFC 9807) client auth; the password never leaves this module except in the explicit legacy fallback.

import * as opaque from '@serenity-kit/opaque';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { request } from './api.js';
import { unb64 } from './util.js';
import {
  generateAccountRecovery, recoveryVaultWrapper, signPasswordReset, signPasswordResetStart,
} from './account-recovery.js';

const te = new TextEncoder();
const RECOVERY_LABEL = te.encode('telium/dm-recovery-from-opaque-export/v1');

// Key-stretching parameter sets, by the version recorded beside an account's OPAQUE record (server: accounts.opaque_ksf_version,
// KSF_VERSION_MAX in routes/opaque.rs). The stretching runs here, in the browser, never on the homeserver, so the cost
// is the slowest client's (design doc 3.5). Version 1 is serenity-kit's memory-constrained Argon2id: m = 2^16 KiB
// (64 MiB), t = 3, p = 4. It is spelled out so that a later change to the package default cannot move existing
// accounts. A new set is added here under a new number and `KSF_CURRENT` moves to it; sign-in then re-registers an
// account still on an older set (store/session.js), with the password in hand, in the same request that re-wraps its
// vault. Do not raise memory on a guess: measure the slowest supported device first.
export const KSF_VERSIONS = Object.freeze({ 1: 'memory-constrained' });
export const KSF_CURRENT = 1;

export function ksfFor(version) {
  const params = KSF_VERSIONS[version];
  if (!params) {
    throw new Error(`This account uses key-stretching settings (version ${version}) this app does not know. Update the app.`);
  }
  return params;
}

async function client() {
  // The package's WebAssembly initializes asynchronously; await its readiness before any client call.
  await opaque.ready;
  return opaque.client;
}

export function recoveryWrapperFromExportKey(exportKey) {
  return new Uint8Array(hmac(sha256, unb64(exportKey), RECOVERY_LABEL));
}

export async function authCapabilities(base) {
  return request(base, 'GET', '/_telium/v1/capabilities');
}

export async function registerOpaque(base, localpart, password, deviceName, registrationCode = null) {
  const api = await client();
  const accountRecovery = generateAccountRecovery();
  const first = api.startRegistration({ password });
  const server = await request(base, 'POST', '/_telium/v1/register/opaque/start', {
    body: {
      localpart,
      registration_request: first.registrationRequest,
      registration_code: registrationCode,
    },
  });
  const finished = api.finishRegistration({
    clientRegistrationState: first.clientRegistrationState,
    registrationResponse: server.registration_response,
    password,
    keyStretching: ksfFor(KSF_CURRENT),
  });
  const session = await request(base, 'POST', '/_telium/v1/register/opaque/finish', {
    body: {
      localpart,
      registration_record: finished.registrationRecord,
      ksf_version: KSF_CURRENT,
      registration_code: registrationCode,
      recovery_public_key: accountRecovery.publicKey,
      device_name: deviceName,
    },
  });
  return {
    session,
    exportKey: finished.exportKey,
    recoveryWrapper: recoveryWrapperFromExportKey(finished.exportKey),
    accountRecovery,
  };
}

export async function loginOpaque(
  base,
  user,
  password,
  deviceName,
  { mfaCode = null, reactivate = false } = {},
) {
  const api = await client();
  const first = api.startLogin({ password });
  const server = await request(base, 'POST', '/_telium/v1/login/opaque/start', {
    body: {
      user,
      start_login_request: first.startLoginRequest,
    },
  });

  // Raw password goes to an upgraded server only for an existing account with no OPAQUE record yet.
  if (server.legacy_upgrade_required) {
    return { legacyUpgradeRequired: true };
  }

  const ksfVersion = server.ksf_version ?? 1;
  const finished = api.finishLogin({
    clientLoginState: first.clientLoginState,
    loginResponse: server.login_response,
    password,
    keyStretching: ksfFor(ksfVersion),
  });
  if (!finished) return null;

  const session = await request(base, 'POST', '/_telium/v1/login/opaque/finish', {
    body: {
      login_id: server.login_id,
      finish_login_request: finished.finishLoginRequest,
      device_name: deviceName,
      mfa_code: mfaCode,
      reactivate,
    },
  });
  return {
    session,
    exportKey: finished.exportKey,
    recoveryWrapper: recoveryWrapperFromExportKey(finished.exportKey),
    ksfVersion,
  };
}

export async function enrollOpaque(home, password, upgradeToken) {
  const api = await client();
  const first = api.startRegistration({ password });
  const server = await home.post('/_telium/v1/auth/opaque/enroll/start', {
    upgrade_token: upgradeToken,
    registration_request: first.registrationRequest,
  });
  const finished = api.finishRegistration({
    clientRegistrationState: first.clientRegistrationState,
    registrationResponse: server.registration_response,
    password,
    keyStretching: ksfFor(KSF_CURRENT),
  });
  await home.post('/_telium/v1/auth/opaque/enroll/finish', {
    upgrade_token: upgradeToken,
    registration_record: finished.registrationRecord,
    ksf_version: KSF_CURRENT,
  });
  return {
    exportKey: finished.exportKey,
    recoveryWrapper: recoveryWrapperFromExportKey(finished.exportKey),
  };
}

export async function reauthenticateOpaque(
  home,
  password,
  { recoveryPublicKey = null, recoveryVaultCiphertext = null, replaceRecoveryKey = false } = {},
) {
  if (Boolean(recoveryPublicKey) !== Boolean(recoveryVaultCiphertext)) {
    throw new Error('Recovery-key enrollment needs both the public key and vault wrapper.');
  }
  const api = await client();
  const first = api.startLogin({ password });
  const server = await home.post('/_telium/v1/auth/opaque/reauth/start', {
    start_login_request: first.startLoginRequest,
  });
  const finished = api.finishLogin({
    clientLoginState: first.clientLoginState,
    loginResponse: server.login_response,
    password,
    keyStretching: ksfFor(server.ksf_version ?? 1),
  });
  if (!finished) throw new Error('That password was not accepted.');
  const proof = await home.post('/_telium/v1/auth/opaque/reauth/finish', {
    login_id: server.login_id,
    finish_login_request: finished.finishLoginRequest,
    ...(recoveryPublicKey ? {
      recovery_public_key: recoveryPublicKey,
      recovery_vault_ciphertext: recoveryVaultCiphertext,
      ...(replaceRecoveryKey ? { replace_recovery_key: true } : {}),
    } : {}),
  });
  return recoveryPublicKey ? proof : proof.reauth_token;
}

/// `vaultRewrap(newWrapper, copy)` is given the new password's wrapper and the recovery copy of the vault (`copy` is
/// null when the server holds none) and returns the vault ring sealed under the new wrapper, null for "nothing to
/// re-wrap", or `{ unopenable: true }` when the copy does not open under this recovery key (an account moved from
/// another server carries the source's copy). The first travels in the same request that replaces the password (I5);
/// the last is signed into that request as "reset anyway, leave the vault as it is", which the server accepts only for
/// the vault version that was read. All of it is inside the recovery-key signature.
export async function resetPasswordOpaque(
  base,
  user,
  recoveryKey,
  newPassword,
  deviceName,
  { vaultRewrap = null } = {},
) {
  const api = await client();
  const first = api.startRegistration({ password: newPassword });
  const server = await request(base, 'POST', '/_telium/v1/password-reset/opaque/start', {
    body: {
      user,
      registration_request: first.registrationRequest,
      signature: signPasswordResetStart(recoveryKey, user, first.registrationRequest),
    },
  });
  const ksfVersion = KSF_CURRENT;
  const finished = api.finishRegistration({
    clientRegistrationState: first.clientRegistrationState,
    registrationResponse: server.registration_response,
    password: newPassword,
    keyStretching: ksfFor(ksfVersion),
  });
  const recoveryWrapper = recoveryWrapperFromExportKey(finished.exportKey);
  const accountRecoveryWrapper = recoveryVaultWrapper(recoveryKey);
  const rewrapped = vaultRewrap
    ? await vaultRewrap(recoveryWrapper, server.vault?.independent_ciphertext
      ? { ciphertext: server.vault.independent_ciphertext, wrapper: accountRecoveryWrapper }
      : null)
    : null;
  const served = typeof server.vault?.version === 'number' ? server.vault.version : null;
  const unopenable = rewrapped?.unopenable && served !== null ? served : null;
  const vault = typeof rewrapped === 'string' && served !== null
    ? { vaultCiphertext: rewrapped, vaultVersion: served }
    : null;
  const signature = signPasswordReset(
    recoveryKey,
    server.user_id,
    server.reset_id,
    server.challenge,
    finished.registrationRecord,
    vault && { ciphertext: vault.vaultCiphertext, version: vault.vaultVersion },
    unopenable,
  );
  const session = await request(base, 'POST', '/_telium/v1/password-reset/opaque/finish', {
    body: {
      user: server.user_id,
      reset_id: server.reset_id,
      registration_record: finished.registrationRecord,
      ksf_version: ksfVersion,
      signature,
      device_name: deviceName,
      ...(vault ? { vault_ciphertext: vault.vaultCiphertext, vault_version: vault.vaultVersion } : {}),
      ...(unopenable !== null ? { vault_unopenable: unopenable } : {}),
    },
  });
  return {
    session,
    exportKey: finished.exportKey,
    recoveryWrapper,
    accountRecoveryWrapper,
    ksfVersion,
    vaultRewrapped: Boolean(vault),
    vaultUnopenable: unopenable !== null,
  };
}

/// Changes the password and re-wraps the vault under the new one in a single server write (I5). `current` is proven
/// with a fresh OPAQUE login (the reauth token is spent by the write); `vault` is `{ version, rewrap(newWrapper) }`,
/// where `rewrap` returns the ring sealed under the new wrapper. Nothing changes unless the one write is accepted, so
/// a failure at any earlier step, or a refused write, leaves the old password working with the old vault.
/// `ksfVersion` is the parameter set to register the new record with (default: the current one); the same call with the
/// same password moves an account to a newer set.
export async function changePasswordOpaque(
  home,
  currentPassword,
  newPassword,
  { vault = null, ksfVersion = KSF_CURRENT } = {},
) {
  const reauthToken = await reauthenticateOpaque(home, currentPassword);
  const api = await client();
  const first = api.startRegistration({ password: newPassword });
  const server = await home.post('/_telium/v1/auth/opaque/password/change/start', {
    registration_request: first.registrationRequest,
  });
  const finished = api.finishRegistration({
    clientRegistrationState: first.clientRegistrationState,
    registrationResponse: server.registration_response,
    password: newPassword,
    keyStretching: ksfFor(ksfVersion),
  });
  const recoveryWrapper = recoveryWrapperFromExportKey(finished.exportKey);
  const vaultCiphertext = vault ? await vault.rewrap(recoveryWrapper) : null;
  let answer;
  try {
    answer = await home.post('/_telium/v1/auth/opaque/password/change/finish', {
      reauth_token: reauthToken,
      registration_record: finished.registrationRecord,
      ksf_version: ksfVersion,
      ...(vaultCiphertext ? { vault_ciphertext: vaultCiphertext, vault_version: vault.version } : {}),
    });
  } catch (e) {
    // No answer is not a refusal: the write may have landed, and then the password this device holds is already gone.
    const status = e?.status;
    const unanswered = typeof status !== 'number' || status >= 500 || [408, 425, 429].includes(status);
    throw Object.assign(e, { finishUnanswered: unanswered });
  }
  return {
    exportKey: finished.exportKey,
    recoveryWrapper,
    ciphertext: vaultCiphertext,
    vaultVersion: typeof answer?.vault_version === 'number' ? answer.vault_version : null,
    ksfVersion,
  };
}
