import { describe, expect, it, vi } from 'vitest';
import { serverMethods } from '../lib/store/servers.js';

function fakeStore({ memberships, servers = {}, dismissed = [], empty = {} }) {
  const store = {
    ...serverMethods,
    session: { home: { domain: 'home.example' }, servers, dismissedServers: dismissed, emptyServers: empty },
    home: { memberships: vi.fn(async () => ({ memberships })) },
    emit: vi.fn(),
    save: vi.fn(),
  };
  store.addServer = vi.fn(async (domain) => { store.session.servers[domain] = {}; return domain; });
  store.removeServer = vi.fn((domain) => { delete store.session.servers[domain]; });
  return store;
}

describe('adoptRemoteServers', () => {
  it('signs in to guild servers joined on another device', async () => {
    const store = fakeStore({
      memberships: [
        { guild_server: 'home.example', guild_id: 'g0' },
        { guild_server: 'games.example', guild_id: 'g1' },
        { guild_server: 'games.example', guild_id: 'g2' },
        { guild_server: 'art.example', guild_id: 'g3' },
      ],
      servers: { 'home.example': {} },
    });
    expect(await store.adoptRemoteServers()).toEqual(['games.example', 'art.example']);
    expect(store.addServer).toHaveBeenCalledTimes(2);
    expect(store.emit).toHaveBeenCalledWith('servers');
  });

  it('leaves alone a server this device removed, and keeps going past one that fails', async () => {
    const store = fakeStore({
      memberships: [
        { guild_server: 'gone.example', guild_id: 'g1' },
        { guild_server: 'down.example', guild_id: 'g2' },
        { guild_server: 'up.example', guild_id: 'g3' },
      ],
      dismissed: ['gone.example'],
    });
    store.addServer.mockImplementation(async (d) => { if (d === 'down.example') throw new Error('offline'); return d; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await store.adoptRemoteServers()).toEqual(['up.example']);
    warn.mockRestore();
  });

  it('lets go of a server READY shows holds none of the account\'s guilds, until the registry changes', async () => {
    vi.useFakeTimers();
    const store = fakeStore({ memberships: [{ guild_server: 'stale.example', guild_id: 'old' }] });
    await store.adoptRemoteServers();
    expect(store.session.servers['stale.example'].adopted).toBe('old');

    store.settleAdoptedServer('stale.example', 0);
    vi.runAllTimers();
    expect(store.removeServer).toHaveBeenCalledWith('stale.example', { dismiss: false });
    expect(store.session.dismissedServers).toEqual([]);

    store.addServer.mockClear();
    await store.adoptRemoteServers();
    expect(store.addServer).not.toHaveBeenCalled();

    store.home.memberships.mockResolvedValue({ memberships: [
      { guild_server: 'stale.example', guild_id: 'old' },
      { guild_server: 'stale.example', guild_id: 'new' },
    ] });
    await store.adoptRemoteServers();
    expect(store.addServer).toHaveBeenCalledWith('stale.example', { silent: true });
    vi.useRealTimers();
  });

  it('keeps an adopted server that has guilds, and stops treating it as adopted', async () => {
    const store = fakeStore({ memberships: [{ guild_server: 'games.example', guild_id: 'g1' }] });
    await store.adoptRemoteServers();
    store.settleAdoptedServer('games.example', 3);
    expect(store.removeServer).not.toHaveBeenCalled();
    expect(store.session.servers['games.example'].adopted).toBeUndefined();
  });
});
