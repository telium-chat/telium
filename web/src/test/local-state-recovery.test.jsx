import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.jsx';
import { RecoveryScreen } from '../views/RecoveryScreen.jsx';
import { Store } from '../lib/store.js';
import {
  DATABASES,
  FAULTS_BEFORE_HEAL,
  HEALTH_STORAGE_KEY,
  beginBoot,
  bootFaults,
  clearCacheState,
  clearIdentityState,
  noteBootFault,
  noteBootHealthy,
  readStored,
  resetBootHealthForTests,
} from '../lib/local-state.js';
import * as snapshot from '../lib/snapshot.js';
import { KEYS, SyncStore } from '../lib/sync.js';
import { heldRecoveryKeyring, rememberRecoveryKeyring } from '../lib/device-secrets.js';
import { createFakeServer, freshStore, HOME } from './fake-server.js';

const ME = '@alice:home.example';
let ids = 0;
const someone = () => `@user${(ids += 1)}:home.example`;
const SESSION_KEY = 'telium.session.v1';
const MIRROR_KEY = 'telium.sync.v1';
const OPAQUE_PIN = 'telium.auth.opaque.v1:https://home.example';
const DRAFTS = 'telium.dm-drafts.local.v1';
const KEYRING = { raw: new Uint8Array([9, 9, 9]), retired: [] };

function seedSession({ base = HOME, domain = 'home.example' } = {}) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    home: {
      base, domain, token: 'home-token', user_id: ME, device_id: 'd1',
      expires_at: Date.now() + 86_400_000, device_secret: null,
    },
    servers: {},
  }));
}

const mirror = (value) => localStorage.setItem(MIRROR_KEY, JSON.stringify(value));
const poisonPrefs = () => mirror({ 'prefs.v1': { value: null, updated_at: 1, n: 1 } });

function openSnapshotDb(fn, onFail) {
  let request;
  try { request = indexedDB.open('telium', 1); } catch { onFail(); return; }
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('snapshot')) request.result.createObjectStore('snapshot');
  };
  request.onsuccess = () => fn(request.result);
  request.onerror = onFail;
}

const putSnapshotRow = (value, userId = ME) => new Promise((resolve, reject) => {
  openSnapshotDb((db) => {
    const tx = db.transaction('snapshot', 'readwrite');
    tx.objectStore('snapshot').put(value, userId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }, reject);
});

const rawSnapshotRow = (userId = ME) => new Promise((resolve) => {
  openSnapshotDb((db) => {
    const get = db.transaction('snapshot', 'readonly').objectStore('snapshot').get(userId);
    get.onsuccess = () => { db.close(); resolve(get.result); };
    get.onerror = () => { db.close(); resolve(undefined); };
  }, () => resolve(undefined));
});

async function databaseExists(name) {
  return (await indexedDB.databases()).some((db) => db.name === name);
}

function load({ consumerThrows = false } = {}) {
  resetBootHealthForTests();
  const healed = beginBoot();
  const store = freshStore();
  if (consumerThrows && localStorage.getItem(MIRROR_KEY) !== null) {
    Object.defineProperty(store, 'prefs', {
      configurable: true,
      get() { throw new TypeError("Cannot read properties of null (reading 'scheme')"); },
    });
  }
  render(<App store={store} />);
  return { store, healed };
}

function armHeal() {
  noteBootFault('a');
  noteBootFault('b');
  resetBootHealthForTests();
  return beginBoot();
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetBootHealthForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readStored', () => {
  it.each([
    ['not JSON', '{"half-written"', () => true],
    ['the wrong shape', JSON.stringify({ count: 'three' }), (v) => typeof v.count === 'number'],
    ['rejected by a validator that throws', JSON.stringify({ home: null }), (v) => v.home.base.length > 0],
  ])('discards and removes a value that is %s', (_what, raw, check) => {
    localStorage.setItem('telium.thing.v1', raw);
    expect(readStored('telium.thing.v1', check)).toBe(null);
    expect(localStorage.getItem('telium.thing.v1')).toBe(null);
  });

  it('survives storage that throws on access', () => {
    const hostile = { getItem() { throw new Error('site data is blocked'); } };
    expect(readStored('telium.thing.v1', () => true, { store: hostile })).toBe(null);
  });
});

describe('a session blob that cannot be read', () => {
  it.each([
    ['unparseable', '{"home":{"base":'],
    ['wrong-shaped', JSON.stringify({ home: { token: 'orphan' }, servers: [] })],
  ])('starts at sign-in when the session is %s, and clears it', async (_what, raw) => {
    createFakeServer().install();
    localStorage.setItem(SESSION_KEY, raw);
    const { store } = load();
    expect(store.session).toBe(null);
    expect(localStorage.getItem(SESSION_KEY)).toBe(null);
    expect(await screen.findByRole('textbox', { name: 'Telium address' })).toBeTruthy();
  });
});

