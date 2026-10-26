export const INVITE_EXPIRY_OPTIONS = [
  ['3600', '1 hour'],
  ['86400', '1 day'],
  ['604800', '1 week'],
  ['2592000', '30 days'],
  ['', 'Never'],
];

export const DEFAULT_INVITE_EXPIRY = '86400';

export function inviteCreateBody(maxUses, expiry) {
  return {
    max_uses: maxUses ? Number(maxUses) : null,
    expires_in_secs: expiry ? Number(expiry) : null,
  };
}

/// The portal form of an invite or vanity link: the portal's URL naming the server that
/// mints it, so whoever opens it runs Telium's page rather than that server's. Null when
/// the server has no portal, and the caller keeps the link shape it always used.
export function portalInviteLink(portal, origin, token) {
  if (!portal || !origin) return null;
  return `${String(portal).replace(/\/+$/, '')}/invite/${encodeURIComponent(token)}@${origin}`;
}
