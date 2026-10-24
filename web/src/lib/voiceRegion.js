// Picks an SFU region by measuring it. The probe is an unauthenticated `GET /health`, so a region learns nothing; failure yields no preference (same as `auto`) and the server stays the authority.

/// The SFU's unauthenticated, CORS-open liveness endpoint.
const HEALTH_PATH = '/health';

/// Slower than this counts as no answer.
export const PROBE_TIMEOUT_MS = 1_000;

/// Two samples: the first pays for the TLS handshake.
export const PROBE_ROUNDS = 2;

/// Cap on regions probed at once.
export const PROBE_LIMIT = 4;

/// Overall deadline; candidates run in parallel with a share of the budget each.
export const PROBE_BUDGET_MS = 2_000;

/// A measured region must beat the server's choice by this much to override it.
export const PROBE_MARGIN_MS = 25;

/// Measurements expire so a long-open client doesn't steer on stale numbers.
export const PROBE_TTL_MS = 10 * 60_000;

/// Keyed by candidate set.
const cache = new Map();

/// For tests and deliberate re-probes.
export function clearRegionProbes() {
  cache.clear();
}

function deadlineSignal(timeoutMs) {
  // AbortSignal.timeout throws in older WebViews; use a controller and timer.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/// Round-trip ms or null; the minimum of the samples.
export async function probeRegion(endpoint, {
  rounds = PROBE_ROUNDS,
  timeoutMs = PROBE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  clock = () => (globalThis.performance?.now?.() ?? Date.now()),
} = {}) {
  if (!endpoint || typeof fetchImpl !== 'function') return null;
  const url = `${String(endpoint).replace(/\/$/, '')}${HEALTH_PATH}`;
  let best = null;
  for (let round = 0; round < rounds; round += 1) {
    const { signal, done } = deadlineSignal(timeoutMs);
    const started = clock();
    try {
      // Each option is load-bearing: no credentials, no referrer, no headers (no preflight), no-store.
      const resp = await fetchImpl(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal,
      });
      const elapsed = Math.max(0, Math.round(clock() - started));
      // A 503 still answered; the guild's health checks decide usability.
      if (resp && (resp.ok || typeof resp.status === 'number')) {
        best = best === null ? elapsed : Math.min(best, elapsed);
      }
    } catch {
      // Refused, aborted, CORS or proxy blocked: this client can't measure it.
    } finally {
      done();
    }
  }
  return best;
}

/// Returns `{ name, rtt, measured }`, or null (meaning `auto`) when there is nothing to say.
export async function pickRegion(regions, {
  fallback = null,
  limit = PROBE_LIMIT,
  budgetMs = PROBE_BUDGET_MS,
  marginMs = PROBE_MARGIN_MS,
  rounds = PROBE_ROUNDS,
  probe = probeRegion,
  clock = () => (globalThis.performance?.now?.() ?? Date.now()),
  ...options
} = {}) {
  const candidates = (Array.isArray(regions) ? regions : [])
    // Unhealthy is the server's judgement; don't second-guess it.
    .filter((r) => r?.name && r?.sfu && r.healthy !== false)
    .slice(0, limit);
  // One candidate is not a choice.
  if (candidates.length < 2) return null;

  // Probes run alongside each other, which keeps the whole inside the budget.
  const timeoutMs = Math.max(1, Math.min(
    options.timeoutMs ?? PROBE_TIMEOUT_MS,
    Math.floor(budgetMs / Math.max(1, rounds)),
  ));
  const results = await Promise.all(candidates.map(async (region) => ({
    name: region.name,
    rtt: await probe(region.sfu, { ...options, rounds, timeoutMs, clock }),
  })));

  const measured = results.filter((r) => typeof r.rtt === 'number');
  // Nothing answered: no opinion, i.e. `auto`.
  if (!measured.length) return null;

  measured.sort((a, b) => a.rtt - b.rtt);
  const best = measured[0];
  // The server would choose this anyway.
  if (fallback && best.name === fallback) return null;
  const incumbent = measured.find((r) => r.name === fallback);
  // Too close to hear a difference; leave the operator's default.
  if (incumbent && incumbent.rtt - best.rtt < marginMs) return null;
  return { name: best.name, rtt: best.rtt, measured };
}

/// `api` is anything with `regions()`. Any `preferred` but `auto` is kept and not probed.
export async function chooseVoiceRegion(api, preferred = 'auto', options = {}) {
  const wanted = preferred || 'auto';
  if (wanted !== 'auto') return wanted;
  if (!api?.regions) return 'auto';

  let published;
  try {
    published = await api.regions();
  } catch {
    // A server too old to publish a region list, or one that would rather not.
    return 'auto';
  }
  const regions = Array.isArray(published?.regions) ? published.regions : [];
  const key = regions.map((r) => r?.sfu).join('|');
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.name;

  let choice = null;
  try {
    choice = await pickRegion(regions, { fallback: published?.default || null, ...options });
  } catch {
    choice = null;
  }
  const name = choice?.name || 'auto';
  cache.set(key, { at: now, name, rtt: choice?.rtt ?? null });
  return name;
}
