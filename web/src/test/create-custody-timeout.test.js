import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { CUSTODY_TIMEOUT_MS, sessionMethods } from '../lib/store/session.js';

const realFetch = globalThis.fetch;
const json = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});
const hang = () => new Promise(() => {});

const resp = { access_token: 't', user_id: '@alice:h.test', device_id: 'D1', server_name: 'h.test' };
// The real limit is 15 s; a short one keeps the test quick without faking the clock under the network layer.
const SHORT = 150;
const store = () => Object.assign(Object.create(sessionMethods), { emit() {}, custodyTimeoutMs: SHORT });
const create = (s) => s.createCustody(resp, 'http://h.test', crypto.getRandomValues(new Uint8Array(32)), null);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

describe('createCustody on sign-in', () => {
  it('waits at most 15 seconds by default', () => {
    expect(CUSTODY_TIMEOUT_MS).toBe(15_000);
  });

  it('gives up on a vault request that never answers, logs it, and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen = [];
    globalThis.fetch = vi.fn((input) => { seen.push(String(input?.url || input)); return hang(); });

    const started = Date.now();
    await create(store());
    expect(Date.now() - started).toBeGreaterThanOrEqual(SHORT - 20);
    expect(seen.some((u) => u.endsWith('/vault'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('custody'), expect.objectContaining({
      message: expect.stringContaining('loading the recovery vault timed out'),
    }));
  });

  it('gives up on an account-key request that never answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let vaultBody = null;
    let guardAnswered = false;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input?.url || input);
      const method = String(init?.method || 'GET').toUpperCase();
      if (url.endsWith('/vault') && method === 'GET') {
        return vaultBody ? json({ exists: true, version: 1, ...vaultBody }) : json({ exists: false, version: 0 });
      }
      if (url.endsWith('/vault') && method === 'PUT') {
        vaultBody = JSON.parse(init.body);
        return json({ ok: true, version: 1 });
      }
      // The vault's own check that no account key exists passes once; the account key's requests then hang.
      if (url.endsWith('/crosssigning') && method === 'GET' && !guardAnswered) {
        guardAnswered = true;
        return json({ exists: false });
      }
      return hang();
    });
    await create(store());
    expect(guardAnswered).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('custody'), expect.objectContaining({
      message: expect.stringContaining('setting up the account key timed out'),
    }));
  });

  it('is retried by the next sign-in: a timeout leaves nothing that blocks a second attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(() => hang());
    await create(store());
    const afterFirst = globalThis.fetch.mock.calls.length;
    await create(store());
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