describe('the offline snapshot', () => {
  it('does not strand the client on an unreachable screen when a row is wrong-shaped', async () => {
    await putSnapshotRow({
      version: 1, saved_at: 1, me: null, guilds: 7, channels: [], roles: [],
      emojis: [], readState: [], conversations: [], messages: [],
    });
    createFakeServer().install();
    seedSession();
    load();
    expect(await screen.findByTitle('Add a guild or server')).toBeTruthy();
    expect(screen.queryByText(/Could not reach/)).toBe(null);
  });

  it.each([
    ['wrong-shaped', { version: 1, guilds: 7 }],
    ['from another build', { version: snapshot.VERSION + 1, guilds: [], messages: [] }],
    ['unstamped', { guilds: [], messages: [] }],
  ])('removes a %s row instead of reading it', async (_what, row) => {
    const who = someone();
    await putSnapshotRow(row, who);
    expect(await snapshot.read(who)).toBe(null);
    expect(await rawSnapshotRow(who)).toBe(undefined);
  });

  it('rejects the shapes that used to reach the consumer', () => {
    const good = {
      version: snapshot.VERSION, saved_at: 1, me: { id: ME },
      guilds: [{ id: 'g1' }], channels: [{ id: 'c1' }], roles: [['g1', [{ id: 'r1' }]]],
      emojis: [['g1', []]], readState: [['c1', { last_read_id: '1' }]],
      conversations: [{ id: 'dm1' }], messages: [['c1', [{ id: 'm1' }]]],
    };
    expect(snapshot.valid(good)).toBe(true);
    for (const bad of [
      null, 'a snapshot', [],
      { ...good, version: 'one' }, { ...good, guilds: 7 }, { ...good, guilds: [{ name: 'no id' }] },
      { ...good, me: 'alice' }, { ...good, messages: [['c1', 'not rows']] },
      { ...good, readState: ['c1'] }, { ...good, saved_at: 'yesterday' },
    ]) expect(snapshot.valid(bad)).toBe(false);
  });

  it.each([
    ['a bad top-level field', { version: snapshot.VERSION, guilds: [{ id: 'g1', name: 'Fine' }], channels: 'not a list' }],
    ['a bad row inside a list', { version: 1, guilds: [{ id: 'g1' }], roles: [['g1', [{ id: 'r1' }]]], messages: [[null]], emojis: [null] }],
  ])('refuses a snapshot with %s whole, leaving nothing half-applied', (_what, row) => {
    const store = new Store();
    expect(snapshot.apply(store, row)).toBe(false);
    expect(store.guilds.size).toBe(0);
    expect(store.roles.size).toBe(0);
  });

  it('degrades to a working, cacheless client when indexedDB.open throws', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('the operation is insecure', 'SecurityError');
    });
    expect(await snapshot.read(ME)).toBe(null);
    await expect(snapshot.write(ME, snapshot.capture(new Store()))).resolves.toBe(null);
    await expect(snapshot.clear()).resolves.toBe(null);

    createFakeServer().install();
    seedSession();
    load();
    expect(await screen.findByTitle('Add a guild or server')).toBeTruthy();
  });
});

describe('the recovery screen', () => {
  it('catches a boot throw on a card that offers both resets', async () => {
    createFakeServer().install();
    poisonPrefs();
    load({ consumerThrows: true });

    expect(await screen.findByText(/Something went wrong while rendering/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Still broken after a reload/ }));
    expect(screen.getByRole('button', { name: 'Clear cached data' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Erase device identity/ })).toBeTruthy();
  });

  it('renders with no store, no session and no storage, starting at an h1', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('site data is blocked');
    });
    const openable = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    try {
      render(<RecoveryScreen title="Telium could not start." message="boom" />);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Telium could not start.');
      expect(screen.getByText('boom')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Clear cached data' })).toBeTruthy();
    } finally {
      globalThis.indexedDB = openable;
    }
  });

  it('names what an identity wipe costs, focuses the confirm, and does nothing until confirmed', async () => {
    await rememberRecoveryKeyring(ME, KEYRING);
    seedSession();
    render(<RecoveryScreen title="Telium could not start." />);
    await userEvent.click(screen.getByRole('button', { name: /Erase device identity/ }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Erase and sign out' }));
    for (const text of [/This cannot be undone/, /MLS signing identity/,
      /group state for every encrypted conversation/, /recovery keyring/,
      /You will be signed out on this device/]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/This cannot be undone/)).toBe(null);
    expect((await heldRecoveryKeyring(ME))?.raw).toEqual(KEYRING.raw);
    expect(localStorage.getItem(SESSION_KEY)).not.toBe(null);
  });
});

