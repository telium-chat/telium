import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { Store } from '../lib/store.js';
import { load } from '../lib/vault.js';

const stub = vi.hoisted(() => ({ wrapper: null, rejects: false }));

vi.mock('../lib/store/shared.js', async (original) => ({
  ...(await original()),
  secureAuth: async () => ({
    currentWrapperOpaque: async () => {
      if (stub.rejects) throw new Error('That password was not accepted.');
      return { recoveryWrapper: stub.wrapper, ksfVersion: 1 };
    },
  }),
}));

const USER = '@friend:home.test';

class Home {
  constructor() { this.held = null; }

  async vault() {
    return this.held ? { exists: true, ...this.held, version: 1 } : { exists: false };
  }

  async putVault(body) { this.held = body; return { version: 1 }; }

  async setVaultMode(body) { this.held = body; return { version: 2 }; }

  async vaultMode() { return { exists: Boolean(this.held), mode: this.held?.mode || 'none' }; }
}

describe('an opaque vault on a device that signed in without the password', () => {
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

  it('opens with the password alone, no other device or recovery key', async () => {
    stub.wrapper = crypto.getRandomValues(new Uint8Array(32));
    stub.rejects = false;
    const home = new Home();
    const made = await load(home, USER, stub.wrapper, null);
    globalThis.indexedDB = new IDBFactory(); // a device that holds no ring

    const store = new Store();
    store.session = { home: { user_id: USER, device_id: 'd2' } };
    store.home = home;
    store.opaqueAuth = true;
    store.route = {};
    store.vault = await load(home, USER, null, null);
    expect(store.vault).toMatchObject({ locked: true, needs_device: true, needs_password: true });

    stub.rejects = true;
    await expect(store.unlockVaultWithPassword('wrong')).rejects.toThrow(/not accepted/);
    expect(store.vault.locked).toBe(true);

    stub.rejects = false;
    const opened = await store.unlockVaultWithPassword('right');
    expect(Array.from(opened.raw)).toEqual(Array.from(made.raw));
    expect(store.vault.locked).toBeFalsy();
    expect(store.authRecoveryWrapper).toEqual(stub.wrapper);
  });

  describe('trust after the ring arrives', () => {
    const ring = { key: new Uint8Array(32), mode: 'opaque_custody' };
    const withTrust = (held) => {
      const store = new Store();
      store.trust = held;
      const fresh = { canSign: true, sealRootProperly: vi.fn() };
      // As the real one: the running instance if there is one, otherwise a new start.
      store.startTrust = vi.fn(async () => {
        if (!store.trust) store.trust = fresh;
        return store.trust;
      });
      return { store, fresh };
    };

    it('starts trust again when the running one could not open the root', async () => {
      const held = { canSign: false, sealRootProperly: vi.fn() };
      const { store, fresh } = withTrust(held);
      await store.trustWithAccountKey(ring);
      expect(store.trust).toBe(fresh);
      expect(fresh.recovery).toBe(ring);
      expect(held.sealRootProperly).not.toHaveBeenCalled();
    });

    it('keeps a trust that holds the root and seals it under the account key', async () => {
      const held = { canSign: true, sealRootProperly: vi.fn(async () => true) };
      const { store } = withTrust(held);
      await store.trustWithAccountKey(ring);
      expect(store.trust).toBe(held);
      expect(held.recovery).toBe(ring);
      expect(held.sealRootProperly).toHaveBeenCalledWith(ring.key);
    });

    it('keeps the old trust when the restart fails', async () => {
      const held = { canSign: false, sealRootProperly: vi.fn() };
      const store = new Store();
      store.trust = held;
      store.startTrust = vi.fn(async () => null);
      await store.trustWithAccountKey(ring);
      expect(store.trust).toBe(held);
    });
  });
});
