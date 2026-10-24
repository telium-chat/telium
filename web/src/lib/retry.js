// Allowlist of requests that may be sent twice. Each entry names the server-side mechanism that makes a repeat harmless; if that changes, the entry must go.

import { sleep as defaultSleep } from './util.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/// `POST /_telium/v1/conversations` is absent on purpose: it also creates group chats, and this function cannot see the body `kind`.
const REPEATABLE = [
  {
    method: 'POST',
    pattern: /^\/_telium\/v1\/channels\/[^/]+\/ack$/,
    why: 'the read cursor is an upsert that takes MAX(old, new), so a repeat cannot move it backwards or forwards twice',
  },
  {
    method: 'POST',
    pattern: /^\/_telium\/v1\/channels\/[^/]+\/typing$/,
    why: 'a typing indicator is ephemeral and expires on its own; a duplicate is invisible even in principle',
  },
  {
    method: 'PUT',
    pattern: /^\/_telium\/v1\/messages\/[^/]+\/reactions\/[^/]+\/@me$/,
    why: 'adding a reaction inserts ON CONFLICT DO NOTHING, and the row is keyed by (message, emoji, user)',
  },
  {
    method: 'DELETE',
    pattern: /^\/_telium\/v1\/messages\/[^/]+\/reactions\/[^/]+\/@me$/,
    why: 'removing a reaction deletes by that same key and answers the same way whether or not a row was there',
  },
  {
    method: 'PUT',
    pattern: /^\/_telium\/v1\/channels\/[^/]+\/pins\/[^/]+$/,
    why: 'pinning inserts ON CONFLICT DO NOTHING against (channel, message)',
  },
  {
    method: 'DELETE',
    pattern: /^\/_telium\/v1\/channels\/[^/]+\/pins\/[^/]+$/,
    why: 'unpinning deletes by (channel, message) and does not mind the row being gone already',
  },
  {
    method: 'PUT',
    pattern: /^\/_telium\/v1\/sync\/[^/]+$/,
    why: 'a sync value is a whole-blob upsert, so the second write stores the same bytes the first one did',
  },
  {
    method: 'PUT',
    pattern: /^\/_telium\/v1\/conversations\/[^/]+\/notifications$/,
    why: 'muting sets a flag to a value the caller supplied rather than toggling it',
  },
];

/// `key(body)` returns the key or null; null means not repeatable.
const KEYED = [
  {
    method: 'POST',
    pattern: /^\/_telium\/v1\/channels\/[^/]+\/messages$/,
    key: (body) => (typeof body?.nonce === 'string' ? body.nonce : null),
    why: 'the send carries a nonce, and the server answers a repeat of it with the message the '
      + 'first attempt made rather than writing a second one (server/src/sendonce.rs)',
  },
  {
    method: 'POST',
    pattern: /^\/_telium\/v1\/conversations\/[^/]+\/messages$/,
    key: (body) => (typeof body?.frame_id === 'string' && body.frame_id ? body.frame_id : null),
    why: 'the frame carries a frame id, and the sequencer answers a repeat of it with the frame '
      + 'it already ordered rather than ordering a second (server/src/routes/dm.rs, sequence_inner)',
  },
];

export function repeatable(method, path, body = null) {
  const verb = String(method || '').toUpperCase();
  if (SAFE_METHODS.has(verb)) return 'reads have no effect';
  const route = String(path || '').split('?')[0];
  const entry = REPEATABLE.find((e) => e.method === verb && e.pattern.test(route));
  if (entry) return entry.why;
  const keyed = KEYED.find((e) => e.method === verb && e.pattern.test(route));
  return keyed && keyed.key(body) ? keyed.why : null;
}

/// Thrown `fetch` or 502/503/504. 500 is excluded: the server ran and we can't tell how far. Tests a numeric `status` rather than `HttpError` so this module imports nothing (`api.js` imports it).
export function transient(error) {
  if (error && typeof error.status === 'number') {
    return error.status === 502 || error.status === 503 || error.status === 504;
  }
  // A `fetch` rejection's message varies by browser and locale; test for no status.
  return error instanceof Error;
}

const ATTEMPTS = 2;
const BACKOFF_MS = [250, 900];

/// `send` is a function because the token may be renewed between attempts.
export async function withRetry(method, path, send, { sleep = defaultSleep, body = null } = {}) {
  const why = repeatable(method, path, body);
  let attempt = 0;
  for (;;) {
    try {
      return await send();
    } catch (e) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (!why || offline || attempt >= ATTEMPTS || !transient(e)) throw e;
      await sleep(BACKOFF_MS[attempt]);
      attempt += 1;
    }
  }
}
