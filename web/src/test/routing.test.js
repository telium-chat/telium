import { beforeEach, describe, expect, it } from 'vitest';
import { BLANK, HOME, bindRouting, pathFor, routeFrom } from '../lib/routing.js';
import { Store } from '../lib/store.js';

describe('route paths', () => {
  it('round-trips every surface that has an address', () => {
    const routes = [
      { ...BLANK, guildId: 'G1', channelId: 'C1' },
      { ...BLANK, guildId: 'G1' },
      { ...BLANK, view: 'dms', conversationId: 'V1' },
      { ...BLANK, view: 'invite', inviteCode: 'INVITE1' },
      { ...BLANK, view: 'profile-link', userId: '@alice:home.example' },
      { ...HOME },
    ];
    for (const route of routes) expect(routeFrom(pathFor(route))).toEqual(route);
  });

  it('keeps a federated identity intact in a profile URL', () => {
    const route = { ...BLANK, view: 'profile-link', userId: '@alice:home.example' };
    expect(pathFor(route)).toBe('/u/@alice:home.example');
    expect(routeFrom('/u/@alice:home.example')).toEqual(route);
  });

  it('addresses a voice channel as a channel', () => {
    expect(pathFor({ view: 'voice', guildId: 'G1', channelId: 'C1' })).toBe('/channels/G1/C1');
    expect(routeFrom('/channels/G1/C1').view).toBe('chat');
  });

  it('refuses a path that is not one of ours rather than guessing', () => {
    expect(routeFrom('/nope')).toBeNull();
    expect(routeFrom('/channels/G1/C1/extra')).toBeNull();
    expect(routeFrom('/friends')).toBeNull();
  });

  it('survives an id that needs escaping', () => {
    const route = { ...BLANK, guildId: 'a/b', channelId: 'c d' };
    expect(routeFrom(pathFor(route))).toEqual(route);
  });
});

describe('history binding', () => {
  let store;
  let stop;

  beforeEach(() => {
    store = new Store();
    return () => stop?.();
  });

  it('preserves a public invite path instead of rewriting it to home', () => {
    window.history.replaceState(null, '', '/invite/INVITE1');
    stop = bindRouting(store);
    expect(store.route).toMatchObject({ view: 'invite', inviteCode: 'INVITE1' });
    expect(window.location.pathname).toBe('/invite/INVITE1');
  });

  it('opens on the channel the URL names', () => {
    window.history.replaceState(null, '', '/channels/G1/C1');
    stop = bindRouting(store);
    expect(store.route).toMatchObject({ view: 'chat', guildId: 'G1', channelId: 'C1' });
  });

  it('rewrites a path it does not recognise in place', () => {
    window.history.replaceState(null, '', '/rubbish');
    stop = bindRouting(store);
    expect(store.route).toMatchObject(HOME);
    expect(window.location.pathname).toBe('/channels/@me');
  });

  it('follows the route into the address bar', () => {
    window.history.replaceState(null, '', '/');
    stop = bindRouting(store);
    store.navigate({ view: 'chat', guildId: 'G2', channelId: 'C2' });
    expect(window.location.pathname).toBe('/channels/G2/C2');
    store.navigate({ view: 'dms', conversationId: 'V2' });
    expect(window.location.pathname).toBe('/channels/@me/V2');
  });

  it('follows the address bar back into the route', () => {
    window.history.replaceState(null, '', '/channels/G3/C3');
    stop = bindRouting(store);
    window.history.replaceState(null, '', '/channels/@me/V3');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(store.route).toMatchObject({ view: 'dms', conversationId: 'V3' });
    expect(window.location.pathname).toBe('/channels/@me/V3');
  });
});
