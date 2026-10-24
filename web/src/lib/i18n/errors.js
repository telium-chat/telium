// Translates server refusals by error code.
// Ladder: `body.code` via `errors.<code>`, then the server's `message` verbatim, then a generic line by status class.
// `bareToken` bridges older homeservers that put a machine token in the message field; delete once none are reachable.

import { activeLocale } from './locale.js';
import { hasMessage } from './catalog/index.js';
import { t, tOrNull, list } from './index.js';

/// `HttpError.code` is the error class slug; the real code is `body.code`.
export function codeOf(error) {
  const body = error?.body;
  if (body && typeof body.code === 'string' && body.code) return body.code;
  if (typeof error?.code === 'string' && error.code && !isClassSlug(error.code)) return error.code;
  const token = bareToken(error?.body?.message || error?.message);
  return token;
}

const CLASS_SLUGS = new Set([
  'bad_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'try_again',
  'unprocessable_entity', 'too_large', 'rate_limited', 'internal',
  'bad_gateway', 'upstream_unavailable', 'gateway_timeout',
  'demoted', 'standby_read_only', 'shut_down',
]);

function isClassSlug(value) { return CLASS_SLUGS.has(value); }

function bareToken(message) {
  const text = String(message || '').trim();
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(text)) return null;
  return hasMessage(`errors.${text}`) ? text : null;
}

function detailOf(body) {
  if (!body || typeof body !== 'object') return {};
  const { error: _class, code: _code, message: _message, ...detail } = body;
  return detail;
}

/// `fetch` rejects with TypeError only; abandoned requests are AbortError/TimeoutError; anything else is our own code, whose sentence beats a guess.
export function isNetworkFailure(error) {
  return error instanceof TypeError
    || error?.name === 'AbortError'
    || error?.name === 'TimeoutError';
}

export function errorMessage(error, { fallbackKey = 'errors.generic' } = {}) {
  if (typeof error?.sentence === 'string' && error.sentence) return error.sentence;

  const code = codeOf(error);
  if (code) {
    const translated = tOrNull(`errors.${code}`, humanDetail(error));
    if (translated) return translated;
  }

  const served = error?.body?.message;
  if (typeof served === 'string' && served.trim() && !bareToken(served)) return served;

  const status = Number(error?.status) || 0;

  if (isNetworkFailure(error)) {
    // `navigator.onLine` true proves nothing (captive portals), but false is trustworthy.
    const offlineDevice = typeof navigator !== 'undefined' && navigator.onLine === false;
    return t(offlineDevice ? 'errors.offlineDevice' : 'errors.offline');
  }

  const byStatus = status >= 502 && status <= 504
    ? tOrNull('errors.status.gateway')
    : tOrNull(`errors.status.${status}`);
  if (byStatus) return byStatus;
  if (status >= 500) return t('errors.serverFault');

  const message = error?.message;
  if (typeof message === 'string' && message.trim() && !bareToken(message)) return message;
  return t(fallbackKey);
}

function humanDetail(error) {
  const detail = detailOf(error?.body);
  if (typeof detail.permission === 'string') {
    detail.permission = permissionName(detail.permission);
  }
  if (typeof detail.permissions === 'string') {
    detail.permissions = list(detail.permissions.split('|').map(permissionName));
  }
  if (typeof detail.retry_after === 'number') {
    detail.retry_after = Math.max(1, Math.ceil(detail.retry_after));
  }
  return detail;
}

export function permissionName(name) {
  return tOrNull(`perms.${String(name).toLowerCase()}.label`) || name;
}

export function closeMessage(code, reason) {
  // 4015: the server's sentence wins because it carries the incompatibility and its remedy.
  if (Number(code) === 4015 && reason) return String(reason);

  const translated = tOrNull(`errors.gateway.${code}`);
  if (translated) return translated;
  if (reason) return String(reason);
  return t('errors.gateway.unknown', { code });
}

export function errorSignature(error) {
  const parts = [];
  if (error?.status) parts.push(`HTTP ${error.status}`);
  if (error?.body?.error) parts.push(error.body.error);
  const code = codeOf(error);
  if (code) parts.push(code);
  parts.push(`locale=${activeLocale()}`);
  return parts.join(' ');
}
