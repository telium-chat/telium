const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Caps `retry_after`: a hostile server could otherwise silence the bot for a day.
export const MAX_RETRY_DELAY_MS = 16000;

// Bounds each attempt; a stalled home becomes an ordinary retryable error.
export const DEFAULT_TIMEOUT_MS = 15000;

function boundedDelay(ms) {
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(250, ms));
}

function retryDelayMs(response, payload, attempt) {
  const raw = payload?.retry_after ?? response.headers.get('retry-after');
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return boundedDelay(numeric * 1000);
  }
  if (typeof raw === 'string') {
    const at = Date.parse(raw);
    // An HTTP-date is as unbounded as seconds.
    if (Number.isFinite(at)) return boundedDelay(at - Date.now());
  }
  return Math.min(MAX_RETRY_DELAY_MS, 1000 * (2 ** attempt));
}

function timeoutSignal(ms) {
  // Plain controller fallback so a harness replacing globals cannot break requests.
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms), cancel() {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export async function request(
  base,
  method,
  path,
  { bearer, botToken, body, retry429 = 5, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  // Passing both would send the long-lived token where the short-lived one was meant, so be loud.
  if (bearer && botToken) {
    throw new Error(
      'request() was given both bearer and botToken; refusing to guess which Authorization to send. '
      + 'The long-lived bot token goes only to the bot home.',
    );
  }

  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (botToken) headers.Authorization = `Bot ${botToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // A 429 is backpressure: bounded retries, honour the server delay, else exponential backoff.
  const maxRetries = retry429 === true
    ? 5
    : retry429 === false
      ? 0
      : Math.max(0, Math.min(8, Number(retry429) || 0));

  const perAttemptTimeout = timeoutMs === false ? 0 : Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);

  for (let attempt = 0; ; attempt += 1) {
    const timeout = perAttemptTimeout ? timeoutSignal(perAttemptTimeout) : null;
    let response;
    try {
      response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(timeout ? { signal: timeout.signal } : {}),
      });
    } catch (error) {
      if (timeout?.signal?.aborted) {
        const timedOut = new Error(
          `${method} ${base}${path} timed out after ${perAttemptTimeout}ms`,
        );
        timedOut.code = 'TELIUM_REQUEST_TIMEOUT';
        timedOut.timeout = true;
        timedOut.cause = error;
        throw timedOut;
      }
      throw error;
    } finally {
      timeout?.cancel();
    }

    let payload = null;
    try { payload = await response.json(); } catch { /* empty/non-JSON response */ }

    if (response.status === 429 && attempt < maxRetries) {
      await sleep(retryDelayMs(response, payload, attempt));
      continue;
    }
    if (!response.ok) {
      const error = new Error(payload?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.body = payload;
      throw error;
    }
    return payload;
  }
}

export { sleep };
