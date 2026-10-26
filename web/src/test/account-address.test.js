import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseAddress, findHome, lookupAccount, fullHandle,
  recentAccounts, rememberAccount, forgetAccount, suggestedHomes, searchCandidates,
} from '../lib/account-address.js';

describe('parseAddress', () => {
  it.each([
    ['', { kind: 'empty' }],
    ['   ', { kind: 'empty' }],
    [null, { kind: 'empty' }],
  ])('reads %j as empty', (input, want) => {
    expect(parseAddress(input)).toEqual(want);
  });

  it.each([
    ['@ada:telium.chat', 'ada', 'telium.chat'],
    ['ada:telium.chat', 'ada', 'telium.chat'],
    ['ada@telium.chat', 'ada', 'telium.chat'],
    ['  @ada:telium.chat  ', 'ada', 'telium.chat'],
    ['@ada:telium.chat/', 'ada', 'telium.chat'],
    ['@Ada:Telium.CHAT', 'Ada', 'telium.chat'],
    ['Ada@ATLAS.nyc', 'Ada', 'atlas.nyc'],
    ['@ada:telium.chat:8448', 'ada', 'telium.chat:8448'],
    ['ada@localhost:8080', 'ada', 'localhost:8080'],
    ['@ada:localhost', 'ada', 'localhost'],
    ['ada:127.0.0.1:8448', 'ada', '127.0.0.1:8448'],
    ['@a.b-c_d:chat.example.org', 'a.b-c_d', 'chat.example.org'],
  ])('reads %j as a handle', (input, user, host) => {
    expect(parseAddress(input)).toEqual({ kind: 'handle', user, host });
  });

  it.each([
    ['ada', 'ada'],
    ['@ada', 'ada'],
    [' ada ', 'ada'],
    ['Ada_99', 'Ada_99'],
    ['ada.b', 'ada.b'],
  ])('reads %j as a bare name', (input, user) => {
    expect(parseAddress(input)).toEqual({ kind: 'name', user });
  });

  it.each([
    ['atlas.nyc', 'atlas.nyc'],
    ['ATLAS.nyc/', 'atlas.nyc'],
    ['chat.example.org', 'chat.example.org'],
    ['atlas.nyc:8448', 'atlas.nyc:8448'],
    ['localhost', 'localhost'],
    ['localhost:8080', 'localhost:8080'],
    ['dev.localhost:3000', 'dev.localhost:3000'],
    ['192.168.1.20', '192.168.1.20'],
    ['10.0.0.1:8448', '10.0.0.1:8448'],
    ['atlas.nyc/channels/g1', 'atlas.nyc'],
  ])('reads %j as a bare server', (input, host) => {
    expect(parseAddress(input)).toEqual({ kind: 'server', host });
  });

  it.each([
    ['https://atlas.nyc', 'atlas.nyc', 'https://atlas.nyc'],
    ['https://atlas.nyc/', 'atlas.nyc', 'https://atlas.nyc'],
    ['HTTPS://Atlas.NYC', 'atlas.nyc', 'https://atlas.nyc'],
    ['http://localhost:8080', 'localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:8448/', '127.0.0.1:8448', 'http://127.0.0.1:8448'],
    ['https://atlas.nyc:443', 'atlas.nyc', 'https://atlas.nyc'],
    ['https://atlas.nyc/channels/@me', 'atlas.nyc', 'https://atlas.nyc'],
  ])('reads %j as a server with its scheme kept', (input, host, base) => {
    expect(parseAddress(input)).toEqual({ kind: 'server', host, base });
  });

  it.each([
    ['https://atlas.nyc/invite/AbC123', { kind: 'invite', host: 'atlas.nyc', code: 'AbC123', base: 'https://atlas.nyc' }],
    ['https://atlas.nyc/invite/AbC123/', { kind: 'invite', host: 'atlas.nyc', code: 'AbC123', base: 'https://atlas.nyc' }],
    ['http://localhost:8080/invite/xyz', { kind: 'invite', host: 'localhost:8080', code: 'xyz', base: 'http://localhost:8080' }],
    ['atlas.nyc/invite/AbC123', { kind: 'invite', host: 'atlas.nyc', code: 'AbC123' }],
    ['  Atlas.NYC/invite/AbC123  ', { kind: 'invite', host: 'atlas.nyc', code: 'AbC123' }],
    ['localhost:8080/invite/q', { kind: 'invite', host: 'localhost:8080', code: 'q' }],
  ])('reads %j as an invite', (input, want) => {
    expect(parseAddress(input)).toEqual(want);
  });

  it.each([
    // A portal link carries its server after the code; the portal host is only a carrier,
    // and is not kept — discovery aims at the server the link names.
    ['https://telium.chat/invite/AbC123@guilds.example', { kind: 'invite', host: 'guilds.example', code: 'AbC123' }],
    ['telium.chat/invite/gaming@guilds.example:8448', { kind: 'invite', host: 'guilds.example:8448', code: 'gaming' }],
    ['https://portal.example/invite/x@Atlas.NYC/', { kind: 'invite', host: 'atlas.nyc', code: 'x' }],
  ])('reads %j as an invite for the server it names', (input, want) => {
    expect(parseAddress(input)).toEqual(want);
  });

  it.each([
    'ada lovelace',
    '@ada :telium.chat',
    'ada:foo',
    'ada@foo',
    '@ada:',
    ':telium.chat',
    'ada@',
    'a@b@telium.chat',
    'ada!:telium.chat',
    'ftp://atlas.nyc',
    'mailto:ada@telium.chat',
    'https://user:pw@atlas.nyc',
    'https://',
    'ada:atlas.c',
    'ada@999.1.1.1',
    'localhost:99999',
    'foo/invite/x',
    'https://telium.chat/invite/@guilds.example',
    'telium.chat/invite/x@notahost',
    '#general',
    '@',
  ])('reads %j as invalid', (input) => {
    expect(parseAddress(input)).toEqual({ kind: 'invalid' });
  });

  it('does not read a dev server as the user "localhost"', () => {
    expect(parseAddress('localhost:8080').kind).toBe('server');
  });
});

