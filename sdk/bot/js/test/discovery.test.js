import assert from 'node:assert/strict';
import test from 'node:test';
import { discover, requireGatewayUrl, INSECURE_HTTP_ENV } from '../src/discovery.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Records requested URLs; unlisted routes fail like an unreachable host.
async function withFetch(routes, fn) {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const key = String(url);
    seen.push({ url: key, headers: init?.headers || {} });
    const route = routes[key];
    if (!route) throw new Error(`connection refused: ${key}`);
    return typeof route === 'function' ? route() : json(route);
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const WELL_KNOWN = '/.well-known/telium/server';

test('discovery resolves a bare domain over https', async () => {
  await withFetch({
    [`https://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'https://home.example',
      gateway: 'wss://home.example/gateway/v1',
    },
  }, async (seen) => {
    const info = await discover('home.example');
    assert.equal(info.api, 'https://home.example');
    assert.equal(info.gateway, 'wss://home.example/gateway/v1');
    assert.equal(info.serverName, 'home.example');
    assert.equal(info.domain, 'home.example');
    assert.deepEqual(seen.map((s) => s.url), [`https://home.example${WELL_KNOWN}`]);
  });
});

test('discovery never falls back to plaintext http when https fails', async () => {
  await withFetch({
    [`http://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'http://home.example',
    },
  }, async (seen) => {
    await assert.rejects(discover('home.example'));
    assert.deepEqual(
      seen.map((s) => s.url),
      [`https://home.example${WELL_KNOWN}`],
      'an http:// seed must never be dialled without an explicit opt-in',
    );
  });
});

test('the loudly-named opt-in restores the plaintext seed for local development', async () => {
  await withFetch({
    [`http://localhost:8080${WELL_KNOWN}`]: {
      server_name: 'localhost',
      api: 'http://localhost:8080',
      gateway: 'ws://localhost:8080/gateway/v1',
    },
  }, async () => {
    const info = await discover('localhost:8080', { allowInsecureHttp: true });
    assert.equal(info.api, 'http://localhost:8080');
    assert.equal(info.gateway, 'ws://localhost:8080/gateway/v1');
  });
});

test('the opt-in can also come from the environment', async () => {
  const previous = process.env[INSECURE_HTTP_ENV];
  process.env[INSECURE_HTTP_ENV] = '1';
  try {
    await withFetch({
      [`http://dev.local${WELL_KNOWN}`]: { server_name: 'dev.local', api: 'http://dev.local' },
    }, async () => {
      const info = await discover('dev.local');
      assert.equal(info.api, 'http://dev.local');
    });
  } finally {
    if (previous === undefined) delete process.env[INSECURE_HTTP_ENV];
    else process.env[INSECURE_HTTP_ENV] = previous;
  }
});

test('an explicit http:// address is refused without the opt-in', async () => {
  await withFetch({}, async (seen) => {
    await assert.rejects(
      discover('http://home.example'),
      /plaintext HTTP/,
    );
    assert.deepEqual(seen, [], 'nothing should be dialled at all');
  });
});

test('a discovery document may not point the api base at another origin', async () => {
  await withFetch({
    [`https://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'https://attacker.example',
    },
  }, async () => {
    await assert.rejects(
      discover('home.example'),
      /not home.example or a delegation beneath it/,
    );
  });
});

test('a discovery document may not downgrade its own api base to http', async () => {
  await withFetch({
    [`https://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'http://home.example',
    },
  }, async () => {
    await assert.rejects(discover('home.example'), /plaintext api base/);
  });
});

test('a discovery document may not publish a ws:// gateway', async () => {
  await withFetch({
    [`https://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'https://home.example',
      gateway: 'ws://home.example/gateway/v1',
    },
  }, async () => {
    await assert.rejects(discover('home.example'), /plaintext gateway/);
  });
});

test('a discovery document may not point the gateway at another origin', async () => {
  await withFetch({
    [`https://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'https://home.example',
      gateway: 'wss://attacker.example/gateway/v1',
    },
  }, async () => {
    await assert.rejects(discover('home.example'), /attacker.example/);
  });
});

test('a delegation to a subdomain of the dialled name is allowed', async () => {
  await withFetch({
    [`https://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'https://telium.home.example:8443',
    },
  }, async () => {
    const info = await discover('home.example');
    assert.equal(info.api, 'https://telium.home.example:8443');
    assert.equal(info.gateway, 'wss://telium.home.example:8443/gateway/v1');
  });
});

test('a lookalike suffix is not a delegation', async () => {
  await withFetch({
    [`https://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'https://evilhome.example',
    },
  }, async () => {
    await assert.rejects(discover('home.example'), /evilhome.example/);
  });
});

test('the derived gateway defaults to wss when the document omits one', async () => {
  await withFetch({
    [`https://guild.example${WELL_KNOWN}`]: {
      server_name: 'guild.example',
      api: 'https://guild.example',
    },
  }, async () => {
    const info = await discover('guild.example');
    assert.equal(info.gateway, 'wss://guild.example/gateway/v1');
  });
});

test('a server that identifies itself as a different name is refused', async () => {
  await withFetch({
    [`https://guild.example${WELL_KNOWN}`]: {
      server_name: 'victim.example',
      api: 'https://guild.example',
    },
  }, async () => {
    await assert.rejects(
      discover('guild.example'),
      /identified itself as "victim.example"/,
    );
  });
});

test('expectServerName is enforced even for an explicit address', async () => {
  await withFetch({
    [`https://ingress.internal${WELL_KNOWN}`]: {
      server_name: 'somebody-else.example',
      api: 'https://ingress.internal',
    },
  }, async () => {
    await assert.rejects(
      discover('https://ingress.internal', { expectServerName: 'guild.example' }),
      /identified itself as/,
    );
  });
});

test('an explicit address without expectServerName skips the name check', async () => {
  await withFetch({
    [`https://ingress.internal${WELL_KNOWN}`]: {
      server_name: 'guild.example',
      api: 'https://ingress.internal',
    },
  }, async () => {
    const info = await discover('https://ingress.internal');
    assert.equal(info.api, 'https://ingress.internal');
    assert.equal(info.serverName, 'guild.example');
  });
});

test('a malformed api base is rejected rather than dialled', async () => {
  await withFetch({
    [`https://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'not a url',
    },
  }, async () => {
    await assert.rejects(discover('home.example'), /unusable api base/);
  });
});

test('a non-http scheme in the discovery document is rejected', async () => {
  await withFetch({
    [`https://home.example${WELL_KNOWN}`]: {
      server_name: 'home.example',
      api: 'file:///etc/passwd',
    },
  }, async () => {
    await assert.rejects(discover('home.example'), /not https/);
  });
});

test('a non-http seed scheme is rejected before any request', async () => {
  await withFetch({}, async (seen) => {
    await assert.rejects(discover('ftp://home.example'), /not an http\(s\) address/);
    assert.deepEqual(seen, []);
  });
});

test('discovery surfaces the underlying failure when the domain is unreachable', async () => {
  await withFetch({}, async () => {
    await assert.rejects(discover('gone.example'), /connection refused/);
  });
});

test('requireGatewayUrl confines a session-supplied gateway', () => {
  assert.equal(
    requireGatewayUrl('wss://guild.example/gateway/v1', 'guild.example'),
    'wss://guild.example/gateway/v1',
  );
  assert.throws(
    () => requireGatewayUrl('wss://attacker.example/gateway/v1', 'guild.example'),
    /attacker.example/,
  );
  assert.throws(
    () => requireGatewayUrl('ws://guild.example/gateway/v1', 'guild.example'),
    /plaintext gateway/,
  );
});
