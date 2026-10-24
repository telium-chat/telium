import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BotClient,
  BOT_NOT_INSTALLED_CODE,
  BOT_CREDENTIAL_REVOKED_CODE,
  UNKNOWN_BOT_TOKEN_CODE,
  isDeadCredential,
  isAuthError,
  isTerminalHttpError,
  isNotInstalled,
} from '../src/index.js';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('installation refresh notices uninstall and reinstall without restarting the bot process', async () => {
  const originalFetch = globalThis.fetch;
  let installations = [{
    guild_id: 'guild-1',
    guild_domain: 'guild.example',
    allowed_intents: '1',
    permissions: '3',
    installed_at: 10,
  }];

  globalThis.fetch = async (url) => {
    if (String(url) === 'https://home.example/_telium/v1/bots/installations') {
      return response({ installations });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const bot = new BotClient({
    home: 'home.example',
    token: 'secret',
    installationRefreshMs: false,
  });
  bot.homeInfo = { api: 'https://home.example' };

  const connects = [];
  const closes = [];
  bot.connectDomain = async (domain) => {
    connects.push(domain);
    bot.connections.set(domain, {
      remote: { api: `https://${domain}` },
      connection: { close: () => closes.push(domain) },
    });
  };

  try {
    await bot.refreshInstallations();
    assert.deepEqual(connects, ['guild.example']);
    assert.equal(bot.connections.has('guild.example'), true);

    await bot.refreshInstallations();
    assert.deepEqual(connects, ['guild.example']);

    installations = [];
    await bot.refreshInstallations();
    assert.equal(bot.connections.has('guild.example'), false);
    assert.deepEqual(closes, ['guild.example']);

    installations = [{
      guild_id: 'guild-1',
      guild_domain: 'guild.example',
      allowed_intents: '1',
      permissions: '3',
      installed_at: 20,
    }];
    await bot.refreshInstallations();

    assert.deepEqual(connects, ['guild.example', 'guild.example']);
    assert.equal(bot.connections.has('guild.example'), true);
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('a stale active receipt stays suppressed after the guild says the bot is uninstalled', async () => {
  const originalFetch = globalThis.fetch;
  const row = {
    guild_id: 'guild-1',
    guild_domain: 'guild.example',
    allowed_intents: '1',
    permissions: '3',
    installed_at: 10,
  };
  globalThis.fetch = async () => response({ installations: [row] });

  const bot = new BotClient({
    home: 'home.example',
    token: 'secret',
    installationRefreshMs: false,
  });
  bot.homeInfo = { api: 'https://home.example' };
  let connects = 0;
  bot.connectDomain = async () => { connects += 1; };

  try {
    const fingerprint = JSON.stringify([
      row.guild_id,
      row.installed_at,
      row.allowed_intents,
      row.permissions,
    ]);
    bot.domainFingerprints.set('guild.example', fingerprint);
    bot.suppressedDomains.set('guild.example', fingerprint);

    await bot.refreshInstallations();
    assert.equal(connects, 0, 'stale home index must not create a 403 reconnect loop');
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});


test('403 not-installed stops gateway refresh until the installation fingerprint changes', () => {
  const bot = new BotClient({
    home: 'home.example',
    token: 'secret',
    installationRefreshMs: false,
  });
  const warnings = [];
  bot.on('warning', (warning) => warnings.push(warning));
  bot.domainFingerprints.set('guild.example', 'fingerprint-1');

  const error = new Error('bot is not installed on this guild server');
  error.status = 403;
  error.body = {
    error: 'forbidden',
    message: 'bot is not installed on this guild server',
  };

  const retry = bot.handleRefreshError('guild.example', error, 1);

  assert.equal(retry, false);
  assert.equal(bot.suppressedDomains.get('guild.example'), 'fingerprint-1');
  assert.equal(warnings.at(-1)?.code, 'INSTALLATION_INACTIVE');
});

test('502 during gateway refresh remains retryable and is reported as a warning', () => {
  const bot = new BotClient({
    home: 'home.example',
    token: 'secret',
    installationRefreshMs: false,
  });
  const warnings = [];
  const errors = [];
  bot.on('warning', (warning) => warnings.push(warning));
  bot.on('error', (error) => errors.push(error));

  const error = new Error('HTTP 502');
  error.status = 502;

  const retry = bot.handleRefreshError('guild.example', error, 1);

  assert.equal(retry, true);
  assert.equal(warnings.at(-1)?.code, 'GATEWAY_RECONNECT_RETRY');
  assert.equal(errors.length, 0);
});


test('scheduled installation refresh discovers a new install without calling login again', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({
    installations: [{
      guild_id: 'guild-2',
      guild_domain: 'new-guild.example',
      allowed_intents: '1',
      permissions: '1',
      installed_at: 30,
    }],
  });

  const bot = new BotClient({
    home: 'home.example',
    token: 'secret',
    installationRefreshMs: 1000,
  });
  bot.homeInfo = { api: 'https://home.example' };
  const connected = [];
  bot.connectDomain = async (domain) => {
    connected.push(domain);
    bot.connections.set(domain, {
      remote: { api: `https://${domain}` },
      connection: { close() {} },
    });
  };

  try {
    bot.scheduleInstallationRefresh(1);
    for (let i = 0; i < 20 && connected.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(connected, ['new-guild.example']);
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('a transient 401 during session exchange retries instead of taking the domain offline', async () => {
  const bot = new BotClient({
    home: 'home.example',
    token: 'secret',
    installationRefreshMs: false,
    authRetryLimit: 3,
  });
  const warnings = [];
  const errors = [];
  bot.on('warning', (warning) => warnings.push(warning));
  bot.on('error', (error, context) => errors.push({ error, context }));
  bot.domainFingerprints.set('guild.example', 'fingerprint-1');

  const error = new Error('assertion is not yet valid');
  error.status = 401;

  try {
    assert.equal(bot.handleRefreshError('guild.example', error, 1), true);
    assert.equal(bot.handleRefreshError('guild.example', error, 2), true);
    assert.equal(warnings.filter((w) => w.code === 'GATEWAY_AUTH_RETRY').length, 2);
    assert.equal(errors.length, 0);
    assert.equal(bot.suppressedDomains.has('guild.example'), false);

    assert.equal(bot.handleRefreshError('guild.example', error, 3), false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].context.terminal, true);
    assert.equal(errors[0].context.attempts, 3);
    assert.equal(bot.suppressedDomains.get('guild.example'), 'fingerprint-1');
  } finally {
    bot.close();
  }
});

test('a 403 that is not the not-installed case is retried like any other auth failure', async () => {
  const bot = new BotClient({
    home: 'home.example',
    token: 'secret',
    installationRefreshMs: false,
    authRetryLimit: 5,
  });
  const warnings = [];
  bot.on('warning', (warning) => warnings.push(warning));
  bot.domainFingerprints.set('guild.example', 'fingerprint-1');

  const error = new Error('bot assertion signature did not verify');
  error.status = 403;
  error.body = { error: 'forbidden', message: 'bot assertion signature did not verify' };

  try {
    assert.equal(bot.handleRefreshError('guild.example', error, 1), true);
    assert.equal(warnings.at(-1).code, 'GATEWAY_AUTH_RETRY');
    assert.equal(bot.suppressedDomains.has('guild.example'), false);
  } finally {
    bot.close();
  }
});

test('a 400 malformed request and a 404 unknown bot stay terminal on sight', async () => {
  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  const errors = [];
  bot.on('error', (error, context) => errors.push(context));
  bot.domainFingerprints.set('guild.example', 'fingerprint-1');

  try {
    for (const status of [400, 404]) {
      const error = new Error(`HTTP ${status}`);
      error.status = status;
      assert.equal(bot.handleRefreshError('guild.example', error, 1), false);
    }
    assert.equal(errors.length, 2);
    assert.ok(errors.every((context) => context.terminal === true));
  } finally {
    bot.close();
  }
});

test('a READY clears the accumulated authorisation failures for a domain', async () => {
  const bot = new BotClient({
    home: 'home.example',
    token: 'secret',
    installationRefreshMs: false,
    authRetryLimit: 3,
  });
  bot.domainFingerprints.set('guild.example', 'fingerprint-1');
  const error = new Error('HTTP 401');
  error.status = 401;
  try {
    bot.handleRefreshError('guild.example', error, 1);
    bot.handleRefreshError('guild.example', error, 2);
    assert.equal(bot.authFailures.get('guild.example'), 2);
    bot.clearAuthFailure('guild.example');
    assert.equal(bot.authFailures.has('guild.example'), false);
    assert.equal(bot.domainRetryAt.has('guild.example'), false);
  } finally {
    bot.close();
  }
});

test('removal is recognised from a machine-readable code as well as from prose', async () => {
  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  const warnings = [];
  bot.on('warning', (warning) => warnings.push(warning));
  bot.domainFingerprints.set('guild.example', 'fingerprint-1');

  const coded = new Error('Le bot n’est plus installé sur ce serveur.');
  coded.status = 403;
  coded.body = { error: 'forbidden', code: BOT_NOT_INSTALLED_CODE, message: coded.message };

  try {
    assert.equal(isNotInstalled(coded), true);
    assert.equal(bot.handleRefreshError('guild.example', coded, 1), false);
    assert.equal(warnings.at(-1).code, 'INSTALLATION_INACTIVE');
    assert.equal(bot.suppressedDomains.get('guild.example'), 'fingerprint-1');
  } finally {
    bot.close();
  }
});

test('a dead credential is terminal, unlike every other authorisation failure', () => {
  for (const code of [UNKNOWN_BOT_TOKEN_CODE, BOT_CREDENTIAL_REVOKED_CODE]) {
    const error = new Error('whatever the server chose to say');
    error.status = 401;
    error.body = { error: 'unauthorized', code, message: error.message };
    assert.equal(isDeadCredential(error), true, code);
    assert.equal(isTerminalHttpError(error), true, code);
  }

  const assertionRefused = new Error('assertion did not verify');
  assertionRefused.status = 401;
  assertionRefused.body = { error: 'unauthorized', message: assertionRefused.message };
  assert.equal(isDeadCredential(assertionRefused), false);
  assert.equal(isTerminalHttpError(assertionRefused), false);
  assert.equal(isAuthError(assertionRefused), true);
});

test('the code can also arrive in the existing stable-shape error field', () => {
  const error = new Error('anything at all');
  error.status = 403;
  error.body = { error: BOT_NOT_INSTALLED_CODE };
  assert.equal(isNotInstalled(error), true);
});

test('the legacy substring match still classifies a server that sends no code', () => {
  const error = new Error('bot is not installed on this guild server');
  error.status = 403;
  error.body = { error: 'forbidden', message: 'bot is not installed on this guild server' };
  assert.equal(isNotInstalled(error), true);
});

test('a different specific 403 code is believed rather than substring-guessed', () => {
  const error = new Error('bot is not installed on this guild server');
  error.status = 403;
  error.body = { error: 'forbidden', code: 'guild_suspended', message: error.message };
  assert.equal(isNotInstalled(error), false, 'a specific code must win over the sentence');
  assert.equal(isAuthError(error), true);
});

test('an authorisation failure during the installation poll backs off instead of suppressing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({
    installations: [{
      guild_id: 'guild-1',
      guild_domain: 'guild.example',
      allowed_intents: '1',
      permissions: '3',
      installed_at: 10,
    }],
  });

  const bot = new BotClient({
    home: 'home.example',
    token: 'secret',
    installationRefreshMs: false,
    authRetryLimit: 3,
  });
  bot.homeInfo = { api: 'https://home.example' };
  const warnings = [];
  const errors = [];
  bot.on('warning', (warning) => warnings.push(warning));
  bot.on('error', (error, context) => errors.push(context));
  let attempts = 0;
  bot.connectDomain = async () => {
    attempts += 1;
    const error = new Error('HTTP 401');
    error.status = 401;
    throw error;
  };

  try {
    await bot.refreshInstallations();
    assert.equal(attempts, 1);
    assert.equal(warnings.at(-1).code, 'GUILD_AUTH_RETRY');
    assert.equal(bot.suppressedDomains.has('guild.example'), false);
    assert.ok(bot.domainRetryAt.get('guild.example') > Date.now());

    await bot.refreshInstallations();
    assert.equal(attempts, 1, 'the domain is still inside its backoff window');

    bot.domainRetryAt.set('guild.example', 0);
    await bot.refreshInstallations();
    bot.domainRetryAt.set('guild.example', 0);
    await bot.refreshInstallations();
    assert.equal(attempts, 3);
    assert.equal(errors.length, 1, 'only the threshold produces a terminal error');
    assert.equal(errors[0].terminal, true);
    assert.equal(bot.suppressedDomains.get('guild.example'), bot.domainFingerprints.get('guild.example'));
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('a not-installed 403 cannot reset a backed-off installation poll to 250ms', async () => {
  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: 5000 });
  bot.domainFingerprints.set('guild.example', 'fingerprint-1');
  try {
    bot.installationRefreshFailures = 3;
    bot.scheduleInstallationRefresh(30000);
    const backedOffUntil = bot.installationRefreshDueAt;
    assert.ok(backedOffUntil > Date.now() + 25000);

    const error = new Error('bot is not installed on this guild server');
    error.status = 403;
    error.body = { error: 'forbidden', message: error.message };
    bot.handleRefreshError('guild.example', error, 1);

    assert.equal(bot.installationRefreshDueAt, backedOffUntil, 'the backoff must survive');
  } finally {
    bot.close();
  }
});

test('a healthy poll is still expedited by a removal', async () => {
  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: 5000 });
  bot.domainFingerprints.set('guild.example', 'fingerprint-1');
  try {
    bot.scheduleInstallationRefresh(5000);
    const error = new Error('bot is not installed on this guild server');
    error.status = 403;
    error.body = { error: 'forbidden', message: error.message };
    bot.handleRefreshError('guild.example', error, 1);
    assert.ok(bot.installationRefreshDueAt <= Date.now() + 250);
  } finally {
    bot.close();
  }
});

test('on() registers and its returned function unregisters', () => {
  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  const seen = [];
  const off = bot.on('MESSAGE_CREATE', (message) => seen.push(message));
  bot.emit('MESSAGE_CREATE', { id: 'a' });
  off();
  bot.emit('MESSAGE_CREATE', { id: 'b' });
  assert.deepEqual(seen, [{ id: 'a' }]);
  bot.close();
});

test('a wildcard handler receives the event name ahead of the payload', () => {
  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  const seen = [];
  bot.on('*', (...args) => seen.push(args));
  bot.emit('MESSAGE_CREATE', { id: 'a' }, { domain: 'guild.example' });
  assert.deepEqual(seen, [['MESSAGE_CREATE', { id: 'a' }, { domain: 'guild.example' }]]);
  bot.close();
});

test('a rejected async handler is routed to the error handler, not the process', async () => {
  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  const errors = [];
  bot.on('error', (error, context) => errors.push({ error, context }));
  bot.on('MESSAGE_CREATE', async () => { throw new Error('send failed'); });

  try {
    bot.emit('MESSAGE_CREATE', { id: 'a' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error.message, 'send failed');
    assert.equal(errors[0].context.phase, 'handler');
    assert.equal(errors[0].context.event, 'MESSAGE_CREATE');
  } finally {
    bot.close();
  }
});

test('a synchronous handler throw is routed the same way', async () => {
  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  const errors = [];
  bot.on('error', (error) => errors.push(error));
  bot.on('MESSAGE_CREATE', () => { throw new Error('boom'); });
  try {
    bot.emit('MESSAGE_CREATE', { id: 'a' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors.map((e) => e.message), ['boom']);
  } finally {
    bot.close();
  }
});

test('one failing handler does not stop the others', async () => {
  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  const seen = [];
  bot.on('error', () => {});
  bot.on('MESSAGE_CREATE', async () => { throw new Error('first'); });
  bot.on('MESSAGE_CREATE', () => seen.push('second'));
  try {
    bot.emit('MESSAGE_CREATE', { id: 'a' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ['second']);
  } finally {
    bot.close();
  }
});

test('sendMessage re-exchanges a session when the guild server answers 401', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const key = String(url);
    const headers = init?.headers || {};
    calls.push({ url: key, authorization: headers.Authorization });
    if (key === 'https://guild.example/_telium/v1/channels/chan-1/messages') {
      if (headers.Authorization === 'Bearer expired') {
        return response({ error: 'unauthorized', message: 'session expired' }, 401);
      }
      return response({ id: 'msg-1' });
    }
    if (key === 'https://guild.example/.well-known/telium/server') {
      return response({ server_name: 'guild.example', api: 'https://guild.example' });
    }
    if (key === 'https://home.example/_telium/v1/bots/assertions') {
      return response({ assertion: 'signed' });
    }
    if (key === 'https://guild.example/_telium/v1/bots/session') {
      return response({ session_token: 'renewed' });
    }
    throw new Error(`unexpected fetch ${key}`);
  };

  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  bot.homeInfo = { api: 'https://home.example' };
  const connection = { token: 'expired', gateway: 'wss://guild.example/gateway/v1', close() {} };
  bot.connections.set('guild.example', { remote: { api: 'https://guild.example' }, connection });

  try {
    const result = await bot.sendMessage('chan-1', 'hi', { domain: 'guild.example' });
    assert.deepEqual(result, { id: 'msg-1' });
    assert.equal(connection.token, 'renewed', 'the connection adopts the renewed session');
    assert.equal(calls.at(-1).authorization, 'Bearer renewed');
    assert.equal(
      calls.filter((c) => c.url.endsWith('/channels/chan-1/messages')).length,
      2,
      'the send is retried exactly once',
    );
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('sendMessage does not re-exchange a session for a non-401 failure', async () => {
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/channels/chan-1/messages')) {
      sends += 1;
      return response({ error: 'forbidden', message: 'missing SEND_MESSAGES' }, 403);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  bot.homeInfo = { api: 'https://home.example' };
  bot.connections.set('guild.example', {
    remote: { api: 'https://guild.example' },
    connection: { token: 'session', close() {} },
  });

  try {
    await assert.rejects(
      bot.sendMessage('chan-1', 'hi', { domain: 'guild.example' }),
      (error) => error.status === 403,
    );
    assert.equal(sends, 1);
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('sendMessage routes by the channel map learned from dispatch activity', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return response({ id: 'msg-1' });
  };

  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  bot.connections.set('guild.example', {
    remote: { api: 'https://guild.example' },
    connection: { token: 'session', close() {} },
  });
  bot.channelDomains.set('chan-7', 'guild.example');

  try {
    await bot.sendMessage('chan-7', 'hi');
    assert.deepEqual(urls, ['https://guild.example/_telium/v1/channels/chan-7/messages']);
    await assert.rejects(bot.sendMessage('chan-unknown', 'hi'), /Unknown channel homeserver/);
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});

test('freshSession exchanges an assertion for a guild session', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = String(url);
    if (key === 'https://guild.example/.well-known/telium/server') {
      return response({
        server_name: 'guild.example',
        api: 'https://guild.example',
        gateway: 'wss://guild.example/gateway/v1',
      });
    }
    if (key === 'https://home.example/_telium/v1/bots/assertions') return response({ assertion: 'signed' });
    if (key === 'https://guild.example/_telium/v1/bots/session') {
      return response({ session_token: 'session-token' });
    }
    throw new Error(`unexpected fetch ${key}`);
  };

  const bot = new BotClient({ home: 'home.example', token: 'secret', installationRefreshMs: false });
  bot.homeInfo = { api: 'https://home.example' };

  try {
    const fresh = await bot.freshSession('guild.example');
    assert.equal(fresh.token, 'session-token');
    assert.equal(fresh.gateway, 'wss://guild.example/gateway/v1');
    assert.equal(fresh.remote.domain, 'guild.example');
  } finally {
    bot.close();
    globalThis.fetch = originalFetch;
  }
});
