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
