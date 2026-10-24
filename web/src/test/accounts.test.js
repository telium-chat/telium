import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTS_KEY, MAX_ACCOUNTS, accountOf, activate, listAccounts, rememberSession, roomForAnother,
  stashActive,
} from '../lib/accounts.js';
import { SESSION_KEY } from '../lib/store/shared.js';
import { freshStore } from './fake-server.js';

const ADA = '@ada:one.example';
const BO = '@bo:two.example';

const sessionOf = (user_id, base = 'https://one.example') => ({
  home: { base, domain: new URL(base).host, token: `t-${user_id}`, user_id, device_id: 'd' },
  servers: {},
});

const setJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const getJson = (key) => JSON.parse(localStorage.getItem(key));

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

describe('the account registry', () => {
  it('keeps a session per account, newest first', () => {
    rememberSession(sessionOf(ADA), { touch: true });
    rememberSession(sessionOf(BO), { touch: true });
    const ada = accountOf(ADA);
    rememberSession({ ...sessionOf(ADA), home: { ...sessionOf(ADA).home, token: 'renewed' } });
    expect(accountOf(ADA).session.home.token).toBe('renewed');
    expect(accountOf(ADA).used_at).toBe(ada.used_at);
    expect(listAccounts().map((a) => a.user_id)).toContain(BO);
    expect(listAccounts()).toHaveLength(2);
  });

  it('swaps the sync mirror with the account it belongs to', () => {
    setJson(SESSION_KEY, sessionOf(ADA));
    setJson('telium.sync.v1', { 'prefs.v1': { value: { theme: 'ada' } } });
    setJson('telium.sync.state.v1', { sealed: true, live: true });
    rememberSession(sessionOf(BO, 'https://two.example'));

    stashActive({ name: 'Ada' });
    expect(localStorage.getItem(SESSION_KEY)).toBe(null);
    expect(localStorage.getItem('telium.sync.v1')).toBe(null);
    expect(accountOf(ADA).card.name).toBe('Ada');

    expect(activate(BO)).toBe(true);
    expect(getJson(SESSION_KEY).home.user_id).toBe(BO);
    expect(localStorage.getItem('telium.sync.state.v1')).toBe(null);

    stashActive();
    activate(ADA);
    expect(getJson('telium.sync.v1')['prefs.v1'].value.theme).toBe('ada');
    expect(getJson('telium.sync.state.v1').sealed).toBe(true);
  });

  it('stops at five', () => {
    for (let i = 0; i < MAX_ACCOUNTS; i += 1) rememberSession(sessionOf(`@u${i}:one.example`));
    expect(roomForAnother()).toBe(false);
  });

  it('ignores a registry it cannot read', () => {
    localStorage.setItem(ACCOUNTS_KEY, '"nonsense"');
    expect(listAccounts()).toEqual([]);
  });
});

