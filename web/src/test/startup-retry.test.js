import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/api.js';
import { freshStore } from './fake-server.js';

function bootStore() {
  const store = freshStore();
  store.session = { home: { user_id: '@alice:home.example', domain: 'home.example' }, servers: {} };
  return store;
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a homeserver that was out of reach at launch', () => {
  it('runs the whole start again once it answers, not only after a restart', async () => {
    const store = bootStore();
    store.startDegraded = true;
    store.start = vi.fn(async () => { store.startDegraded = false; });
    store.mls = {};

    await store.retryStartup();

    expect(store.start).toHaveBeenCalledTimes(1);
    expect(store.startupPending()).toBe(false);
  });

  it('brings encryption up when it failed to start', async () => {
    const store = bootStore();
    store.startEncryption = vi.fn(async () => { store.mls = {}; });

    await store.retryStartup();

    expect(store.startEncryption).toHaveBeenCalledTimes(1);
    expect(store.startupTimer).toBeFalsy();
  });

  it('asks again on a timer while it is still silent, and stops once nothing is left', async () => {
    const store = bootStore();
    let up = false;
    store.startEncryption = vi.fn(async () => { if (up) store.mls = {}; });
    store.scheduleStartupRetry();

    await vi.advanceTimersByTimeAsync(3000);
    expect(store.startEncryption).toHaveBeenCalledTimes(1);
    expect(store.startupTimer).toBeTruthy();

    up = true;
    await vi.advanceTimersByTimeAsync(10000);
    expect(store.startEncryption).toHaveBeenCalledTimes(2);
    expect(store.mls).toBeTruthy();
    expect(store.startupTimer).toBeFalsy();
    expect(store.startupAttempts).toBe(0);
  });

  it('loads the key again when only the key vault was out of reach', async () => {
    const store = bootStore();
    store.mls = {};
    store.vaultUnavailable(new TypeError('Failed to fetch'));
    expect(store.vaultPending).toBe(true);

    store.openVault = vi.fn(async () => { store.vaultPending = false; });
    await store.retryStartup();

    expect(store.openVault).toHaveBeenCalledWith(store.mls);
    expect(store.startupPending()).toBe(false);
  });

  it('does not keep asking after the homeserver reached and refused', () => {
    const store = bootStore();
    store.mls = {};
    store.vaultUnavailable(new HttpError(403, { error: 'forbidden' }));
    expect(store.vaultPending).toBeFalsy();
    expect(store.startupTimer).toBeFalsy();
  });

  it('does not keep restarting encryption after a failure the network did not cause', async () => {
    const store = bootStore();
    store.startEncryption = vi.fn(async () => {});
    store.encryptionRefused = true;

    await store.retryStartup();

    expect(store.startEncryption).not.toHaveBeenCalled();
    expect(store.startupPending()).toBe(false);
    expect(store.startupTimer).toBeFalsy();
  });

  it('treats a bug as a bug, not as an unreachable homeserver', () => {
    const store = bootStore();
    store.mls = {};
    store.vaultUnavailable(new TypeError("Cannot read properties of undefined (reading 'key')"));
    expect(store.vaultPending).toBeFalsy();
    expect(store.startupTimer).toBeFalsy();
  });

  it('stops asking when the store is disposed', () => {
    const store = bootStore();
    store.scheduleStartupRetry();
    expect(store.startupTimer).toBeTruthy();
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
