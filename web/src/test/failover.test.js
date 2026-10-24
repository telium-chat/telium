import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeFallback, describeLag, learnFallback, primaryIsHome, primaryStatus, resolveStandby,
} from '../lib/failover.js';
import { Store } from '../lib/store.js';

function serve(routes) {
  return vi.fn(async (url) => {
    const path = String(url);
    for (const [match, body] of Object.entries(routes)) {
      if (path.startsWith(match)) {
        if (body === null) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, json: async () => body };
      }
    }
    throw new TypeError('Failed to fetch');
  });
}

const WELL_KNOWN = {
  server_name: 'home.example',
  api: 'https://home.example',
  fallback: { standby: 'backup.example', path: '/_telium/standby/home.example' },
};

const STANDBY_WELL_KNOWN = { server_name: 'backup.example', api: 'https://backup.example' };

const FRESH = {
  origin: 'home.example',
  standby: 'backup.example',
  authority: 'home.example',
  promoted: false,
  record: null,
  read_only: true,
  behind_ms: 4000,
  stale: false,
};

const PROMOTED = {
  ...FRESH,
  authority: 'backup.example',
  promoted: true,
  read_only: false,
  stale: true,
  record: { kind: 'failover_promotion', authority: 'backup.example', sequence: 1 },
};

describe('learning where the copy is', () => {
  it('reads the address out of the primary while the primary is still up', async () => {
    global.fetch = serve({ 'https://home.example/.well-known': WELL_KNOWN });
    expect(await learnFallback('https://home.example')).toEqual({
      standby: 'backup.example',
      path: '/_telium/standby/home.example',
      authority: null,
    });
  });

  it('answers null rather than throwing when there is no standby configured', async () => {
    global.fetch = serve({ 'https://home.example/.well-known': { server_name: 'home.example' } });
    expect(await learnFallback('https://home.example')).toBeNull();
  });

  it('answers null rather than throwing when the primary is already gone', async () => {
    global.fetch = serve({});
    expect(await learnFallback('https://home.example')).toBeNull();
  });
});

describe('resolving the standby', () => {
  it('finds the standby by domain and mounts the copy under its own prefix', async () => {
    global.fetch = serve({
      'https://backup.example/.well-known': STANDBY_WELL_KNOWN,
      'https://backup.example/_telium/v1/failover/status/home.example': FRESH,
    });
    const resolved = await resolveStandby(WELL_KNOWN.fallback, 'home.example');
    expect(resolved.base).toBe('https://backup.example/_telium/standby/home.example');
    expect(resolved.gateway)
      .toBe('wss://backup.example/_telium/standby/home.example/gateway/v1');
    expect(resolved.status.behind_ms).toBe(4000);
  });
});

describe('describing the lag', () => {
  it('rounds to something a person can act on', () => {
    expect(describeLag(0)).toBe('0 seconds behind');
    expect(describeLag(1000)).toBe('1 second behind');
    expect(describeLag(45_000)).toBe('45 seconds behind');
    expect(describeLag(240_000)).toBe('4 minutes behind');
    expect(describeLag(7_200_000)).toBe('2 hours behind');
  });

  it('says so when it does not know', () => {
    expect(describeLag(null)).toBe('unknown age');
    expect(describeLag(undefined)).toBe('unknown age');
  });
});

describe('the client falling over and back', () => {
  let store;

  beforeEach(() => {
    store = new Store();
    store.session = {
      home: {
        base: 'https://home.example',
        domain: 'home.example',
        user_id: '@alice:home.example',
        token: 'home-token',
        fallback: WELL_KNOWN.fallback,
      },
      servers: {
        'home.example': { base: 'https://home.example', token: 'guild-token', gateway: 'wss://home.example/gateway/v1' },
      },
    };
    store.home = { base: 'https://home.example' };
    store.save = () => {};
    store.gw.add = vi.fn();
  });

  it('points the client at the copy and says it is read-only', async () => {
    global.fetch = serve({
      'https://backup.example/.well-known': STANDBY_WELL_KNOWN,
      'https://backup.example/_telium/v1/failover/status/home.example': FRESH,
    });

    await store.enterFallback();

    expect(store.home.base).toBe('https://backup.example/_telium/standby/home.example');
    expect(store.isReadOnly()).toBe(true);
    expect(store.fallback.standby).toBe('backup.example');
    expect(store.session.home.base).toBe('https://home.example');
    expect(store.gw.add).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'home.example',
      url: 'wss://backup.example/_telium/standby/home.example/gateway/v1',
      token: 'guild-token',
    }));
  });

  it('refuses a copy that has stopped being updated', async () => {
    global.fetch = serve({
      'https://backup.example/.well-known': STANDBY_WELL_KNOWN,
      'https://backup.example/_telium/v1/failover/status/home.example': { ...FRESH, stale: true },
    });

    await expect(store.enterFallback()).rejects.toThrow(/stopped updating/);
    expect(store.fallback).toBeNull();
    expect(store.home.base).toBe('https://home.example');
  });

  it('goes home again as soon as the real server answers', async () => {
    global.fetch = serve({
      'https://backup.example/.well-known': STANDBY_WELL_KNOWN,
      'https://backup.example/_telium/v1/failover/status/home.example': FRESH,
    });
    await store.enterFallback();
    expect(store.isReadOnly()).toBe(true);

    store.refreshConversations = vi.fn(async () => {});
    store.refreshFriends = vi.fn(async () => {});
    global.fetch = serve({
      'https://home.example/_telium/v1/health': { ok: true, server_name: 'home.example' },
    });
    await store.checkPrimary();

    expect(store.fallback).toBeNull();
    expect(store.isReadOnly()).toBe(false);
    expect(store.home.base).toBe('https://home.example');
    expect(store.refreshConversations).toHaveBeenCalled();
  });

  it('stays on the copy while the primary is still down, and refreshes the lag', async () => {
    global.fetch = serve({
      'https://backup.example/.well-known': STANDBY_WELL_KNOWN,
      'https://backup.example/_telium/v1/failover/status/home.example': FRESH,
    });
    await store.enterFallback();

    global.fetch = serve({
      'https://backup.example/_telium/v1/failover/status/home.example': { ...FRESH, behind_ms: 61_000 },
    });
    await store.checkPrimary();

    expect(store.fallback.status.behind_ms).toBe(61_000);
    expect(store.home.base).toBe('https://backup.example/_telium/standby/home.example');
  });
});

