import assert from 'node:assert/strict';
import test from 'node:test';
import { BotClient } from '../src/index.js';

// Invariant: `Authorization: Bot` reaches the identity home and nothing else.

const LONG_LIVED = 'telium_bot_long_lived_secret';
const WELL_KNOWN = '/.well-known/telium/server';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerOf(init, name) {
  const headers = init?.headers || {};
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function recordingFetch(routes) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      const key = String(url);
      calls.push({
        url: key,
        origin: new URL(key).origin,
        authorization: headerOf(init, 'authorization'),
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      const route = routes[key];
      if (!route) throw new Error(`connection refused: ${key}`);
      return typeof route === 'function' ? route() : json(route);
    },
  };
}

test('the long-lived bot token is sent to the bot home and to nobody else', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetch } = recordingFetch({
    [`https://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'https://home.example',
    },
    [`https://guild.example${WELL_KNOWN}`]: {
      server_name: 'guild.example',
      api: 'https://guild.example',
    },
    'https://home.example/_telium/v1/bots/assertions': { assertion: 'signed-assertion' },
    'https://guild.example/_telium/v1/bots/session': {
      session_token: 'short-lived-session',
      gateway: 'wss://guild.example/gateway/v1',
    },
  });
  globalThis.fetch = fetch;

  const bot = new BotClient({
    home: 'home.example',
    token: LONG_LIVED,
    installationRefreshMs: false,
  });

  try {
    bot.homeInfo = await (await import('../src/discovery.js')).discover('home.example');
    const fresh = await bot.freshSession('guild.example');
    assert.equal(fresh.token, 'short-lived-session');

    const leaked = calls.filter(
      (call) => String(call.authorization || '').includes(LONG_LIVED)
        && call.origin !== 'https://home.example',
    );
    assert.deepEqual(leaked, [], 'the long-lived token left the bot home');

    const guildCalls = calls.filter((call) => call.origin === 'https://guild.example');
    assert.ok(guildCalls.length > 0);
    for (const call of guildCalls) {
      assert.equal(
        call.authorization,
        undefined,
        `guild server call ${call.url} must carry no bot credential at all`,
      );
    }

    const assertionCall = calls.find((call) => call.url.endsWith('/bots/assertions'));
    assert.equal(assertionCall.authorization, `Bot ${LONG_LIVED}`);

    for (const call of calls) {
      assert.ok(call.url.startsWith('https://'), `${call.url} is not TLS`);
    }
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('sendMessage carries the short-lived session bearer, never the bot token', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetch } = recordingFetch({
    'https://guild.example/_telium/v1/channels/chan-1/messages': { id: 'msg-1' },
  });
  globalThis.fetch = fetch;

  const bot = new BotClient({
    home: 'home.example',
    token: LONG_LIVED,
    installationRefreshMs: false,
  });
  bot.homeInfo = { api: 'https://home.example' };
  bot.connections.set('guild.example', {
    remote: { api: 'https://guild.example' },
    connection: { token: 'short-lived-session', close() {} },
  });

  try {
    await bot.sendMessage('chan-1', 'Pong!', { domain: 'guild.example' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, 'Bearer short-lived-session');
    assert.ok(!String(calls[0].authorization).includes(LONG_LIVED));
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('the assertion audience comes from the home index, not the peer self-description', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetch } = recordingFetch({
    [`https://hostile.example${WELL_KNOWN}`]: {
      server_name: 'victim.example',
      api: 'https://hostile.example',
    },
    'https://home.example/_telium/v1/bots/assertions': { assertion: 'signed-assertion' },
    'https://hostile.example/_telium/v1/bots/session': { session_token: 'session' },
  });
  globalThis.fetch = fetch;

  const bot = new BotClient({
    home: 'home.example',
    token: LONG_LIVED,
    installationRefreshMs: false,
  });
  bot.homeInfo = { api: 'https://home.example' };

  try {
    await assert.rejects(
      bot.freshSession('hostile.example'),
      /identified itself as "victim.example"/,
    );
    assert.equal(
      calls.some((call) => call.url.endsWith('/bots/assertions')),
      false,
      'no assertion may be requested for a peer that failed its name check',
    );
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('the audience is the dialled domain even when the peer names itself honestly', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetch } = recordingFetch({
    [`https://guild.example${WELL_KNOWN}`]: {
      server_name: 'guild.example',
      api: 'https://guild.example',
    },
    'https://home.example/_telium/v1/bots/assertions': { assertion: 'signed-assertion' },
    'https://guild.example/_telium/v1/bots/session': { session_token: 'session' },
  });
  globalThis.fetch = fetch;

  const bot = new BotClient({
    home: 'home.example',
    token: LONG_LIVED,
    installationRefreshMs: false,
  });
  bot.homeInfo = { api: 'https://home.example' };

  try {
    await bot.freshSession('guild.example');
    const assertionCall = calls.find((call) => call.url.endsWith('/bots/assertions'));
    assert.deepEqual(assertionCall.body, { audience: 'guild.example' });
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('a session response may not redirect the gateway to another origin', async () => {
  const originalFetch = globalThis.fetch;
  const { fetch } = recordingFetch({
    [`https://guild.example${WELL_KNOWN}`]: {
      server_name: 'guild.example',
      api: 'https://guild.example',
    },
    'https://home.example/_telium/v1/bots/assertions': { assertion: 'signed-assertion' },
    'https://guild.example/_telium/v1/bots/session': {
      session_token: 'session',
      gateway: 'wss://attacker.example/gateway/v1',
    },
  });
  globalThis.fetch = fetch;

  const bot = new BotClient({
    home: 'home.example',
    token: LONG_LIVED,
    installationRefreshMs: false,
  });
  bot.homeInfo = { api: 'https://home.example' };

  try {
    await assert.rejects(bot.freshSession('guild.example'), /attacker.example/);
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('the installation index request carries the bot token to the home only', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetch } = recordingFetch({
    'https://home.example/_telium/v1/bots/installations': { installations: [] },
  });
  globalThis.fetch = fetch;

  const bot = new BotClient({
    home: 'home.example',
    token: LONG_LIVED,
    installationRefreshMs: false,
  });
  bot.homeInfo = { api: 'https://home.example' };

  try {
    await bot.fetchInstallations();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].origin, 'https://home.example');
    assert.equal(calls[0].authorization, `Bot ${LONG_LIVED}`);
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});
