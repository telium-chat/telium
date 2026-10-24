import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Action, Close, DOWN_AFTER_MS, Kind, Role, classify, describeRequest, summarize,
} from '../lib/failure.js';
import { repeatable, transient, withRetry } from '../lib/retry.js';
import { collect, routeShape, toMarkdown } from '../lib/diagnostics.js';
import { resetLocalState } from '../lib/recover.js';
import { Api } from '../lib/api.js';

const LONG = DOWN_AFTER_MS + 1;
const MESSAGES = '/_telium/v1/channels/abc/messages';
const fetchFailure = () => new TypeError('Failed to fetch');

describe('telling the failures apart', () => {
  it('gives each of the five its own kind, action and sentence', () => {
    const cases = [
      classify({ code: Close.PROTOCOL_INCOMPATIBLE, reason: 'too old. Update Telium.', name: 'h' }),
      classify({ code: Close.AUTH_FAILED, role: Role.Home, name: 'h' }),
      classify({ online: false }),
      classify({ role: Role.Home, name: 'h', downFor: LONG }),
      classify({ role: Role.Guild, name: 'g', downFor: LONG }),
    ];
    expect(cases.map((c) => [c.kind, c.action])).toEqual([
      [Kind.Protocol, Action.Update], [Kind.Auth, Action.SignIn], [Kind.Offline, Action.Network],
      [Kind.AccountHome, Action.HomeOperator], [Kind.GuildServer, Action.GuildOperator],
    ]);
    expect(new Set(cases.map((c) => c.sentence)).size).toBe(5);
    expect(classify({ code: Close.RESTARTING }).action).toBe(Action.Wait);
    expect(cases[0].retryable).toBe(false);
    expect(cases[1].retryable).toBe(false);
  });

  it('shows the server its own words when the protocol window closes the socket', () => {
    const remedy = 'telium.example speaks v3 and up. Update Telium to reconnect.';
    expect(classify({ code: Close.PROTOCOL_INCOMPATIBLE, reason: remedy }).sentence).toBe(remedy);
  });

  it('blames the device rather than the servers when offline', () => {
    const failure = classify({ code: 1006, role: Role.Home, name: 'home.example', downFor: LONG, online: false });
    expect(failure.kind).toBe(Kind.Offline);
    expect(failure.sentence).not.toContain('home.example');
  });

  it('distinguishes a blip, your own server, and somebody else\'s', () => {
    expect(classify({ role: Role.Guild, downFor: 2_000 }).kind).toBe(Kind.Reconnecting);
    expect(classify({ role: Role.Home, name: 'h', downFor: LONG }).sentence)
      .toContain('Messages you send will not go anywhere');
    expect(classify({ role: Role.Guild, name: 'g', downFor: LONG }).sentence)
      .toContain('The rest of Telium works normally');
  });

  it('leads with the failure that will never fix itself, grouping the rest', () => {
    const summary = summarize([
      classify({ role: Role.Guild, name: 'g1', downFor: LONG }),
      classify({ code: Close.PROTOCOL_INCOMPATIBLE, reason: 'update', name: 'h' }),
      classify({ role: Role.Guild, name: 'g2', downFor: LONG }),
    ].map((f, i) => ({ ...f, name: ['g1', 'h', 'g2'][i] })));
    expect(summary.lead.kind).toBe(Kind.Protocol);
    expect(summary.groups).toHaveLength(2);
    expect(summary.groups[1].names).toEqual(['g1', 'g2']);
  });

  it('describes request failures honestly', () => {
    expect(describeRequest(fetchFailure(), true)).not.toContain('fetch');
    expect(describeRequest(fetchFailure(), false)).toContain('offline');
    expect(describeRequest({ status: 403, body: { message: 'You are not in that guild.' } }))
      .toBe('You are not in that guild.');
    expect(describeRequest({ status: 403 })).toContain('permission');
    expect(describeRequest({ status: 500 })).toContain('may or may not');
    const refusal = new Error('Your call privacy for this conversation asks for an SFU.');
    expect(describeRequest(refusal, true)).toBe(refusal.message);
    expect(describeRequest(refusal, false)).toBe(refusal.message);
    expect(describeRequest(new Error(''), true)).toBe('Something went wrong.');
    expect(describeRequest('boom', false)).toBe('Something went wrong.');
    const aborted = new Error('The operation was aborted.');
    aborted.name = 'AbortError';
    expect(describeRequest(aborted, true)).toContain('Could not reach');
  });
});

