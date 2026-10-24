import { describe, expect, it, vi } from 'vitest';
import { isPrivate } from '../lib/channels.js';
import { PERMISSION_MASKS } from '../lib/perms.js';
import { freshStore } from './fake-server.js';

const GUILD = 'g1';
const VIEW = PERMISSION_MASKS.get('VIEW_CHANNEL');
const SEND = PERMISSION_MASKS.get('SEND_MESSAGES');

function inFlight() {
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return { promise, ...settle };
}

function guildStore() {
  const store = freshStore();
  store.me = { user_id: '@me:home.example' };
  store.guilds.set(GUILD, {
    id: GUILD, domain: 'home.example',
    me: { user_id: '@me:home.example', roles: [], permissions: String(VIEW | SEND) },
  });
  store.channels.set('c1', {
    id: 'c1', guild_id: GUILD, domain: 'home.example', name: 'general', permission_overwrites: [],
  });
  store.roles.set(GUILD, new Map([
    ['r1', { id: 'r1', name: 'Mods', permissions: '0', permission_names: [], position: 1 }],
  ]));
  store.members.set(GUILD, new Map([['@bob:home.example', { user_id: '@bob:home.example', roles: [] }]]));
  const calls = [];
  const api = {
    setOverwrite: vi.fn((...args) => { const call = inFlight(); calls.push({ args, ...call }); return call.promise; }),
    patchRole: vi.fn((...args) => { const call = inFlight(); calls.push({ args, ...call }); return call.promise; }),
    patchMember: vi.fn((...args) => { const call = inFlight(); calls.push({ args, ...call }); return call.promise; }),
  };
  vi.spyOn(store, 'apiForChannel').mockReturnValue(api);
  vi.spyOn(store, 'apiForGuild').mockReturnValue(api);
  const channel = () => store.channels.get('c1');
  const everyone = () => channel().permission_overwrites.find((o) => o.target_id === GUILD);
  const tick = () => new Promise((r) => { setTimeout(r, 0); });
  return { store, api, calls, channel, everyone, tick };
}

const echo = (overwrites) => ({ id: 'c1', guild_id: GUILD, permission_overwrites: overwrites });
const denyView = { target_type: 'role', target_id: GUILD, allow: '0', deny: String(VIEW) };

describe('optimistic channel overwrites', () => {
  it('locks the channel and changes computed permissions before the server answers', async () => {
    const { store, calls, channel, tick } = guildStore();
    const seen = vi.fn();
    store.on('channels', seen);
    expect(store.can('c1', 'VIEW_CHANNEL')).toBe(true);

    const done = store.setOverwriteNow('c1', 'role', GUILD, 0n, VIEW);
    expect(isPrivate(channel())).toBe(true);
    expect(store.can('c1', 'VIEW_CHANNEL')).toBe(false);
    expect(seen).toHaveBeenCalled();

    await tick();
    expect(calls).toHaveLength(1);
    calls[0].resolve(echo([denyView]));
    await expect(done).resolves.toMatchObject({ id: 'c1' });
    expect(isPrivate(channel())).toBe(true);
    expect(store.permWrites.size).toBe(0);
  });

  it('sends only the last of several toggles made at once', async () => {
    const { store, calls, everyone } = guildStore();
    const first = store.setOverwriteNow('c1', 'role', GUILD, 0n, VIEW);
    const second = store.setOverwriteNow('c1', 'role', GUILD, 0n, 0n);
    const third = store.setOverwriteNow('c1', 'role', GUILD, 0n, SEND);
    expect(everyone().deny).toBe(String(SEND));
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(3)).toEqual([0n, SEND]);
    calls[0].resolve(echo([{ ...denyView, deny: String(SEND) }]));
    await third;
    expect(everyone().deny).toBe(String(SEND));
  });

  it('keeps a newer toggle over the echo of an older one, and sends toggles one at a time', async () => {
    const { store, calls, everyone, tick } = guildStore();
    const first = store.setOverwriteNow('c1', 'role', GUILD, 0n, VIEW);
    await tick();
    const second = store.setOverwriteNow('c1', 'role', GUILD, 0n, 0n);
    const third = store.setOverwriteNow('c1', 'role', GUILD, 0n, VIEW | SEND);
    await tick();
    expect(calls).toHaveLength(1);
    expect(everyone().deny).toBe(String(VIEW | SEND));

    store.onDispatch({ domain: 'home.example', t: 'CHANNEL_UPDATE', d: echo([denyView]) });
    expect(everyone().deny).toBe(String(VIEW | SEND));

    calls[0].resolve(echo([denyView]));
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].args.slice(3)).toEqual([0n, VIEW | SEND]);
    calls[1].resolve(echo([{ ...denyView, deny: String(VIEW | SEND) }]));
    await expect(third).resolves.toMatchObject({ id: 'c1' });
    expect(everyone().deny).toBe(String(VIEW | SEND));
  });

  it('puts the last accepted overwrite back when the server refuses', async () => {
    const { store, calls, channel, everyone, tick } = guildStore();
    const first = store.setOverwriteNow('c1', 'role', GUILD, 0n, VIEW);
    await tick();
    calls[0].resolve(echo([denyView]));
    await first;

    const done = store.setOverwriteNow('c1', 'role', GUILD, 0n, 0n);
    expect(isPrivate(channel())).toBe(false);
    await tick();
    calls[1].reject(Object.assign(new Error('Missing permission'), { status: 403 }));
    await expect(done).rejects.toThrow('Missing permission');
    expect(isPrivate(channel())).toBe(true);
    expect(everyone().deny).toBe(String(VIEW));
    expect(store.permWrites.size).toBe(0);
  });

  it('removes an overwrite that was not there before a refused write', async () => {
    const { store, calls, channel, tick } = guildStore();
    const done = store.setOverwriteNow('c1', 'role', 'r1', SEND, 0n);
    expect(channel().permission_overwrites).toHaveLength(1);
    await tick();
    calls[0].reject(new Error('offline'));
    await expect(done).rejects.toThrow('offline');
    expect(channel().permission_overwrites).toEqual([]);
  });

  it('leaves an overtaken refusal to the newest write', async () => {
    const { store, calls, everyone, tick } = guildStore();
    const first = store.setOverwriteNow('c1', 'role', GUILD, 0n, VIEW);
    await tick();
    const second = store.setOverwriteNow('c1', 'role', GUILD, 0n, SEND);
    calls[0].reject(new Error('blip'));
    await expect(first).resolves.toBeNull();
    expect(everyone().deny).toBe(String(SEND));
    await tick();
    calls[1].resolve(echo([{ ...denyView, deny: String(SEND) }]));
    await expect(second).resolves.toMatchObject({ id: 'c1' });
    expect(everyone().deny).toBe(String(SEND));
  });
});

