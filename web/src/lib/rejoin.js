// Body of a DM `rejoin` frame; kept out of mls.js so the gateway doesn't pull in the MLS engine.

export function rejoinBody(key) { return `key:${key}`; }

export function rejoinKey(body) {
  if (typeof body !== 'string' || !body.startsWith('key:')) return null;
  const key = body.slice(4);
  return /^[A-Za-z0-9+/]{20,100}={0,2}$/.test(key) ? key : null;
}