describe('retrying only what cannot be duplicated', () => {
  it('refuses unnamed sends, fake idempotency claims, and anything that spends something', () => {
    const refused = [
      ['POST', MESSAGES, undefined], ['POST', MESSAGES, {}], ['POST', MESSAGES, { content: 'hello' }],
      ...[{ nonce: null }, { nonce: '' }, { nonce: 42 }, { nonce: { id: 'abc12345' } }, { nonce: ['abc12345'] },
        { idempotent: true }, { retry_safe: true, content: 'hello' }].map((b) => ['POST', MESSAGES, b]),
      ['POST', '/_telium/v1/channels/c/messages?nonce=1', undefined],
      ['POST', '/_telium/v1/conversations'],
      ['POST', '/_telium/v1/users/@a:h/keypackages/claim'],
      ['POST', '/_telium/v1/invites/abcdef'],
      ['POST', '/_telium/v1/guilds'],
      ['DELETE', '/_telium/v1/account'],
      ['PUT', '/_telium/v1/guilds/g/bans/@a:h'],
      ['PATCH', '/_telium/v1/messages/m'],
    ];
    for (const [method, path, body] of refused) {
      expect(repeatable(method, path, body), `${method} ${path} ${JSON.stringify(body)}`).toBeNull();
    }
  });

  it('repeats nonce-carrying sends, reads, and writes that land in the same place', () => {
    const why = repeatable('POST', MESSAGES, { content: 'hello', nonce: 'abc12345' });
    expect(why).toContain('nonce');
    expect(why).toContain('sendonce.rs');
    expect(repeatable('GET', '/_telium/v1/anything')).toBeTruthy();
    expect(repeatable('POST', '/_telium/v1/channels/c/ack')).toContain('MAX');
    expect(repeatable('PUT', '/_telium/v1/messages/m/reactions/%F0%9F%91%8D/@me')).toBeTruthy();
    expect(repeatable('DELETE', '/_telium/v1/channels/c/pins/m')).toBeTruthy();
    expect(repeatable('PUT', '/_telium/v1/sync/prefs.v1')).toBeTruthy();
  });

  it('only calls a failure transient when the server did not run', () => {
    expect(transient(fetchFailure())).toBe(true);
    expect(transient({ status: 503 })).toBe(true);
    expect(transient({ status: 500 })).toBe(false);
    expect(transient({ status: 409 })).toBe(false);
  });

  const attempts = (path, body, mutate) => {
    let sent = 0;
    const send = () => {
      sent += 1;
      mutate?.(body);
      return sent < 3 ? Promise.reject(fetchFailure()) : Promise.resolve('ok');
    };
    return withRetry('POST', path, send, { sleep: () => {}, body }).then(() => sent, () => sent);
  };

  it('retries safe requests until they work and sends unsafe ones exactly once', async () => {
    expect(await attempts('/_telium/v1/channels/c/ack')).toBe(3);
    expect(await attempts(MESSAGES, { content: 'hi', nonce: 'abc12345' })).toBe(3);
    expect(await attempts(MESSAGES, { content: 'hi' })).toBe(1);
    expect(await attempts(MESSAGES, { content: 'hi' }, (b) => { b.nonce = 'abc12345'; })).toBe(1);
  });
});

describe('retry wiring through the real transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const dropOnce = () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length < 2) throw fetchFailure();
      return { ok: true, status: 200, json: async () => ({ id: 'm1' }) };
    }));
    return bodies;
  };
  const api = () => new Api({ base: 'https://home.example', token: 'home-token', domain: 'home.example' });

  it('resends a named message under the same nonce', async () => {
    const bodies = dropOnce();
    expect((await api().send('c1', { content: 'hello', nonce: 'abc12345' })).id).toBe('m1');
    expect(bodies.map((b) => b.nonce)).toEqual(['abc12345', 'abc12345']);
  });

  it('lets an unnamed message send fail rather than guessing', async () => {
    const bodies = dropOnce();
    await expect(api().send('c1', { content: 'hello' })).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });
});

