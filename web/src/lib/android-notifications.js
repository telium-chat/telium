import { Api } from './api.js';
import { isMobileTauri } from './platform.js';
import { normalizeNotificationPreview } from './notification-preview.js';
import { sleep } from './util.js';

const ALGORITHM = 'P256-HKDF-SHA256-A256GCM';
let requestSerial = 0;

function bridge() {
  if (!isMobileTauri || typeof window === 'undefined') return null;
  return window.teliumAndroidNotificationBridge || null;
}

function scope(sessionHome) {
  if (!sessionHome?.base || !sessionHome?.user_id || !sessionHome?.device_id) {
    throw new Error('Android notification enrollment needs the current Telium device.');
  }
  return {
    home_base: sessionHome.base,
    user_id: sessionHome.user_id,
    device_id: sessionHome.device_id,
  };
}

function nativeRequest(payload, timeoutMs = 5000) {
  const host = bridge();
  if (!host?.postMessage || !host?.addEventListener) {
    return Promise.reject(new Error('Android notification security bridge is unavailable.'));
  }

  const requestId = `notification-${++requestSerial}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      host.removeEventListener?.('message', onMessage);
      fn(value);
    };
    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (message.request_id !== requestId) return;
      if (!message.ok) {
        finish(reject, new Error(message.message || 'Android notification storage failed.'));
        return;
      }
      finish(resolve, message);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Android did not respond to the notification request.')),
      timeoutMs,
    );
    host.addEventListener('message', onMessage);
    try {
      host.postMessage(JSON.stringify({ ...payload, request_id: requestId }));
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function androidNotificationBridgeAvailable() {
  const host = bridge();
  return Boolean(host?.postMessage && host?.addEventListener);
}


async function waitForAndroidStatus(sessionHome, predicate, timeoutMs, failureMessage) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await androidNotificationStatus(sessionHome);
    if (predicate(last)) return last;
    await sleep(400);
  }
  const error = new Error(failureMessage);
  error.androidNotificationStatus = last;
  throw error;
}

/// The private key stays in Android; JS sees only the public half, and the background token goes straight to Keystore storage.
export async function enrollAndroidNotifications(homeApi, sessionHome, previewMode = 'full') {
  if (!androidNotificationBridgeAvailable()) return { supported: false };

  // An older server answers the new PUT route with a misleading 405, so check capability first.
  const capabilities = await homeApi.capabilities();
  if (capabilities?.features?.native_notifications !== true) {
    throw new Error(
      'This homeserver does not support Android notification enrollment yet. '
      + 'Update the homeserver to a version with native notification support.',
    );
  }

  const device = scope(sessionHome);
  const prepared = await nativeRequest({ op: 'prepare', ...device });
  if (prepared.algorithm !== ALGORITHM || !prepared.public_key) {
    throw new Error('Android returned an unsupported notification key.');
  }

  let registration;
  try {
    registration = await homeApi.put('/_telium/v1/notifications/device', {
      algorithm: prepared.algorithm,
      public_key: prepared.public_key,
    });
  } catch (error) {
    // Also covers a stale server between the capability read and the write, or a proxy routing to an old backend.
    if (error?.status === 404 || error?.status === 405) {
      throw new Error(
        'This homeserver does not support Android notification enrollment yet. '
        + 'Update the homeserver to a version with native notification support.',
      );
    }
    throw error;
  }
  if (registration?.device_id !== sessionHome.device_id) {
    throw new Error('Homeserver registered a different notification device.');
  }
  if (registration?.algorithm !== ALGORITHM || !registration?.background_token) {
    throw new Error('Homeserver returned an invalid notification registration.');
  }

  await nativeRequest({
    op: 'store_registration',
    ...device,
    background_token: registration.background_token,
  });
  await setAndroidNotificationPreview(sessionHome, previewMode);

  const { public_key: vapidPublicKey } = await homeApi.vapidKey();
  if (!vapidPublicKey) throw new Error('Homeserver did not publish a VAPID key.');
  const wake = await nativeRequest({
    op: 'enable_wake',
    ...device,
    vapid_public_key: vapidPublicKey,
  }, 60_000);

  if (!wake.wake_configured) {
    throw new Error('Android did not configure a push distributor.');
  }

  // register() only requests registration; not ready until onNewEndpoint uploaded the endpoint.
  await waitForAndroidStatus(
    sessionHome,
    (status) => status.wake_endpoint_registered,
    30_000,
    'Android selected a push distributor, but no wake endpoint reached the homeserver.',
  );

  await homeApi.post('/_telium/v1/notifications/test-wake', {});
  const verified = await waitForAndroidStatus(
    sessionHome,
    (status) => status.wake_verified,
    20_000,
    'The push endpoint was registered, but a test wake did not reach this phone. '
      + 'Background notifications are not ready yet.',
  );

  // Never return the background token; keep it out of WebView state.
  return {
    supported: true,
    registered: true,
    wake_configured: true,
    wake_endpoint_registered: true,
    wake_verified: true,
    wake_received_at: verified.wake_received_at,
    algorithm: ALGORITHM,
  };
}

export async function androidNotificationStatus(sessionHome) {
  if (!androidNotificationBridgeAvailable()) {
    return {
      supported: false,
      prepared: false,
      registered: false,
      preview_mode: 'full',
      dm_notifications: true,
      wake_configured: false,
      wake_endpoint_registered: false,
      wake_verified: false,
      wake_received_at: 0,
    };
  }
  const result = await nativeRequest({ op: 'status', ...scope(sessionHome) });
  return {
    supported: true,
    prepared: Boolean(result.prepared),
    registered: Boolean(result.registered),
    preview_mode: normalizeNotificationPreview(result.preview_mode),
    dm_notifications: result.dm_notifications !== false,
    wake_configured: Boolean(result.wake_configured),
    wake_distributor_ready: Boolean(result.wake_distributor_ready),
    wake_endpoint_registered: Boolean(result.wake_endpoint_registered),
    wake_verified: Boolean(result.wake_verified),
    wake_received_at: Number(result.wake_received_at) || 0,
  };
}

export async function setAndroidNotificationPreview(sessionHome, mode) {
  if (!androidNotificationBridgeAvailable() || !sessionHome) return false;
  const result = await nativeRequest({
    op: 'set_preview',
    ...scope(sessionHome),
    mode: normalizeNotificationPreview(mode),
  });
  return normalizeNotificationPreview(result.preview_mode);
}

/// Android applies this after decrypting the DM hint, so no server learns the preference.
export async function setAndroidDmNotifications(sessionHome, enabled) {
  if (!androidNotificationBridgeAvailable() || !sessionHome) return false;
  const result = await nativeRequest({
    op: 'set_dm_notifications',
    ...scope(sessionHome),
    enabled: enabled !== false,
  });
  return result.dm_notifications !== false;
}

export async function clearAndroidNotificationSecrets(sessionHome) {
  if (!androidNotificationBridgeAvailable() || !sessionHome) return false;
  await nativeRequest({ op: 'clear', ...scope(sessionHome) });
  return true;
}

/// Revokes on the homeserver first, then destroys native secrets unconditionally, even if offline.
export async function retireAndroidNotifications(sessionHome) {
  if (!androidNotificationBridgeAvailable() || !sessionHome) return false;

  try {
    const home = new Api({
      base: sessionHome.base,
      token: sessionHome.token,
      domain: sessionHome.domain,
    });
    await home.revokeDevice(sessionHome.device_id).catch(() => {});
  } finally {
    await clearAndroidNotificationSecrets(sessionHome).catch(() => {});
  }
  return true;
}
