import './browser-notification-inbox-runtime.js';

const runtime = globalThis.TeliumNotificationInboxRuntime;

function scope(sessionHome) {
  return runtime.requireScope({
    home_base: sessionHome?.base,
    user_id: sessionHome?.user_id,
    device_id: sessionHome?.device_id,
  });
}

export async function enrollBrowserNotificationInbox(homeApi, sessionHome) {
  const capabilities = await homeApi.capabilities();
  if (capabilities?.features?.native_notifications !== true) return false;

  const current = scope(sessionHome);
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
  );
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  let registration;
  try {
    registration = await homeApi.put('/_telium/v1/notifications/device', {
      algorithm: runtime.ALGORITHM,
      public_key: runtime.encode64(publicKey),
    });
  } catch (error) {
    if (error?.status === 404 || error?.status === 405) return false;
    throw error;
  }
  if (registration?.device_id !== current.device_id
    || registration?.algorithm !== runtime.ALGORITHM
    || !registration?.background_token) {
    throw new Error('Homeserver returned an invalid browser notification registration.');
  }
  try {
    await runtime.saveActiveRegistration({
      ...current,
      algorithm: runtime.ALGORITHM,
      private_key: pair.privateKey,
      background_token: registration.background_token,
    });
  } catch (error) {
    await homeApi.del('/_telium/v1/notifications/device').catch(() => {});
    throw error;
  }
  return true;
}

export async function disableBrowserNotificationInbox(homeApi, sessionHome) {
  const current = scope(sessionHome);
  await runtime.clearActiveRegistration(current).catch(() => {});
  try {
    await homeApi.del('/_telium/v1/notifications/device');
  } catch (error) {
    if (error?.status !== 404 && error?.status !== 405) throw error;
  }
}

export const notificationAad = runtime.notificationAad;
export const loadBrowserNotificationRegistration = runtime.loadActiveRegistration;
export const clearBrowserNotificationRegistration = runtime.clearActiveRegistration;
export const decryptInboxRow = runtime.decryptInboxRow;
export const notificationForInboxRow = runtime.notificationForInboxRow;
export const drainNotificationInbox = runtime.drainNotificationInbox;