describe('a store with several accounts', () => {
  it('joins an existing session to the list on start', () => {
    setJson(SESSION_KEY, sessionOf(ADA));
    freshStore();
    expect(accountOf(ADA)).not.toBe(null);
  });

  it('switches by restarting under the other session', async () => {
    setJson(SESSION_KEY, sessionOf(ADA));
    rememberSession(sessionOf(BO, 'https://two.example'));
    const store = freshStore();
    store.restart = vi.fn();
    expect(await store.switchAccount(BO)).toBe(true);
    expect(store.restart).toHaveBeenCalledTimes(1);
    expect(getJson(SESSION_KEY).home.user_id).toBe(BO);
    expect(accountOf(ADA).session.home.token).toBe(`t-${ADA}`);
  });

  it('adds an account without signing anyone out', async () => {
    setJson(SESSION_KEY, sessionOf(ADA));
    const store = freshStore();
    store.restart = vi.fn();
    expect(await store.addAccount()).toBe(true);
    expect(localStorage.getItem(SESSION_KEY)).toBe(null);
    expect(accountOf(ADA)).not.toBe(null);
    expect(store.restart).toHaveBeenCalled();
  });

  it('signing out of one goes straight to the next and keeps its keys', async () => {
    setJson(SESSION_KEY, sessionOf(ADA));
    rememberSession(sessionOf(BO, 'https://two.example'));
    const store = freshStore();
    const restarted = new Promise((resolve) => { store.restart = resolve; });
    const signedOut = vi.fn();
    store.on('signout', signedOut);

    const mls = await import('../lib/mls.js');
    const wipe = vi.spyOn(mls, 'wipe');
    const wipeScope = vi.spyOn(mls, 'wipeScope');

    store.signOut();
    await restarted;
    expect(signedOut).not.toHaveBeenCalled();
    expect(wipe).not.toHaveBeenCalled();
    expect(wipeScope).toHaveBeenCalledWith(ADA);
    expect(accountOf(ADA)).toBe(null);
    expect(getJson(SESSION_KEY).home.user_id).toBe(BO);
    wipe.mockRestore();
    wipeScope.mockRestore();
  });

  it('the last account out signs out as before', () => {
    setJson(SESSION_KEY, sessionOf(ADA));
    const store = freshStore();
    store.restart = vi.fn();
    const signedOut = vi.fn();
    store.on('signout', signedOut);
    store.signOut();
    expect(signedOut).toHaveBeenCalled();
    expect(listAccounts()).toEqual([]);
    expect(store.restart).not.toHaveBeenCalled();
  });

  it('signs out an account that is not on screen', async () => {
    setJson(SESSION_KEY, sessionOf(ADA));
    rememberSession(sessionOf(BO, 'https://two.example'));
    setJson('telium.dm-drafts.local.v1', { [BO]: { c: 'hi' }, [ADA]: { c: 'yo' } });
    const store = freshStore();
    await store.signOutOther(BO);
    expect(accountOf(BO)).toBe(null);
    expect(accountOf(ADA)).not.toBe(null);
    expect(getJson('telium.dm-drafts.local.v1')).toEqual({ [ADA]: { c: 'yo' } });
  });
});

describe('switching in place', () => {
  it('hands the page to a fresh store rather than reloading', async () => {
    setJson(SESSION_KEY, sessionOf(ADA));
    rememberSession(sessionOf(BO, 'https://two.example'));
    const store = freshStore();
    store.replace = vi.fn();
    expect(await store.switchAccount(BO)).toBe(true);
    expect(store.replace).toHaveBeenCalledTimes(1);
  });

  it('hangs up before the account is put away', async () => {
    setJson(SESSION_KEY, sessionOf(ADA));
    rememberSession(sessionOf(BO, 'https://two.example'));
    const store = freshStore();
    store.replace = vi.fn();
    const hangUp = vi.fn();
    store.beforeAway(hangUp);
    await store.switchAccount(BO);
    expect(hangUp).toHaveBeenCalledTimes(1);
  });

  it('a retired store cannot write over the incoming account', async () => {
    setJson(SESSION_KEY, sessionOf(ADA));
    setJson('telium.sync.v1', { 'prefs.v1': { value: { theme: 'ada' } } });
    rememberSession(sessionOf(BO, 'https://two.example'));
    const store = freshStore();
    store.replace = () => store.dispose();
    await store.switchAccount(BO);

    store.session = { ...store.session, home: { ...store.session.home, token: 'late' } };
    store.save();
    store.sync.writeMirror();
    expect(getJson(SESSION_KEY).home.user_id).toBe(BO);
    expect(localStorage.getItem('telium.sync.v1')).toBe(null);
    expect(accountOf(ADA).session.home.token).toBe('late');
  });
});

describe('the scoped MLS wipe', () => {
  it('takes one account\'s rows and leaves the other\'s', async () => {
    const mls = await import('../lib/mls.js');
    const { keepSecret, heldSecret } = mls;
    await keepSecret(ADA, new Uint8Array([1]));
    await keepSecret(BO, new Uint8Array([2]));
    await mls.wipeScope(ADA);
    expect(await heldSecret(ADA)).toBe(null);
    expect(await heldSecret(BO)).toEqual(new Uint8Array([2]));
  });
});
