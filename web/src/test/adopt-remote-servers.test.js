import { describe, expect, it, vi } from 'vitest';
import { serverMethods } from '../lib/store/servers.js';

function fakeStore({ memberships, servers = {}, dismissed = [] }) {
  const store = {
    ...serverMethods,
    session: { home: { domain: 'home.example' }, servers, dismissedServers: dismissed },
    home: { memberships: vi.fn(async () => ({ memberships })) },
    emit: vi.fn(),
  };
  store.addServer = vi.fn(async (domain) => domain);
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
});
