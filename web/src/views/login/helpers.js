import { parseAddress, fullHandle } from '../../lib/account-address.js';
import { isPortalHost, normalizeHomeserver, prettyHost } from '../../lib/homeserver.js';
import { isTauriRuntime } from '../../lib/platform.js';

export const PENDING_RECOVERY_KEY = 'telium.pending-account-recovery.v1';

export const FLAGSHIP_HOME = 'https://telium.chat';

export const DEPTH = {
  server: 0, start: 1, find: 1, recover: 2, identity: 2, password: 3, reset: 3, key: 4,
};

export const DOTS = ['start', 'identity', 'password'];
export const DESKTOP_DOTS = ['find', 'identity', 'password'];

const LAST_HOME = 'telium.lastHome';

export const RECOMMENDATION_WAIT_MS = 5000;

export const settleWithin = (promise, ms, fallback) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(fallback), ms);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    () => { clearTimeout(timer); resolve(fallback); },
  );
});

export function rememberHome(home) {
  try { sessionStorage.setItem(LAST_HOME, home); } catch { /* keep going */ }
  if (!isTauriRuntime()) return;
  try { localStorage.setItem(LAST_HOME, home); } catch { /* keep going */ }
}

function readHome(storage) {
  try { return normalizeHomeserver(storage.getItem(LAST_HOME)); } catch { return null; }
}

export function knownServer(handoff) {
  if (handoff) return normalizeHomeserver(handoff.destination) || handoff.destination;
  const remembered = readHome(sessionStorage)
    || (isTauriRuntime() ? readHome(localStorage) : null);
  if (remembered) return remembered;
  // The portal is a static site: its own origin is not anybody's account home,
  // so signup there starts from nothing and takes a recommendation instead.
  if (isPortalHost()) return '';
  return isTauriRuntime() ? FLAGSHIP_HOME : location.origin;
}

export function looksAddressable(value) {
  const host = prettyHost(value).split('/')[0].split(':')[0];
  if (!host) return false;
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)
    && /\.[a-z]{2,}$/i.test(host);
}

export function accountId(typed, serverName) {
  const parsed = parseAddress(typed);
  if (parsed.kind === 'handle') return fullHandle(parsed.user, parsed.host);
  if (parsed.kind === 'name') return fullHandle(parsed.user, serverName);
  return null;
}
