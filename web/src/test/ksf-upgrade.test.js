import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionMethods } from '../lib/store/session.js';

// The key-stretching move (`upgradeKsf`) at a sign-in, when the answer to its one write is lost. `KSF_CURRENT` is 2 here,
// as it will be once a second set exists (the table has only version 1 today, so nothing is behind yet).
const stub = vi.hoisted(() => ({
  change: null,
  current: null,
}));

vi.mock('../lib/store/shared.js', async (original) => ({
  ...(await original()),
  secureAuth: async () => ({
    KSF_CURRENT: 2,
    changePasswordOpaque: (...args) => stub.change(...args),
    currentWrapperOpaque: (...args) => stub.current(...args),
  }),
}));

vi.mock('../lib/vault.js', async (original) => ({
  ...(await original()),
  load: async () => ({ raw: new Uint8Array(32), retired: [], mode: 'opaque_custody', version: 7 }),
  rewrapCiphertext: async () => 'rewrapped',
}));

const OLD = new Uint8Array([1]);
const NEW = new Uint8Array([2]);
const resp = { access_token: 't', user_id: '@a:h.test', server_name: 'h.test' };

const store = () => Object.assign(Object.create(sessionMethods), {});
const run = () => store().upgradeKsf(resp, 'http://h.test', 'pw', OLD, null);
const lost = () => Object.assign(new Error('no answer'), { status: 503, finishUnanswered: true });

describe('moving to the current key-stretching set when the answer is lost', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub.change = async () => ({ recoveryWrapper: NEW, ksfVersion: 2 });
    stub.current = async () => { throw new Error('not asked'); };
  });

  it('hands back the new wrapper when the write is answered', async () => {
    expect((await run()).recoveryWrapper).toBe(NEW);
  });

  it('keeps the old wrapper when the write was refused, since nothing changed', async () => {
    stub.change = async () => { throw Object.assign(new Error('refused'), { status: 409, finishUnanswered: false }); };
    expect(await run()).toBeNull();
  });

  it('keeps the old wrapper when the write failed before it was sent', async () => {
    stub.change = async () => { throw new Error('could not reach the server'); };
    expect(await run()).toBeNull();
  });

  it('takes the new wrapper when the lost answer was for a write that landed', async () => {
    stub.change = async () => { throw lost(); };
    stub.current = async () => ({ recoveryWrapper: NEW, ksfVersion: 2 });
    expect(await run()).toMatchObject({ recoveryWrapper: NEW, ksfVersion: 2 });
  });

  it('keeps the old wrapper when the write did not land', async () => {
    stub.change = async () => { throw lost(); };
    stub.current = async () => ({ recoveryWrapper: OLD, ksfVersion: 1 });
    expect(await run()).toBeNull();
  });

  it('uses no wrapper at all when it cannot tell, so the vault is never sealed under a stale key', async () => {
    stub.change = async () => { throw lost(); };
    stub.current = async () => { throw new Error('still no answer'); };
    expect(await run()).toEqual({ recoveryWrapper: null, ksfVersion: null });
  });
});
