// OPAQUE (RFC 9807) client auth; the password never leaves this module except in the explicit legacy fallback.

import * as opaque from '@serenity-kit/opaque';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { request } from './api.js';
import { unb64 } from './util.js';
import {
  generateAccountRecovery, recoveryVaultWrapper, signPasswordReset,
} from './account-recovery.js';

const te = new TextEncoder();
const RECOVERY_LABEL = te.encode('telium/dm-recovery-from-opaque-export/v1');

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

export async function registerOpaque(base, localpart, password, deviceName) {
  const api = await client();
  const accountRecovery = generateAccountRecovery();
  const first = api.startRegistration({ password });
  const server = await request(base, 'POST', '/_telium/v1/register/opaque/start', {
    body: {
      localpart,
      registration_request: first.registrationRequest,
    },
  });
  const finished = api.finishRegistration({
    clientRegistrationState: first.clientRegistrationState,
    registrationResponse: server.registration_response,
    password,
  });
  const session = await request(base, 'POST', '/_telium/v1/register/opaque/finish', {
    body: {
      localpart,
      registration_record: finished.registrationRecord,
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

  const finished = api.finishLogin({
    clientLoginState: first.clientLoginState,
    loginResponse: server.login_response,
    password,
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
  });
  await home.post('/_telium/v1/auth/opaque/enroll/finish', {
    upgrade_token: upgradeToken,
    registration_record: finished.registrationRecord,
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

export async function resetPasswordOpaque(
  base,
  user,
  recoveryKey,
  newPassword,
  deviceName,
) {
  const api = await client();
  const first = api.startRegistration({ password: newPassword });
  const server = await request(base, 'POST', '/_telium/v1/password-reset/opaque/start', {
    body: {
      user,
      registration_request: first.registrationRequest,
    },
  });
  const finished = api.finishRegistration({
    clientRegistrationState: first.clientRegistrationState,
    registrationResponse: server.registration_response,
    password: newPassword,
  });
  const signature = signPasswordReset(
    recoveryKey,
    server.user_id,
    server.reset_id,
    server.challenge,
    finished.registrationRecord,
  );
  const session = await request(base, 'POST', '/_telium/v1/password-reset/opaque/finish', {
    body: {
      user: server.user_id,
      reset_id: server.reset_id,
      registration_record: finished.registrationRecord,
      signature,
      device_name: deviceName,
    },
  });
  return {
    session,
    exportKey: finished.exportKey,
    recoveryWrapper: recoveryWrapperFromExportKey(finished.exportKey),
    accountRecoveryWrapper: recoveryVaultWrapper(recoveryKey),
  };
}