describe('the fault ledger', () => {
  it('counts only failures that happened before a screen appeared', () => {
    expect(noteBootFault('first')).toBe(1);
    expect(noteBootFault('second')).toBe(2);
    noteBootHealthy();
    expect(bootFaults()).toBe(0);
    expect(noteBootFault('a dialog threw an hour later')).toBe(0);
    expect(localStorage.getItem(HEALTH_STORAGE_KEY)).toBe(null);
  });

  it('heals on the load after the threshold, and not before', async () => {
    mirror({ 'prefs.v1': { value: null } });
    await putSnapshotRow({ version: snapshot.VERSION, guilds: [] });

    noteBootFault('once');
    resetBootHealthForTests();
    expect(beginBoot()).toBe(false);
    expect(localStorage.getItem(MIRROR_KEY)).not.toBe(null);

    noteBootFault('twice');
    expect(bootFaults()).toBe(FAULTS_BEFORE_HEAL);
    resetBootHealthForTests();
    expect(beginBoot()).toBe(true);
    expect(localStorage.getItem(MIRROR_KEY)).toBe(null);
    expect(bootFaults()).toBe(0);

    await snapshot.read(ME);
    expect(await rawSnapshotRow()).toBe(undefined);
  });

  it('keeps identity, session, drafts and the OPAQUE downgrade pin across a heal', async () => {
    await rememberRecoveryKeyring(ME, { raw: new Uint8Array([1, 2, 3]), retired: [] });
    seedSession();
    localStorage.setItem(OPAQUE_PIN, JSON.stringify({ pinned: true }));
    localStorage.setItem(DRAFTS, JSON.stringify({ '@bob:home.example': 'half a' }));
    mirror({ 'prefs.v1': { value: null } });

    expect(armHeal()).toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(localStorage.getItem(MIRROR_KEY)).toBe(null);
    expect(localStorage.getItem(SESSION_KEY)).not.toBe(null);
    expect(localStorage.getItem(OPAQUE_PIN)).not.toBe(null);
    expect(localStorage.getItem(DRAFTS)).not.toBe(null);
    expect((await heldRecoveryKeyring(ME))?.raw).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('arms the heal after two screenless loads and starts clean on the third', async () => {
    createFakeServer().install();
    poisonPrefs();

    for (const attempt of [1, 2]) {
      const { healed } = load({ consumerThrows: true });
      expect(healed).toBe(false);
      expect(await screen.findByText(/Something went wrong while rendering/)).toBeTruthy();
      expect(bootFaults()).toBe(attempt);
      cleanup();
    }

    const { healed } = load({ consumerThrows: true });
    expect(healed).toBe(true);
    expect(await screen.findByRole('textbox', { name: 'Telium address' })).toBeTruthy();
    expect(screen.queryByText(/Something went wrong while rendering/)).toBe(null);
  });
});

describe('a server that is down is not a corrupt disk', () => {
  const OUTAGE_SCREEN_MS = 10_000;
  const openedScreen = (re = /Could not reach dead\.example|Showing your last state/) =>
    screen.findByText(re, {}, { timeout: OUTAGE_SCREEN_MS });

  it('clears the ledger on every load for as long as the outage lasts', async () => {
    createFakeServer().install();
    seedSession({ base: 'https://dead.example', domain: 'dead.example' });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { healed } = load();
      expect(healed).toBe(false);
      expect(await openedScreen()).toBeTruthy();
      expect(bootFaults()).toBe(0);
      cleanup();
    }
    expect(localStorage.getItem(HEALTH_STORAGE_KEY)).toBe(null);
    expect(localStorage.getItem(SESSION_KEY)).not.toBe(null);
  });

  it("wipes a previous load's fault when this load reaches the outage screen", async () => {
    createFakeServer().install();
    seedSession({ base: 'https://dead.example', domain: 'dead.example' });
    noteBootFault('a real failure, one load ago');
    expect(bootFaults()).toBe(1);

    load();
    expect(await openedScreen(/Could not reach dead\.example/)).toBeTruthy();
    expect(bootFaults()).toBe(0);
  });
});

describe('resetting, and what each tier costs', () => {
  it('clears only cache state: keeps identity, session and foreign keys', async () => {
    await rememberRecoveryKeyring(ME, KEYRING);
    await putSnapshotRow({ version: snapshot.VERSION, guilds: [] });
    seedSession();
    mirror({ 'prefs.v1': { value: { theme: 'dark' } } });
    localStorage.setItem('telium.prefs.v1', '{}');
    localStorage.setItem('somebody-elses-key', 'keep me');

    await clearCacheState();

    expect(localStorage.getItem(MIRROR_KEY)).toBe(null);
    expect(localStorage.getItem('telium.prefs.v1')).toBe(null);
    await snapshot.read(ME);
    expect(await rawSnapshotRow()).toBe(undefined);
    expect((await heldRecoveryKeyring(ME))?.raw).toEqual(KEYRING.raw);
    expect(localStorage.getItem(SESSION_KEY)).not.toBe(null);
    expect(localStorage.getItem('somebody-elses-key')).toBe('keep me');
  });

  it('destroys the identity only on the explicit path, signing out first', async () => {
    await rememberRecoveryKeyring(ME, KEYRING);
    seedSession();
    localStorage.setItem(OPAQUE_PIN, JSON.stringify({ pinned: true }));
    localStorage.setItem(DRAFTS, JSON.stringify({ '@bob:home.example': 'half a' }));

    let heldAtSignOut = null;
    await clearIdentityState({ async signOut() { heldAtSignOut = await heldRecoveryKeyring(ME); } });

    expect(heldAtSignOut?.raw).toEqual(KEYRING.raw);
    expect(await databaseExists('telium-device-secrets')).toBe(false);
    expect(await heldRecoveryKeyring(ME)).toBe(null);
    expect(localStorage.getItem(SESSION_KEY)).toBe(null);
    expect(localStorage.getItem(DRAFTS)).not.toBe(null);
    expect(localStorage.getItem(OPAQUE_PIN)).not.toBe(null);
  });

  it('drops the MLS database under the name the module actually opens', async () => {
    expect(DATABASES.identity).toContain('telium-mls');
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('telium-mls', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('groups'); };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    await clearIdentityState(null);
    expect(await databaseExists('telium-mls')).toBe(false);
  });

  it('wipes even when the store is too broken to sign out', async () => {
    await rememberRecoveryKeyring(ME, KEYRING);
    await clearIdentityState({ signOut() { throw new TypeError('cannot read properties of null'); } });
    expect(await heldRecoveryKeyring(ME)).toBe(null);
  });

  it('starts clean after a full reset', async () => {
    await putSnapshotRow({ version: 1, guilds: 7 });
    await rememberRecoveryKeyring(ME, KEYRING);
    seedSession();
    mirror({ 'prefs.v1': { value: null } });
    noteBootFault('the load that sent them here');

    await clearCacheState();
    await clearIdentityState(null);

    createFakeServer().install();
    const { store, healed } = load();
    expect(store.session).toBe(null);
    expect(healed).toBe(false);
    expect(bootFaults()).toBe(0);
    expect(await screen.findByRole('textbox', { name: 'Telium address' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Telium cleared its offline cache/)).toBe(null));
  });
});

describe('the preferences mirror cannot hand the app something it cannot read', () => {
  it.each([['null', null], ['a number', 7], ['a string', 'dark'], ['an array', ['theme']], ['a boolean', false]])(
    'replaces %s under prefs with the default object',
    (_what, value) => {
      mirror({ [KEYS.prefs]: { value, updated_at: 1, n: 0, live: false } });
      const prefs = new SyncStore().get(KEYS.prefs);
      expect(prefs).toBeTypeOf('object');
      expect(prefs).not.toBeNull();
      expect(Array.isArray(prefs)).toBe(false);
      expect(prefs.muted).toBeTypeOf('object');
    },
  );

  it('coerces every synced key to its default container kind', () => {
    mirror({
      [KEYS.emojiRecent]: { value: { 0: 'smile' } },
      [KEYS.emojiTone]: { value: [] },
      [KEYS.drafts]: { value: 7 },
    });
    const store = new SyncStore();
    expect(store.get(KEYS.emojiRecent)).toEqual([]);
    expect(store.get(KEYS.emojiTone)).toBe('');
    expect(store.get(KEYS.drafts)).toEqual({});
  });

  it('leaves a preferences object from a newer build completely alone', () => {
    const fromTheFuture = { theme: 'light', somethingNew: { nested: [1, 2] }, muted: { a: 1 } };
    mirror({ [KEYS.prefs]: { value: fromTheFuture, updated_at: 1, n: 0, live: false } });
    expect(new SyncStore().get(KEYS.prefs)).toEqual(fromTheFuture);
  });

  it('checks values from the home server and from pre-sync legacy keys', () => {
    const fromServer = new SyncStore();
    fromServer.adoptPlain(KEYS.prefs, { value: null, updated_at: Date.now() });
    expect(fromServer.get(KEYS.prefs)).toBeTypeOf('object');
    expect(fromServer.get(KEYS.prefs)).not.toBeNull();

    localStorage.clear();
    localStorage.setItem('telium.prefs.v1', JSON.stringify('dark'));
    const legacy = new SyncStore();
    legacy.adoptLegacy();
    expect(legacy.get(KEYS.prefs)).toBeTypeOf('object');
    expect(legacy.get(KEYS.prefs)).not.toBeNull();
  });
});
