// `t` and not `useT()`: called from event handlers and a bridge call, outside any React tree. Nothing re-renders on a language change; a notification is built once.
import { t } from './i18n/index.js';

export const NOTIFICATION_PREVIEW = Object.freeze({
  FULL: 'full',
  SENDER: 'sender',
  HIDDEN: 'hidden',
});

export function normalizeNotificationPreview(value) {
  return Object.values(NOTIFICATION_PREVIEW).includes(value)
    ? value
    : NOTIFICATION_PREVIEW.FULL;
}

/**
 * Redact a system-notification title/body at the last possible moment. `title`, `body` and `senderTitle` arrive assembled and pass through untouched; the two strings supplied here are Telium speaking, from `notifications.system.*`. `genericBody` defaults through `t()` so it follows later language changes.
 */
export function notificationPreview(
  mode,
  {
    title,
    body,
    senderTitle = title,
    genericBody = t('notifications.system.generic'),
  },
) {
  // Resolved once so `hidden` and `sender` show the same withheld body.
  const appName = () => t('notifications.system.appName');
  const withheld = () => String(genericBody || t('notifications.system.generic'));
  switch (normalizeNotificationPreview(mode)) {
    case NOTIFICATION_PREVIEW.SENDER:
      return {
        title: String(senderTitle || appName()),
        body: withheld(),
      };
    case NOTIFICATION_PREVIEW.HIDDEN:
      return {
        title: appName(),
        body: withheld(),
      };
    default:
      return {
        title: String(title || appName()),
        body: String(body || ''),
      };
  }
}

/**
 * Words shown instead of the message in `sender` or `hidden` mode.
 *
 * Twin of `AndroidNotificationPreview.genericBody` (web/src-tauri/gen/android/app/src/main/java/chat/telium/desktop/AndroidNotificationPreview.kt); keep them in step by hand, since they redact at boundaries that cannot share code. The unknown-kind fallback differs on purpose: here it is a bug, so it is neutral; on Android a stale APK more likely meets a new message kind.
 */
export function genericNotificationBody(kind) {
  switch (kind) {
    case 'encrypted_message':
      return 'Encrypted message';
    case 'mention':
      return 'New mention';
    case 'reply':
      return 'New reply';
    case 'call':
    case 'incoming_call':
      return 'Incoming call';
    case 'account':
    case 'account_security':
    case 'security':
    case 'migration':
      return 'Account alert';
    default:
      return 'New notification';
  }
}
