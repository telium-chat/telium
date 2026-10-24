import assert from 'node:assert/strict';
import test from 'node:test';
import { request, MAX_RETRY_DELAY_MS } from '../src/http.js';
import { isTerminalHttpError } from '../src/index.js';

test('request retries repeated 429 responses before succeeding', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 4) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', message: 'slow down', retry_after: 0 }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await request('https://home.example', 'POST', '/assert', {
      botToken: 'secret',
      body: { audience: 'guild.example' },
      retry429: 5,
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('request keeps 429 retries bounded', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: 'rate_limited', message: 'still limited', retry_after: 0 }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    await assert.rejects(
      request('https://home.example', 'POST', '/assert', {
        botToken: 'secret',
        retry429: 2,
      }),
      (error) => error?.status === 429,
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a server-supplied retry_after cannot park the bot for a day', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const waits = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    waits.push(ms);
    return originalSetTimeout(fn, 0, ...rest);
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', message: 'go away', retry_after: 86400 }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await request('https://home.example', 'GET', '/x', { retry429: 2 });
    assert.deepEqual(result, { ok: true });
    assert.ok(waits.length > 0);
    assert.ok(
      waits.every((ms) => ms <= MAX_RETRY_DELAY_MS),
      `waited ${waits} which exceeds the ${MAX_RETRY_DELAY_MS}ms cap`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('a Retry-After date far in the future is capped too', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const waits = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    waits.push(ms);
    return originalSetTimeout(fn, 0, ...rest);
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('', {
        status: 429,
        headers: { 'retry-after': 'Thu, 01 Jan 2099 00:00:00 GMT' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await request('https://home.example', 'GET', '/x', { retry429: 2 });
    assert.ok(waits.every((ms) => ms <= MAX_RETRY_DELAY_MS), `waited ${waits}`);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('a home that accepts the connection and never answers does not hang forever', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    const held = setTimeout(() => {}, 60000);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(held);
      reject(init.signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });

  try {
    await assert.rejects(
      request('https://home.example', 'GET', '/hang', { timeoutMs: 25 }),
      (error) => error?.code === 'TELIUM_REQUEST_TIMEOUT' && error.timeout === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a timeout has no HTTP status, so it classifies as transient rather than terminal', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    const held = setTimeout(() => {}, 60000);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(held);
      reject(new Error('aborted'));
    });
  });
  try {
    const error = await request('https://home.example', 'GET', '/hang', { timeoutMs: 25 })
      .then(() => null, (e) => e);
    assert.equal(error.status, undefined);
    assert.equal(isTerminalHttpError(error), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('passing both bearer and botToken throws instead of silently sending the long-lived token', async () => {
  await assert.rejects(
    request('https://guild.example', 'POST', '/x', {
      bearer: 'short-lived',
      botToken: 'telium_bot_long_lived',
    }),
    /both bearer and botToken/,
  );
});

test('only the credential that was passed reaches the wire', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.Authorization);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await request('https://home.example', 'GET', '/a', { botToken: 'long-lived' });
    await request('https://guild.example', 'GET', '/b', { bearer: 'short-lived' });
    await request('https://guild.example', 'GET', '/c', {});
    assert.deepEqual(seen, ['Bot long-lived', 'Bearer short-lived', undefined]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
