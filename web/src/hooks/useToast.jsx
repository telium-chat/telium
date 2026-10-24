import { Toasty, createKumoToastManager } from '@cloudflare/kumo/components/toast';
import { EmojiText } from '../components/Twemoji.jsx';
import { t } from '../lib/i18n/index.js';
import { errorMessage } from '../lib/i18n/errors.js';

export const toasts = createKumoToastManager();

function titleOf(message) {
  return <EmojiText>{String(message)}</EmojiText>;
}

const SAME_FAILURE_MS = 5000;
const recent = new Map();

export function toast(message, { error = false, ms = 4200 } = {}) {
  if (error) {
    const line = String(message);
    const now = Date.now();
    for (const [said, at] of recent) {
      if (now - at > SAME_FAILURE_MS) recent.delete(said);
    }
    if (recent.has(line)) return;
    recent.set(line, now);
  }
  toasts.add({
    title: titleOf(message),
    variant: error ? 'error' : 'default',
    timeout: error ? 0 : ms,
  });
}

export function ok(message) {
  toasts.add({ title: titleOf(message), variant: 'success', timeout: 3200 });
}

export function reportError(e, context) {
  const message = errorMessage(e);
  toast(context ? t('errors.context', { context, message }) : message, { error: true });
  return message;
}

export function ToastHost() {
  return <Toasty toastManager={toasts} />;
}