describe('fullHandle', () => {
  it('builds the canonical form', () => {
    expect(fullHandle('ada', 'telium.chat')).toBe('@ada:telium.chat');
    expect(fullHandle('ada', 'localhost:8080')).toBe('@ada:localhost:8080');
  });
});

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('findHome', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('uses the delegated API base, not the handle domain', async () => {
    const fetch = vi.fn(async () => json(200, {
      server_name: 'example.org', api: 'https://chat.example.org',
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(findHome('example.org')).resolves.toEqual({
      serverName: 'example.org', api: 'https://chat.example.org', movedTo: null,
    });
    expect(fetch.mock.calls[0][0]).toBe('https://example.org/.well-known/telium/server');
  });

  it('falls back to the base it asked when the document names no api', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { server_name: 'localhost:8080' })));
    await expect(findHome('http://localhost:8080')).resolves.toEqual({
      serverName: 'localhost:8080', api: 'http://localhost:8080', movedTo: null,
    });
  });

  it('passes moved_to through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {
      server_name: 'old.example', api: 'https://old.example', moved_to: 'new.example',
    })));
    expect((await findHome('old.example')).movedTo).toBe('new.example');
  });

  it('calls a server nobody answers for unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(findHome('nowhere.example')).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('calls a server that is not Telium unreachable too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: 'not_found' })));
    await expect(findHome('blog.example')).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('never retries a bare host over plain http', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetch);
    await expect(findHome('atlas.example')).rejects.toMatchObject({ code: 'unreachable' });
    expect(fetch.mock.calls.map(([url]) => url))
      .toEqual(['https://atlas.example/.well-known/telium/server']);
  });

  it('refuses an https document that points at an http API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {
      server_name: 'atlas.example', api: 'http://atlas.example',
    })));
    await expect(findHome('atlas.example')).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('still reaches a bare loopback host over http', async () => {
    const fetch = vi.fn(async () => json(200, { server_name: 'localhost:8080' }));
    vi.stubGlobal('fetch', fetch);
    await expect(findHome('localhost:8080')).resolves.toMatchObject({ api: 'http://localhost:8080' });
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:8080/.well-known/telium/server');
  });

  it('calls a document without a server name unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { hello: 'world' })));
    await expect(findHome('odd.example')).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('lookupAccount', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks the status route with the user id encoded', async () => {
    const fetch = vi.fn(async () => json(200, { user_id: '@ada:telium.chat', status: 'active' }));
    vi.stubGlobal('fetch', fetch);
    await expect(lookupAccount('https://telium.chat', '@ada:telium.chat'))
      .resolves.toEqual({ status: 'active', movedTo: null });
    expect(fetch.mock.calls[0][0])
      .toBe('https://telium.chat/_telium/v1/users/%40ada%3Atelium.chat/status');
    expect(fetch.mock.calls[0][1].method).toBe('GET');
  });

  it.each(['active', 'deactivated', 'unknown', 'gone'])('reports %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { user_id: '@a:b.example', status })));
    await expect(lookupAccount('https://b.example', '@a:b.example'))
      .resolves.toEqual({ status, movedTo: null });
  });

  it('reports a move with the new user id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {
      user_id: '@a:old.example', status: 'moved', moved_to: '@a:new.example', origin: 'old.example',
    })));
    await expect(lookupAccount('https://old.example', '@a:old.example'))
      .resolves.toEqual({ status: 'moved', movedTo: '@a:new.example' });
  });

  it('cannot tell when the route is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, null)));
    await expect(lookupAccount('https://old.example', '@a:old.example')).resolves.toEqual({ status: null });
  });

  it('cannot tell when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(lookupAccount('https://x.example', '@a:x.example')).resolves.toEqual({ status: null });
  });

  it('cannot tell when the answer is not one it knows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { status: 'sleeping' })));
    await expect(lookupAccount('https://x.example', '@a:x.example')).resolves.toEqual({ status: null });
  });
});

