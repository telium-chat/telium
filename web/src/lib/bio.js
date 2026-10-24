// The limit is the server's (published in capabilities); a longer bio from another home is cut for display, never an error.

/// Assumed when the server doesn't say; matches the server default.
export const BIO_MAX_FALLBACK = 1024;

/// How far back a cut hunts for a space before landing inside a word.
const HUNT = 12;

/// Counts code points, not UTF-16 units; the ellipsis is inside the budget.
export function clampBio(text, limit = BIO_MAX_FALLBACK) {
  const s = typeof text === 'string' ? text : '';
  const chars = Array.from(s);
  if (chars.length <= limit) return s;

  let cut = chars.slice(0, Math.max(0, limit - 1)).join('');
  const space = cut.search(/\s\S*$/);
  if (space > 0 && cut.length - space <= HUNT) cut = cut.slice(0, space);
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}…`;
}
