// Pure banner logic: nothing shows below `warn`, and only an admin (an admin-only route that answers 403 otherwise) ever sees it.

/// Dismissals always expire; shorter for more severe notices.
const SNOOZE_MS = {
  warn: 7 * 24 * 60 * 60 * 1000,
  urgent: 24 * 60 * 60 * 1000,
  security: 4 * 60 * 60 * 1000,
};

/// "Required" (stops working) is distinct from "newer exists"; the server decides via `detail.required`.
const REQUIRED_HEADLINE = {
  security: 'This server is missing a security release.',
  compatibility: 'This server must be updated to keep talking to other servers.',
};

export const DISMISS_KEY = 'telium.version.dismissed';

/// Folds in severity and release so a dismissal covers one specific situation.
export function noticeKey(status) {
  if (!status) return null;
  const severity = status.severity || 'quiet';
  const detail = status.detail || {};
  const latest = detail.latest ? String(detail.latest).slice(0, 12) : '';
  const security = detail.security ? 'security' : '';
  // A required update gets its own key and speaks up at once.
  const required = requiredReason(status) ? `required-${requiredReason(status)}` : '';
  return [severity, status.state, latest, security, required].filter(Boolean).join(':');
}

/// "security", "compatibility", or null; read from the server, never inferred.
export function requiredReason(status) {
  const reason = status?.detail?.required;
  return reason === 'security' || reason === 'compatibility' ? reason : null;
}

/// Tolerates anything in local storage; runs during first render.
export function readDismissal(storage) {
  try {
    const raw = storage?.getItem(DISMISS_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value.key !== 'string' || typeof value.until !== 'number') return null;
    return value;
  } catch {
    return null;
  }
}

export function writeDismissal(storage, key, until) {
  try {
    storage?.setItem(DISMISS_KEY, JSON.stringify({ key, until }));
  } catch {
    // If storage fails the notice reappears, which is the safe direction.
  }
}

/// `status` is the body of GET /_telium/v1/admin/version, or null if unreachable (including non-admins). Null means say nothing.
export function versionNotice(status, { now = Date.now(), dismissal = null } = {}) {
  if (!status) return null;

  const severity = status.severity;
  if (severity !== 'warn' && severity !== 'urgent') return null;

  const detail = status.detail || {};
  const required = requiredReason(status);
  const security = required === 'security' || (severity === 'urgent' && !!detail.security);
  const key = noticeKey(status);

  // A dismissal silences only the key it was made against.
  if (dismissal && dismissal.key === key && dismissal.until > now) return null;

  // Required update is as severe as a missing security release.
  const tone = security || required ? 'danger' : severity === 'urgent' ? 'warning' : undefined;
  const snooze = security || required ? SNOOZE_MS.security : SNOOZE_MS[severity];

  return {
    key,
    tone,
    required,
    headline: headlineFor(status, security),
    // Use the server's sentence; it knows the counts and dates.
    detail: status.message || '',
    snoozeMs: snooze,
    security,
  };
}

function headlineFor(status, security) {
  if (status.state === 'unknown') return 'This server cannot tell whether it is up to date.';
  if (security) return REQUIRED_HEADLINE.security;
  const required = requiredReason(status);
  if (required) return REQUIRED_HEADLINE[required];
  const missed = status.detail?.missed;
  const days = Math.floor((status.behind_ms || 0) / (24 * 60 * 60 * 1000));
  if (typeof missed === 'number' && missed > 0) {
    return `This server is ${missed} ${missed === 1 ? 'release' : 'releases'} behind, and has been for ${days} ${days === 1 ? 'day' : 'days'}.`;
  }
  return 'This server is behind the current release.';
}
