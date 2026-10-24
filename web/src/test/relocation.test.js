import { describe, expect, it, vi } from 'vitest';
import { findHomeRelocation, relocateSession } from '../lib/relocation.js';

function serve(routes) {
  return vi.fn(async (url, init = {}) => {
    const path = String(url);
    for (const [match, answer] of Object.entries(routes)) {
      if (path.startsWith(match)) {
        const body = typeof answer === 'function' ? answer(init) : answer;
        if (body === null) return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
        return { ok: true, status: 200, json: async () => body };
      }
    }
    throw new TypeError('Failed to fetch');
  });
}

const HOME = { base: 'https://old.example', domain: 'old.example', token: 'tok', user_id: '@alice:old.example' };

const RECORD = { kind: 'domain_relocation', old_domain: 'old.example', new_domain: 'new.example' };

const OLD_DOC = { server_name: 'old.example', api: 'https://new.example', moved_to: 'new.example', relocation: RECORD };

const NEW_DOC = { server_name: 'new.example', api: 'https://new.example' };

const sameToken = (init) => (init.headers?.Authorization === 'Bearer tok' ? { user_id: '@alice:new.example' } : null);

describe('following a relocated home server', () => {
  it('moves to the new name when the same token works there', async () => {
    global.fetch = serve({
      'https://old.example/.well-known': OLD_DOC,
      'https://new.example/.well-known': NEW_DOC,
      'https://new.example/_telium/v1/whoami': sameToken,
    });
    expect(await findHomeRelocation(HOME)).toEqual({
      domain: 'new.example',
      base: 'https://new.example',
      gateway: 'wss://new.example/gateway/v1',
      user_id: '@alice:new.example',
    });
  });

  it('stays put when nothing has moved', async () => {
    global.fetch = serve({ 'https://old.example/.well-known': { server_name: 'old.example', api: 'https://old.example' } });
    expect(await findHomeRelocation(HOME)).toBeNull();
  });

  it('stays put when the old name cannot be reached', async () => {
    global.fetch = serve({});
    expect(await findHomeRelocation(HOME)).toBeNull();
  });

  it('does not follow a move the new name does not recognise this session for', async () => {
    global.fetch = serve({
      'https://old.example/.well-known': OLD_DOC,
      'https://new.example/.well-known': NEW_DOC,
      'https://new.example/_telium/v1/whoami': () => null,
    });
    expect(await findHomeRelocation(HOME)).toBeNull();
  });

  it('does not follow moved_to without a relocation naming this move', async () => {
    global.fetch = serve({
      'https://old.example/.well-known': { ...OLD_DOC, relocation: { ...RECORD, new_domain: 'other.example' } },
      'https://new.example/.well-known': NEW_DOC,
      'https://new.example/_telium/v1/whoami': sameToken,
    });
    expect(await findHomeRelocation(HOME)).toBeNull();
  });

  it('does not follow a new name whose document says it is somebody else', async () => {
    global.fetch = serve({
      'https://old.example/.well-known': OLD_DOC,
      'https://new.example/.well-known': { ...NEW_DOC, server_name: 'imposter.example' },
      'https://new.example/_telium/v1/whoami': sameToken,
    });
    expect(await findHomeRelocation(HOME)).toBeNull();
  });

  it('renames the stored home and its guild-server entry, keeping the tokens', () => {
    const session = {
      home: { ...HOME, device_id: 'dev', fallback: { standby: 'b.example', path: '/x' } },
      servers: {
        'old.example': { base: 'https://old.example', token: 'guild', gateway: 'wss://old.example/gateway/v1' },
        'other.example': { base: 'https://other.example', token: 'g2', gateway: 'wss://other.example/gateway/v1' },
      },
    };
    const next = relocateSession(session, {
      domain: 'new.example', base: 'https://new.example', gateway: 'wss://new.example/gateway/v1', user_id: '@alice:new.example',
    });
    expect(next.home).toMatchObject({
      domain: 'new.example', base: 'https://new.example', user_id: '@alice:new.example', token: 'tok', device_id: 'dev', fallback: null,
    });
    expect(next.servers['old.example']).toBeUndefined();
    expect(next.servers['new.example']).toEqual({ base: 'https://new.example', token: 'guild', gateway: 'wss://new.example/gateway/v1' });
    expect(next.servers['other.example']).toEqual(session.servers['other.example']);
  });
});