describe('asking whether home is home', () => {
  it('is false when the server is down and true when it is not', async () => {
    global.fetch = serve({});
    expect(await primaryIsHome('https://home.example', 'home.example')).toBe(false);
    global.fetch = serve({
      'https://home.example/_telium/v1/health': { ok: true, authority: 'home.example' },
    });
    expect(await primaryIsHome('https://home.example', 'home.example')).toBe(true);
  });

  it('is false for a server that is alive but no longer in charge', async () => {
    global.fetch = serve({
      'https://home.example/_telium/v1/health': { ok: true, authority: 'backup.example' },
    });
    expect(await primaryStatus('https://home.example')).toEqual({
      alive: true,
      authority: 'backup.example',
    });
    expect(await primaryIsHome('https://home.example', 'home.example')).toBe(false);
  });
});

describe('after the copy has been promoted', () => {
  let store;

  beforeEach(() => {
    store = new Store();
    store.session = {
      home: {
        base: 'https://home.example',
        domain: 'home.example',
        user_id: '@alice:home.example',
        token: 'home-token',
        fallback: WELL_KNOWN.fallback,
      },
      servers: {
        'home.example': { base: 'https://home.example', token: 'guild-token', gateway: 'wss://home.example/gateway/v1' },
      },
    };
    store.home = { base: 'https://home.example' };
    store.save = () => {};
    store.gw.add = vi.fn();
    global.fetch = serve({
      'https://backup.example/.well-known': STANDBY_WELL_KNOWN,
      'https://backup.example/_telium/v1/failover/status/home.example': PROMOTED,
    });
  });

  it('takes a promoted copy that would otherwise look abandoned', async () => {
    await store.enterFallback();
    expect(store.fallback.standby).toBe('backup.example');
    expect(store.home.base).toBe('https://backup.example/_telium/standby/home.example');
  });

  it('lets the person type again, because the copy is the server now', async () => {
    await store.enterFallback();
    expect(store.isReadOnly()).toBe(false);
  });

  it('does not go home to a server that is up but no longer the authority', async () => {
    await store.enterFallback();
    global.fetch = serve({
      'https://home.example/_telium/v1/health': { ok: true, authority: 'backup.example' },
      'https://backup.example/_telium/v1/failover/status/home.example': PROMOTED,
    });
    await store.checkPrimary();
    expect(store.fallback).not.toBeNull();
    expect(store.home.base).toBe('https://backup.example/_telium/standby/home.example');
  });

  it('goes home once home is the authority again', async () => {
    await store.enterFallback();
    store.refreshConversations = vi.fn(async () => {});
    store.refreshFriends = vi.fn(async () => {});
    global.fetch = serve({
      'https://home.example/_telium/v1/health': { ok: true, authority: 'home.example' },
    });
    await store.checkPrimary();
    expect(store.fallback).toBeNull();
    expect(store.home.base).toBe('https://home.example');
  });
});

describe('telling the person which of the two situations they are in', () => {
  it('warns while it is a copy', () => {
    const text = describeFallback(
      { standby: 'backup.example', status: FRESH }, 'home.example',
    );
    expect(text).toContain('read-only copy');
    expect(text).toContain('4 seconds behind');
  });

  it('stops warning once it is the server', () => {
    const text = describeFallback(
      { standby: 'backup.example', status: PROMOTED }, 'home.example',
    );
    expect(text).toContain('now being served by backup.example');
    expect(text).not.toContain('read-only');
    expect(text).not.toContain('behind');
  });
});
