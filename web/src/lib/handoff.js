// The browser side of the guided account/guild move. The secret lives in the URL fragment and is taken out of the address bar at once.

export const HANDOFF_PATH = '/receive-move';
const KEY = 'telium.pending-handoff.v1';
const TTL_MS = 30 * 60 * 1000;

const SERVER_NAME = /^[a-z0-9.-]+(:[0-9]{1,5})?$/;
const GUILD_ID = /^[0-9A-Za-z]{10,64}$/;
const NAME_MAX = 100;

export function serverName(name) {
  return String(name || '').trim().toLowerCase().replace(/\.$/, '');
}

export function sameServer(a, b) {
  const x = serverName(a);
  return x !== '' && x === serverName(b);
}

export function parseHandoff(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const id = params.get('h') || '';
  const secret = params.get('s') || '';
  const source = serverName(params.get('from'));
  const destination = serverName(params.get('to'));
  const sourceId = (params.get('id') || '').trim();
  if (!/^[0-9A-Za-z]{10,40}$/.test(id)) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(secret)) return null;
  if (!SERVER_NAME.test(source) || !SERVER_NAME.test(destination)) return null;
  if (source === destination) return null;
  if (params.get('k') === 'guild') {
    if (!GUILD_ID.test(sourceId)) return null;
    const name = (params.get('n') || '').trim().slice(0, NAME_MAX);
    return { id, secret, source, source_id: sourceId, destination, subject_type: 'guild', name };
  }
  const match = /^@([^:\s]+):(\S+)$/.exec(sourceId);
  if (!match || !sameServer(match[2], source)) return null;
  return { id, secret, source, source_id: sourceId, destination };
}

/// `client` comes only from the destination's discovery document; non-http(s) is refused.
export function handoffLink(client, handoff) {
  let base;
  try { base = new URL(client); } catch { base = null; }
  if (!base || (base.protocol !== 'https:' && base.protocol !== 'http:')) {
    throw new Error('The destination does not publish a usable web address.');
  }
  const fragment = new URLSearchParams({
    h: handoff.id,
    s: handoff.secret,
    from: handoff.source,
    id: handoff.source_id,
    to: handoff.destination,
  });
  if (handoff.subject_type === 'guild') {
    fragment.set('k', 'guild');
    if (handoff.name) fragment.set('n', String(handoff.name).slice(0, NAME_MAX));
  }
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${HANDOFF_PATH}#${fragment}`;
}

export function captureHandoff(win = window) {
  if (win.location.pathname !== HANDOFF_PATH) return null;
  const handoff = parseHandoff(win.location.hash);
  win.history.replaceState(null, '', '/');
  if (handoff) {
    try { win.sessionStorage.setItem(KEY, JSON.stringify({ ...handoff, at: Date.now() })); } catch { /* private mode */ }
  }
  return handoff;
}

export function pendingHandoff(storage = globalThis.sessionStorage) {
  let raw = null;
  try { raw = storage?.getItem(KEY); } catch { raw = null; }
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw);
    if (!kept || Date.now() - kept.at > TTL_MS) {
      clearHandoff(storage);
      return null;
    }
    return kept;
  } catch {
    clearHandoff(storage);
    return null;
  }
}

export function clearHandoff(storage = globalThis.sessionStorage) {
  try { storage?.removeItem(KEY); } catch { /* nothing to clear */ }
}
