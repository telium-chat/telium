// Drops the two local caches (snapshot and settings mirror) without signing out or touching key material, and ends in a reload so the store doesn't write the suspect state straight back.

import * as snapshot from './snapshot.js';

const MIRROR_KEY = 'telium.sync.v1';
const STATE_KEY = 'telium.sync.state.v1';
const DRAFTS_KEY = 'drafts.v2';

/// Never touched: the session (clearing it is a sign-out), unsent DM drafts, OPAQUE server pins (a reset must not downgrade them), and identity pins (forgetting one turns a key change into silent acceptance).

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

/// Returns a summary so the UI doesn't claim success on faith; private mode may refuse every removal.
export async function resetLocalState({ reload = true } = {}) {
  const dropped = [];
  const kept = [];

  // The drafts row is lifted out whole, counter included: re-inserting it with a fresh counter would lose to or clobber another device's copy.
  const mirror = readJson(MIRROR_KEY);
  const drafts = mirror && typeof mirror === 'object' && !Array.isArray(mirror)
    ? mirror[DRAFTS_KEY]
    : null;
  const draftCount = drafts?.value && typeof drafts.value === 'object'
    ? Object.keys(drafts.value).length
    : 0;

  try {
    if (drafts) {
      localStorage.setItem(MIRROR_KEY, JSON.stringify({ [DRAFTS_KEY]: drafts }));
      kept.push(`${draftCount} draft${draftCount === 1 ? '' : 's'}`);
    } else {
      localStorage.removeItem(MIRROR_KEY);
    }
    localStorage.removeItem(STATE_KEY);
    dropped.push('settings mirrored on this device');
  } catch {
    // Storage is unavailable or full; nothing was mirrored, so nothing to report as dropped.
  }

  const cleared = await snapshot.clear().then(() => true).catch(() => false);
  if (cleared) dropped.push('the cached copy of guilds and recent messages');

  kept.push('your session', 'encrypted conversation keys');

  if (reload && typeof location !== 'undefined' && typeof location.reload === 'function') {
    location.reload();
  }
  return { dropped, kept };
}

export const RESET_EXPLANATION = 'This throws away the copy of your guilds, messages and settings that is '
  + 'kept on this device and fetches it again. You stay signed in, your unsent drafts stay where they are, '
  + 'and your encrypted conversations are not affected. Telium reloads when it is done.';
