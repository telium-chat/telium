import { describe, expect, it } from 'vitest';
import {
  destinationOf, isTrustedHost, MAX_TRUSTED_DOMAINS, needsConfirmation, ownHosts,
  forgetTrustedHost, trustedDomains, trustHost,
} from '../lib/link-trust.js';
import { KEYS, SyncStore } from '../lib/sync.js';

function fakeStore(extra = {}) {
  const sync = new SyncStore();
  return {
    sync,
    get prefs() { return sync.get(KEYS.prefs); },
    savePrefs() { sync.set(KEYS.prefs, this.prefs); },
    session: null,
    apis: new Map(),
    ...extra,
  };
}

describe('reading a link destination', () => {
  it('refuses anything that is not a web page', () => {
    expect(destinationOf('javascript:alert(1)')).toBeNull();
    expect(destinationOf('mailto:someone@example.com')).toBeNull();
    expect(destinationOf('not a url at all')).toBeNull();
    expect(destinationOf('/relative/only')).toBeNull();
  });

  it('reports the host and the path a plain link opens', () => {
    const found = destinationOf('https://Example.COM/articles/1?ref=chat');
    expect(found.host).toBe('example.com');
    expect(found.path).toBe('/articles/1?ref=chat');
    expect(found.disguised).toBe(false);
    expect(destinationOf('https://example.com/').path).toBe('');
  });

  it('shows the real host when credentials are used to hide it', () => {
    const found = destinationOf('https://telium.example@evil.test/login');
    expect(found.host).toBe('evil.test');
    expect(found.userinfo).toBe('telium.example');
    expect(found.disguised).toBe(true);
  });

  it('shows a lookalike domain in the form the browser will resolve', () => {
    const found = destinationOf('https://аpple.com/id');
    expect(found.host).toBe('xn--pple-43d.com');
    expect(found.punycoded).toBe(true);
    expect(found.disguised).toBe(true);
  });
});

describe('hosts this account already talks to', () => {
  it('collects the home server, every guild session, and the page itself', () => {
    const store = fakeStore({
      session: { home: { base: 'https://home.example', domain: 'home.example' }, servers: { 'guild.example': { base: 'https://guild.example' } } },
      apis: new Map([['other.example', { base: 'https://other.example' }]]),
    });
    const hosts = ownHosts(store);
    expect(hosts.has('home.example')).toBe(true);
    expect(hosts.has('guild.example')).toBe(true);
    expect(hosts.has('other.example')).toBe(true);
    expect(hosts.has(window.location.hostname)).toBe(true);
  });

  it('never asks about a link to one of them', () => {
    const store = fakeStore({ session: { home: { base: 'https://home.example', domain: 'home.example' } } });
    expect(needsConfirmation(store, 'https://home.example/settings')).toBeNull();
    expect(needsConfirmation(store, 'https://elsewhere.example/x')).toMatchObject({ host: 'elsewhere.example' });
  });
});

describe('domains the reader has agreed to', () => {
  it('remembers an answer and stops asking, on this device and the next', () => {
    const store = fakeStore();
    expect(trustedDomains(store)).toEqual([]);
    trustHost(store, 'docs.example');
    expect(store.sync.get(KEYS.prefs).trustedDomains).toEqual(['docs.example']);
    expect(needsConfirmation(store, 'https://docs.example/page')).toBeNull();
    forgetTrustedHost(store, 'docs.example');
    expect(needsConfirmation(store, 'https://docs.example/page')).toMatchObject({ host: 'docs.example' });
  });

  it('covers what is under a domain and nothing that merely ends with it', () => {
    const store = fakeStore();
    trustHost(store, 'example.com');
    expect(isTrustedHost(store, 'example.com')).toBe(true);
    expect(isTrustedHost(store, 'cdn.example.com')).toBe(true);
    expect(isTrustedHost(store, 'example.com.evil.test')).toBe(false);
    expect(isTrustedHost(store, 'notexample.com')).toBe(false);
  });

  it('collapses a subdomain into a parent that already covers it', () => {
    const store = fakeStore();
    trustHost(store, 'cdn.example.com');
    trustHost(store, 'example.com');
    expect(trustedDomains(store)).toEqual(['example.com']);
    trustHost(store, 'images.example.com');
    expect(trustedDomains(store)).toEqual(['example.com']);
  });

  it('keeps the list from becoming a synced browsing history', () => {
    const store = fakeStore();
    for (let i = 0; i < MAX_TRUSTED_DOMAINS + 20; i += 1) trustHost(store, `host${i}.example`);
    expect(trustedDomains(store)).toHaveLength(MAX_TRUSTED_DOMAINS);
    expect(trustedDomains(store)[0]).toBe(`host${MAX_TRUSTED_DOMAINS + 19}.example`);
  });
});
