import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localNotificationsSupported,
  notificationPermission,
  requestNotificationPermission,
  showLocalNotification,
} from '../lib/notifications.js';

const originalNotification = globalThis.Notification;

afterEach(() => {
  if (originalNotification === undefined) delete globalThis.Notification;
  else globalThis.Notification = originalNotification;
  delete window.__TAURI__;
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

function installNotification(permission = 'granted') {
  const made = [];
  class FakeNotification {
    static permission = permission;

    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = 'granted';
      return 'granted';
    });

    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.listeners = new Map();
      this.close = vi.fn();
      made.push(this);
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }
  }
  globalThis.Notification = FakeNotification;
  return { FakeNotification, made };
}

describe('local notifications', () => {
  it('reports unsupported when neither a browser API nor a native host exists', async () => {
    delete globalThis.Notification;
    expect(localNotificationsSupported()).toBe(false);
    expect(await notificationPermission()).toBe('unsupported');
  });

  it('requests browser permission only when the settings UI asks for it', async () => {
    const { FakeNotification } = installNotification('default');
    expect(await notificationPermission()).toBe('default');
    expect(await requestNotificationPermission()).toBe('granted');
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it('shows a browser notification and routes its click', async () => {
    const { made } = installNotification();
    const onClick = vi.fn();

    expect(await showLocalNotification({
      title: '#general',
      body: 'carol: hello',
      tag: 'c1',
      onClick,
    })).toBe(true);

    expect(made).toHaveLength(1);
    expect(made[0].title).toBe('#general');
    expect(made[0].options).toMatchObject({ body: 'carol: hello', tag: 'c1' });

    made[0].listeners.get('click')();
    expect(onClick).toHaveBeenCalledOnce();
    expect(made[0].close).toHaveBeenCalledOnce();
  });

  it('does not construct a notification before permission is granted', async () => {
    const { made } = installNotification('denied');
    expect(await showLocalNotification({ title: 'Nope' })).toBe(false);
    expect(made).toHaveLength(0);
  });
});