describe('recent accounts', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it('starts empty and suggests the default home', () => {
    expect(recentAccounts()).toEqual([]);
    expect(suggestedHomes()).toEqual(['telium.chat']);
  });

  it('keeps only public fields, most recent first', () => {
    rememberAccount({ userId: '@ada:atlas.nyc', host: 'atlas.nyc', base: 'https://atlas.nyc', token: 'x' });
    rememberAccount({ userId: '@bo:telium.chat', host: 'telium.chat', base: 'https://telium.chat' });
    const list = recentAccounts();
    expect(list.map((e) => e.userId)).toEqual(['@bo:telium.chat', '@ada:atlas.nyc']);
    expect(Object.keys(list[1]).sort()).toEqual(['at', 'base', 'host', 'userId']);
    expect(localStorage.getItem('telium.recent-accounts.v1')).not.toContain('token');
  });

  it('dedupes by user id and moves the repeat to the front', () => {
    rememberAccount({ userId: '@a:one.example', host: 'one.example' });
    rememberAccount({ userId: '@b:two.example', host: 'two.example' });
    rememberAccount({ userId: '@a:one.example', host: 'one.example', base: 'https://api.one.example' });
    const list = recentAccounts();
    expect(list.map((e) => e.userId)).toEqual(['@a:one.example', '@b:two.example']);
    expect(list[0].base).toBe('https://api.one.example');
  });

  it('caps the list at five', () => {
    for (let i = 0; i < 7; i += 1) rememberAccount({ userId: `@u${i}:s${i}.example`, host: `s${i}.example` });
    const list = recentAccounts();
    expect(list).toHaveLength(5);
    expect(list[0].userId).toBe('@u6:s6.example');
  });

  it('forgets one account', () => {
    rememberAccount({ userId: '@a:one.example', host: 'one.example' });
    rememberAccount({ userId: '@b:two.example', host: 'two.example' });
    forgetAccount('@a:one.example');
    expect(recentAccounts().map((e) => e.userId)).toEqual(['@b:two.example']);
    forgetAccount('@nobody:none.example');
    expect(recentAccounts()).toHaveLength(1);
  });

  it('ignores bad input', () => {
    rememberAccount({ host: 'x.example' });
    rememberAccount();
    expect(recentAccounts()).toEqual([]);
  });

  it('survives junk in storage', () => {
    localStorage.setItem('telium.recent-accounts.v1', '{not json');
    expect(recentAccounts()).toEqual([]);
    localStorage.setItem('telium.recent-accounts.v1', JSON.stringify([{ nope: 1 }, { userId: '@a:b.example', host: 'b.example' }]));
    expect(recentAccounts().map((e) => e.userId)).toEqual(['@a:b.example']);
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(recentAccounts()).toEqual([]);
    expect(() => rememberAccount({ userId: '@a:b.example', host: 'b.example' })).not.toThrow();
    expect(() => forgetAccount('@a:b.example')).not.toThrow();
    expect(suggestedHomes()).toEqual(['telium.chat']);
  });

  it('suggests unique recent hosts, then the default, at most four', () => {
    rememberAccount({ userId: '@a:one.example', host: 'one.example' });
    rememberAccount({ userId: '@b:one.example', host: 'one.example' });
    rememberAccount({ userId: '@c:telium.chat', host: 'telium.chat' });
    expect(suggestedHomes()).toEqual(['telium.chat', 'one.example']);
    for (const h of ['two', 'three', 'four', 'five']) {
      rememberAccount({ userId: `@x:${h}.example`, host: `${h}.example` });
    }
    expect(suggestedHomes()).toEqual(['five.example', 'four.example', 'three.example', 'two.example']);
  });
});

describe('the portal is not a home', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  // The marker the portal build stamps into the shell: there, the default home
  // is the official site itself, which runs no server, so it is offered
  // nowhere — not as a suggestion, not as a search candidate.
  function bePortal() {
    const marker = document.createElement('meta');
    marker.name = 'telium-portal';
    marker.content = '1';
    document.head.appendChild(marker);
    return marker;
  }

  it('leaves the default home out of suggestions and search candidates', () => {
    const marker = bePortal();
    try {
      expect(suggestedHomes()).toEqual([]);
      const candidates = searchCandidates({
        recent: [{ userId: '@a:one.example', host: 'one.example', base: 'https://one.example', at: 1 }],
      }).map((candidate) => candidate.host);
      expect(candidates).toEqual(['one.example']);
    } finally {
      marker.remove();
    }
  });

  it('still suggests the default home away from the portal', () => {
    expect(suggestedHomes()).toEqual(['telium.chat']);
  });
});