describe('optimistic role edits', () => {
  it('draws the new permission bits at once and keeps them over a refetch mid-flight', async () => {
    const { store, calls, tick } = guildStore();
    const done = store.patchRoleNow(GUILD, 'r1', { name: 'Mods', permissions: ['SEND_MESSAGES'] });
    const role = () => store.roles.get(GUILD).get('r1');
    expect(role().permissions).toBe(String(SEND));
    expect(role().permission_names).toEqual(['SEND_MESSAGES']);

    vi.spyOn(store, 'apiForGuild').mockReturnValue({
      ...store.apiForGuild(GUILD),
      roles: async () => ({ roles: [{ id: 'r1', name: 'Mods', permissions: '0', permission_names: [] }] }),
    });
    await store.loadRoles(GUILD, { force: true });
    expect(role().permissions).toBe(String(SEND));

    await tick();
    calls[0].resolve({ id: 'r1', name: 'Mods', permissions: String(SEND), permission_names: ['SEND_MESSAGES'] });
    await expect(done).resolves.toMatchObject({ id: 'r1' });
    expect(role().permissions).toBe(String(SEND));
  });

  it('puts the role back when the server refuses', async () => {
    const { store, calls, tick } = guildStore();
    const done = store.patchRoleNow(GUILD, 'r1', { name: 'Admins', permissions: ['ADMINISTRATOR'] });
    expect(store.roles.get(GUILD).get('r1').name).toBe('Admins');
    await tick();
    calls[0].reject(Object.assign(new Error('above you'), { status: 403 }));
    await expect(done).rejects.toThrow('above you');
    expect(store.roles.get(GUILD).get('r1')).toMatchObject({ name: 'Mods', permissions: '0' });
  });
});

describe('optimistic member role changes', () => {
  it('gives the member the role at once, and takes it back on a refusal', async () => {
    const { store, calls, tick } = guildStore();
    const bob = () => store.members.get(GUILD).get('@bob:home.example');
    const done = store.setMemberRoleNow(GUILD, '@bob:home.example', 'r1', true);
    expect(bob().roles).toEqual(['r1']);
    await tick();
    expect(calls[0].args[2]).toEqual({ add_roles: ['r1'] });
    calls[0].reject(new Error('nope'));
    await expect(done).rejects.toThrow('nope');
    expect(bob().roles).toEqual([]);
  });
});
