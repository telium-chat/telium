//! The pure halves of the count worker: what a ping may be, and what stored
//! rows add up to. Kept free of Cloudflare so `node --test` can hold them to
//! their word without a network or a runtime.

// What one server may claim. A ceiling rather than a belief: the number is
// honor-system anyway, and the ceiling exists so a typo cannot become a
// billion-row write.
export const MAX_USERS = 10_000_000;

// How long a server stays counted after its last ping. Dead servers age out,
// so the totals honestly mean "servers heard from in the last 35 days".
export const TTL_DAYS = 35;

// A ping is exactly {id, users}. Extra fields are refused rather than
// ignored, so the collector stays a second copy of the promise the server's
// docs make: two numbers, nothing else. A future field means deploying a
// collector update before the server release that sends it.
export function validatePing(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("users")) return null;
  const { id, users } = body;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (!Number.isInteger(users) || users < 0 || users > MAX_USERS) return null;
  return { id, users };
}

// One entry per server heard from, and the two numbers the project wants.
// `users` defaults to 0 for a row with no metadata, which cannot happen and
// costs nothing to survive.
export function aggregate(rows) {
  let servers = 0;
  let users = 0;
  for (const row of rows) {
    servers += 1;
    users += row.users ?? 0;
  }
  return { servers, users };
}
