// Body of a DM `rejoin` frame; kept out of mls.js so the gateway doesn't pull in the MLS engine.
//
// `key:<leaf signature key>`, optionally followed by `;seen:<seq>`: the newest frame the asking device had walked. A device
// that has seen every change to the tree and still has no group holds no state for the leaf it has there, so whoever answers
// replaces that leaf instead of taking its presence for an answer already given (`Mls.catchUp`). Older readers see no key in
// a body with the suffix and fall back to judging by device id, which is what they did before.

const KEY = /^[A-Za-z0-9+/]{20,100}={0,2}$/;

export function rejoinBody(key, seen = 0) {
  return Number.isInteger(seen) && seen > 0 ? `key:${key};seen:${seen}` : `key:${key}`;
}

function parts(body) {
  if (typeof body !== 'string' || !body.startsWith('key:')) return null;
  const [key, ...rest] = body.slice(4).split(';');
  if (!KEY.test(key)) return null;
  let seen = null;
  for (const part of rest) {
    const m = /^seen:(\d{1,15})$/.exec(part);
    if (m) seen = Number(m[1]);
  }
  return { key, seen };
}

export function rejoinKey(body) {
  return parts(body)?.key || null;
}

/// The newest seq the asking device had walked, or null when the request does not say.
export function rejoinSeen(body) {
  return parts(body)?.seen ?? null;
}
