
import { isElectronRuntime, isTauriRuntime } from './platform.js';

function browserNotificationApi() {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  return window.Notification;
}

async function invokeTauri(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

export function localNotificationsSupported() {
  return isElectronRuntime() || isTauriRuntime() || Boolean(browserNotificationApi());
}

export async function notificationPermission() {
  if (isElectronRuntime()) {
    try {
      return await window.teliumDesktop.notificationPermission();
    } catch {
      return 'unsupported';
    }
  }
  if (isTauriRuntime()) {
    try {
      return await invokeTauri('notification_permission');
    } catch {
      return 'unsupported';
    }
  }
  return browserNotificationApi()?.permission || 'unsupported';
}

/// Must be called from a user gesture on the web.
export async function requestNotificationPermission() {
  if (isElectronRuntime()) return window.teliumDesktop.requestNotificationPermission();
  if (isTauriRuntime()) return invokeTauri('request_notification_permission');
  const api = browserNotificationApi();
  if (!api) return 'unsupported';
  return api.requestPermission();
}

/// Local only; background push is separate.
export async function showLocalNotification({
  title,
  body = '',
  tag,
  onClick,
}) {
  if ((await notificationPermission()) !== 'granted') return false;

  if (isElectronRuntime()) {
    await window.teliumDesktop.showNotification({
      title: String(title || 'Telium'),
      body: String(body || ''),
    });
    return true;
  }

  if (isTauriRuntime()) {
    await invokeTauri('show_native_notification', {
      title: String(title || 'Telium'),
      body: String(body || ''),
    });
    return true;
  }

  const Api = browserNotificationApi();
  if (!Api) return false;
  const notification = new Api(String(title || 'Telium'), {
    body: String(body || ''),
    tag: tag ? String(tag) : undefined,
  });
  if (onClick) {
    notification.addEventListener('click', () => {
      try { window.focus(); } catch { /* the browser may refuse focus */ }
      onClick();
      notification.close();
    }, { once: true });
  }
  return true;
}