const CANARY = 'zzcanaryzz';
const c = (what) => `${CANARY}-${what}`;
const TOKEN = c('session-token');
const DRAFT = c('draft-text');
const USER = `@${c('user')}:home.example`;
const DRAFT_TARGET = `channel:${c('channel-id')}`;
const HOME = 'home.example';

function seedStorage() {
  localStorage.setItem('telium.session.v1', JSON.stringify({
    home: {
      domain: HOME, base: `https://${HOME}`, token: TOKEN, user_id: USER,
      device_id: c('device-id'), device_secret: c('device-secret'), refresh: c('refresh-token'),
    },
    servers: {
      [HOME]: { token: TOKEN, base: `https://${HOME}` },
      'guilds.example': { token: c('guild-token'), base: 'https://guilds.example' },
    },
  }));
  localStorage.setItem('telium.sync.v1', JSON.stringify({
    'drafts.v2': { value: { [DRAFT_TARGET]: { text: DRAFT, at: 1 } }, updated_at: 5, n: 3 },
    'prefs.v1': { value: { theme: 'dark', nickname: c('nickname') }, updated_at: 5, n: 1 },
    [`unknown.${c('sync-key')}`]: { value: { anything: c('sync-value') }, updated_at: 5, n: 1 },
  }));
  localStorage.setItem('telium.sync.state.v1', JSON.stringify({ sealed: true, live: true }));
  localStorage.setItem('telium.dm-drafts.local.v1', JSON.stringify({ conv: { text: DRAFT } }));
  localStorage.setItem(`telium.identity.pin.v1:${USER}`, JSON.stringify({ key: c('pinned-key') }));
  localStorage.setItem(`telium.auth.opaque.v1:https://${HOME}`, JSON.stringify({ salt: c('opaque') }));
  localStorage.setItem(`telium.leftover.v1:${USER}`, JSON.stringify({ x: c('leftover') }));
}

function fakeStore() {
  return {
    session: JSON.parse(localStorage.getItem('telium.session.v1')),
    guilds: new Map([['g1', { name: c('guild-name') }], ['g2', { name: c('other-guild') }]]),
    channels: new Map([['c1', { name: c('channel-name'), topic: c('topic') }]]),
    messages: new Map([['c1', [{ content: DRAFT, author: USER }]]]),
    friends: new Map([[USER, { display_name: c('friend-name') }]]),
    conversations: [{ id: c('conversation-id'), title: c('conversation-title') }],
    mls: { fingerprint: c('mls-fingerprint') },
    sync: { sealed: true, get: () => ({ [DRAFT_TARGET]: { text: DRAFT, at: 1 } }) },
    gw: {
      connections: new Map([['home.example', {
        domain: 'home.example', role: Role.Home, status: 'degraded', attempt: 4,
        downSince: Date.now() - LONG, lastCode: Close.PROTOCOL_INCOMPATIBLE,
        lastReason: 'home.example speaks v3 and up. Update Telium.',
        failure: () => classify({ code: Close.PROTOCOL_INCOMPATIBLE, role: Role.Home }),
      }]]),
      history: [{ at: Date.now(), domain: 'home.example', role: Role.Home, kind: Kind.AccountHome, code: null }],
    },
  };
}

