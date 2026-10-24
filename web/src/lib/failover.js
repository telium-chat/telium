// Falling back to a warm standby: the address is learned while the primary is healthy and cached, the standby answers the same API at a different base, and it refuses writes and says how far behind it is.

import { discover, request } from './api.js';
import { t } from './i18n/index.js';

/// Long enough that a reload, a laptop lid or one dropped socket never trips it.
export const FALLBACK_AFTER_MS = 20_000;

export const PROBE_EVERY_MS = 15_000;

/// Called while the primary is up and cached with the session; at failure time the primary can't be asked.
export async function learnFallback(base) {
  try {
    const doc = await request(base, 'GET', '/.well-known/telium/server');
    const fallback = doc?.fallback;
    if (!fallback?.standby || !fallback?.path) return null;
    // `authority` is deliberately not cached: where the standby lives is stable, who is in charge changes.
    return { standby: fallback.standby, path: fallback.path, authority: doc?.authority || null };
  } catch {
    return null;
  }
}

/// The standby is named by domain so the operator can move it without stale cached addresses.
export async function resolveStandby(fallback, origin) {
  const doc = await discover(fallback.standby);
  const base = `${doc.api.replace(/\/$/, '')}${fallback.path}`;
  const status = await request(doc.api, 'GET', `/_telium/v1/failover/status/${origin}`);
  return {
    origin,
    standby: doc.server_name || fallback.standby,
    api: doc.api,
    base,
    gateway: `${base.replace(/^http/, 'ws')}/gateway/v1`,
    status,
  };
}

/// One request answers both "up" and "still in charge": a server replaced while away answers health checks and loses every write. Uses the cheapest endpoint, not the one the session lives behind.
export async function primaryStatus(base) {
  try {
    const doc = await request(base, 'GET', '/_telium/v1/health');
    return { alive: doc?.ok === true, authority: doc?.authority || null };
  } catch {
    return { alive: false, authority: null };
  }
}

export async function primaryIsHome(base, domain) {
  const { alive, authority } = await primaryStatus(base);
  return alive && (!authority || authority === domain);
}

/// A copy and the moved server look identical from inside; one refuses writes, the other works.
export function describeFallback(fallback, home) {
  const promoted = fallback?.status?.read_only === false;
  if (promoted) {
    return t('shell.fallback.promoted', { home, standby: fallback.standby });
  }
  return t('shell.fallback.readOnly', {
    home,
    standby: fallback?.standby,
    lag: describeLag(fallback?.status?.behind_ms),
  });
}

/// Rounded down to a unit somebody can act on.
export function describeLag(behindMs) {
  // Plural arms live in the catalogue; the only judgement here is which unit a reader can act on.
  if (behindMs === null || behindMs === undefined) return t('shell.fallback.lagUnknown');
  const secs = Math.max(0, Math.round(behindMs / 1000));
  if (secs < 90) return t('shell.fallback.lagSeconds', { count: secs });
  const mins = Math.round(secs / 60);
  if (mins < 90) return t('shell.fallback.lagMinutes', { count: mins });
  const hours = Math.round(mins / 60);
  return t('shell.fallback.lagHours', { count: hours });
}
