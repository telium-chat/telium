
import { b64url, unb64 } from './util.js';
import { isNativeShell } from './platform.js';
import { onLocaleChange, t } from './i18n/index.js';
import {
  disableBrowserNotificationInbox,
  enrollBrowserNotificationInbox,
} from './browser-notification-inbox.js';

export const workerSupported = !isNativeShell
  && typeof navigator !== 'undefined'
  && 'serviceWorker' in navigator;

export const supported = workerSupported
  && typeof window !== 'undefined'
  && 'PushManager' in window
  && 'Notification' in window;

let registration = null;

export async function register(onUpdate) {
  if (!workerSupported) return null;
  // A stale production worker would serve an old cached bundle to the dev server.
  if (!import.meta.env.PROD) await unregisterAll();
  try {
    registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: import.meta.env.PROD ? 'imports' : 'none',
    });
  } catch {
    return null;
  }
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // `controller` is null on first install, which is not an update.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        onUpdate?.(() => { worker.postMessage('skip-waiting'); });
      }
    });
  });
  watchLanguage();
  return registration;
}

/// Strings are resolved here because the worker cannot read the catalogue.
function swStrings() {
  return {
    title: t('notifications.system.appName'),
    migration: t('notifications.wake.migration'),
    activity: t('notifications.wake.activity'),
  };
}

/// Uses `controller`, which on first install exists only a tick after `activate`.
let watching = false;
function watchLanguage() {
  if (watching) return;
  watching = true;
  const post = () => {
    navigator.serviceWorker.ready
      .then((reg) => reg.active?.postMessage({ type: 'strings', strings: swStrings() }))
      .catch(() => {});
  };
  post();
  onLocaleChange(post);
}

export async function unregisterAll() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
  } catch { /* a browser that will not say is a browser with nothing to say */ }
}

export function onNotificationNavigate(handler) {
  if (!workerSupported) return () => {};
  const listener = (event) => {
    if (event.data?.type === 'navigate') handler(event.data);
  };
  navigator.serviceWorker.addEventListener('message', listener);
  return () => navigator.serviceWorker.removeEventListener('message', listener);
}

async function ready() {
  if (registration) return registration;
  if (!workerSupported) return null;
  registration = await navigator.serviceWorker.getRegistration('/');
  return registration || null;
}

export async function currentSubscription() {
  if (!supported) return null;
  const reg = await ready();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export async function subscribe(home, sessionHome) {
  if (!supported) throw new Error('web push is not supported');
  const reg = await ready();
  if (!reg) throw new Error('no service worker is registered');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(`notification permission: ${permission}`);

  const { public_key: publicKey } = await home.vapidKey();
  let sub = await reg.pushManager.getSubscription();
  // A subscription from a different VAPID key can never be pushed to; drop it.
  if (sub && b64url(new Uint8Array(sub.options.applicationServerKey || [])) !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: unb64(publicKey),
    });
  }
  const keys = sub.toJSON().keys || {};
  let nativeInbox = false;
  try {
    nativeInbox = await enrollBrowserNotificationInbox(home, sessionHome);
  } catch {
    nativeInbox = false;
  }
  const registration = {
    kind: nativeInbox ? 'native-webpush' : 'webpush',
    endpoint: sub.endpoint,
    p256dh: keys.p256dh?.replace(/=+$/, ''),
    auth: keys.auth?.replace(/=+$/, ''),
  };
  try {
    await home.push(registration);
  } catch (error) {
    if (!nativeInbox) throw error;
    await disableBrowserNotificationInbox(home, sessionHome).catch(() => {});
    await home.push({ ...registration, kind: 'webpush' });
  }
  return sub;
}

/// Server copy is matched by endpoint so other browsers stay subscribed.
export async function unsubscribe(home, sessionHome) {
  const sub = await currentSubscription();
  if (sub) {
    const { endpoint } = sub;
    await sub.unsubscribe();
    const { subscriptions = [] } = await home.pushSubscriptions().catch(() => ({}));
    await Promise.all(
      subscriptions
        .filter((s) => s.endpoint === endpoint)
        .map((s) => home.unpush(s.id).catch(() => {})),
    );
  }
  await disableBrowserNotificationInbox(home, sessionHome);
}