describe('the diagnostics export', () => {
  beforeEach(() => { localStorage.clear(); seedStorage(); });
  afterEach(() => localStorage.clear());

  it('carries none of the canaries anywhere, in JSON or Markdown', async () => {
    const report = await collect(fakeStore());
    for (const text of [JSON.stringify(report), toMarkdown(report)]) {
      expect(text).not.toContain(CANARY);
    }
  });

  it('has exactly the signed-off top-level sections', async () => {
    const report = await collect(fakeStore());
    expect(Object.keys(report).sort()).toEqual([
      'account', 'build', 'connections', 'counts', 'device', 'dm_encryption',
      'generated_at', 'local_storage', 'recent_failures', 'snapshot', 'sync_store',
    ]);
  });

  it('says whether the engine can actually read, and why it cannot', async () => {
    const store = fakeStore();
    store.mls = {
      ready: true,
      recoveryKey: new Uint8Array(32),
      joined: () => false,
      errorFor: () => new Error('epoch 7 does not follow epoch 4'),
    };
    store.vault = { needs_device: true, locked: false };
    store.custody = { mode: 'device_custody' };
    store.dmFrames = new Map([['x', []]]);

    const report = await collect(store);
    const dm = report.dm_encryption;
    expect(dm.engine_present).toBe(true);
    expect(dm.engine_ready).toBe(true);
    expect(dm.recovery_key).toBe(true);
    expect(dm.conversations).toBe(1);
    expect(dm.in_group).toBe(0);
    expect(dm.loaded).toBe(1);
    expect(dm.awaiting_device).toBe(true);
    expect(dm.custody).toBe('device_custody');
    expect(dm.sync_errors).toEqual(['epoch 7 does not follow epoch 4']);
  });

  it('tells an engine that has not started from one that is broken', async () => {
    const store = fakeStore();
    store.mls = { ready: false };

    const dm = (await collect(store)).dm_encryption;
    expect(dm.engine_present).toBe(true);
    expect(dm.engine_ready).toBe(false);
  });

  it('reports the reason without reporting which conversation it was', async () => {
    const store = fakeStore();
    const long = 'x'.repeat(600);
    store.mls = {
      joined: () => true,
      errorFor: () => new Error(long),
    };
    store.conversations = [
      { id: c('conversation-id') },
      { id: c('other-conversation-id') },
    ];

    const report = await collect(store);
    expect(report.dm_encryption.in_group).toBe(2);
    expect(report.dm_encryption.sync_errors).toHaveLength(1);
    expect(report.dm_encryption.sync_errors[0]).toHaveLength(200);
    for (const text of [JSON.stringify(report), toMarkdown(report)]) {
      expect(text).not.toContain(CANARY);
    }
  });

  it('still says what somebody would need in order to help', async () => {
    const report = await collect(fakeStore());
    expect(report.account.home_domain).toBe('home.example');
    expect(report.counts.guilds).toBe(2);
    expect(report.counts.drafts).toBe(1);
    expect(report.connections[0].close_code).toBe(Close.PROTOCOL_INCOMPATIBLE);
    expect(report.connections[0].close_reason).toContain('Update Telium');
    expect(report.sync_store.unrecognised).toBe(1);
    expect(report.sync_store.rows.map((r) => r.key).sort()).toEqual(['drafts.v2', 'prefs.v1']);
    expect(report.local_storage.unrecognised).toContain('telium.leftover.v1:*');
    const row = report.local_storage.rows.find((r) => r.key === 'telium.sync.v1');
    expect(row.healthy).toBe(true);
    expect(row.bytes).toBeGreaterThan(0);
    expect(report.local_storage.rows.find((r) => r.key === 'telium.identity.pin.v1:*').entries)
      .toBeGreaterThan(0);
  });

  it('notices a poisoned row instead of reporting what is in it', async () => {
    localStorage.setItem('telium.sync.v1', JSON.stringify({ 'prefs.v1': { value: null } }));
    const prefs = (await collect(fakeStore())).sync_store.rows.find((r) => r.key === 'prefs.v1');
    expect(prefs.found_kind).toBe('null');
    expect(prefs.healthy).toBe(false);
  });

  it('reduces a route to its shape', () => {
    expect(routeShape('/channels/01H8XGJWBWBAQ4ZZY/98765')).toBe('/channels/:id/:id');
    expect(routeShape('/settings/appearance')).toBe('/settings/appearance');
  });

  it('local reset keeps the session, drafts and identity pins and drops the rest', async () => {
    const summary = await resetLocalState({ reload: false });
    expect(localStorage.getItem('telium.session.v1')).toContain(TOKEN);
    const mirror = JSON.parse(localStorage.getItem('telium.sync.v1'));
    expect(mirror['drafts.v2'].value[DRAFT_TARGET].text).toBe(DRAFT);
    expect(mirror['drafts.v2'].n).toBe(3);
    expect(mirror['prefs.v1']).toBeUndefined();
    expect(localStorage.getItem('telium.sync.state.v1')).toBeNull();
    expect(localStorage.getItem(`telium.identity.pin.v1:${USER}`)).not.toBeNull();
    expect(summary.kept.join(' ')).toContain('draft');
  });
});
