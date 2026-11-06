import { afterEach, describe, expect, it, vi } from 'vitest';
import { discover } from '../lib/api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function route(body, status = 200, type = 'application/json') {
  return new Response(type === 'application/json' ? JSON.stringify(body) : body, {
    status,
    headers: { 'content-type': type },
  });
}

function mockRoutes(routes) {
  const seen = [];
  globalThis.fetch = vi.fn(async (url) => {
    seen.push(String(url));
    const item = routes[String(url)];
    if (!item) return route({ message: 'not found' }, 404);
    if (item instanceof Error) throw item;
    return item;
  });
  return seen;
}

describe('plain text Telium account-domain delegation', () => {
  it('loads live metadata from the backend using only a one-line website pointer', async () => {
    const seen = mockRoutes({
      'https://example.com/telium.txt': route('chat.example.com\n', 200, 'text/plain'),
      'https://chat.example.com/.well-known/telium/server': route({
        server_name: 'example.com',
        api: 'https://chat.example.com',
        gateway: 'wss://chat.example.com/gateway/v1',
        protocol: { capabilities: ['sync.sealed'] },
        onboarding: { recommendations: { suggest_alternatives: true } },
      }),
    });
    const found = await discover('example.com');
    expect(found.server_name).toBe('example.com');
    expect(found.api).toBe('https://chat.example.com');
    expect(found.capabilities).toContain('sync.sealed');
    expect(found.suggest_alternatives).toBe(true);
    expect(seen).toEqual([
      'https://example.com/.well-known/telium/server',
      'https://example.com/telium.txt',
      'https://chat.example.com/.well-known/telium/server',
    ]);
  });

  it('continues to support existing direct .well-known documents without an extra fetch', async () => {
    const seen = mockRoutes({
      'https://example.com/.well-known/telium/server': route({
        server_name: 'example.com', api: 'https://chat.example.com',
      }),
    });
    const found = await discover('example.com');
    expect(found.api).toBe('https://chat.example.com');
    expect(seen).toEqual(['https://example.com/.well-known/telium/server']);
  });

  it('rejects pointers outside the account-domain subtree', async () => {
    mockRoutes({
      'https://example.com/telium.txt': route('https://attacker.com', 200, 'text/plain'),
    });
    await expect(discover('https://example.com')).rejects.toThrow();
  });

  it('rejects a backend claiming someone else’s account identity', async () => {
    mockRoutes({
      'https://example.com/telium.txt': route('chat.example.com', 200, 'text/plain'),
      'https://chat.example.com/.well-known/telium/server': route({
        server_name: 'victim.example', api: 'https://chat.example.com',
      }),
    });
    await expect(discover('https://example.com')).rejects.toThrow(/does not identify itself/);
  });
});
