import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalProvider } from '../hooks/useModal.jsx';
import { generateAccountRecovery } from '../lib/account-recovery.js';
import { Store } from '../lib/store.js';
import { load, open } from '../lib/vault.js';
import { RecoveryPane } from '../views/user-settings/RecoveryPane.jsx';

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const OLD_USER = '@alice:old.example';
const NEW_USER = '@alice:new.example';

class FakeVaultHome {
  constructor(held = null) {
    this.held = held;
    this.modeChanges = 0;
  }

  async vault() {
    if (!this.held) return { exists: false };
    return {
      exists: true,
      mode: this.held.mode,
      ciphertext: this.held.ciphertext,
      independent_ciphertext: this.held.independent_ciphertext || null,
      server_can_recover: Boolean(this.held.escrow_key),
    };
  }

  async putVault(body) {
    this.held = {
      mode: body.mode,
      ciphertext: body.ciphertext,
      escrow_key: body.escrow_key || null,
      independent_ciphertext: body.independent_ciphertext || null,
    };
  }

  async setVaultMode(body) {
    this.modeChanges += 1;
    this.held = {
      mode: body.mode,
      ciphertext: body.ciphertext,
      escrow_key: body.mode === 'escrowed' ? (body.escrow_key || null) : null,
      independent_ciphertext: body.independent_ciphertext || null,
    };
  }

  async vaultMode() {
    const v = await this.vault();
    return {
      exists: Boolean(v.exists),
      mode: v.mode || 'none',
      server_can_recover: Boolean(v.server_can_recover),
      backup: { items: 0, updated_at: null, server_can_read: false },
    };
  }
}

async function migrated() {
  const recovery = generateAccountRecovery();
  const oldWrapper = crypto.getRandomValues(new Uint8Array(32));
  const old = new FakeVaultHome();
  const original = await load(old, null, OLD_USER, oldWrapper, recovery.vaultWrapper);
  expect(old.held.mode).toBe('opaque_custody');
  expect(old.held.independent_ciphertext).toMatch(/^k1\./);

  const destination = new FakeVaultHome({
    mode: old.held.mode,
    ciphertext: old.held.ciphertext,
    independent_ciphertext: old.held.independent_ciphertext,
    escrow_key: null,
  });
  globalThis.indexedDB = new IDBFactory();
  const newWrapper = crypto.getRandomValues(new Uint8Array(32));
  return { recovery, original, destination, newWrapper };
}

describe('a vault that moved with its account', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('is locked at the new server until the recovery key opens it, then re-wrapped', async () => {
    const { recovery, original, destination, newWrapper } = await migrated();

    const locked = await load(destination, null, NEW_USER, newWrapper);
    expect(locked.locked).toBe(true);
    expect(locked.needs_recovery_key).toBe(true);
    expect(locked.needs_password).toBe(false);
    expect(destination.modeChanges).toBe(0);

    const other = generateAccountRecovery();
    const wrong = await load(destination, null, NEW_USER, newWrapper, other.vaultWrapper);
    expect(wrong.locked).toBe(true);
    expect(wrong.needs_recovery_key).toBe(true);

    const opened = await load(destination, null, NEW_USER, newWrapper, recovery.vaultWrapper);
    expect(opened.locked).toBeFalsy();
    expect(b64(opened.raw)).toBe(b64(original.raw));
    expect(destination.modeChanges).toBe(1);
    expect(destination.held.mode).toBe('opaque_custody');
    expect(destination.held.escrow_key).toBe(null);
    await expect(open(newWrapper, destination.held.ciphertext)).resolves.toBeTruthy();

    globalThis.indexedDB = new IDBFactory();
    const routine = await load(destination, null, NEW_USER, newWrapper);
    expect(routine.locked).toBeFalsy();
    expect(b64(routine.raw)).toBe(b64(original.raw));
  });

  it('opens through the store with the recovery key typed in', async () => {
    const { recovery, original, destination, newWrapper } = await migrated();
    const store = new Store();
    store.session = { home: { user_id: NEW_USER, device_id: 'd1' } };
    store.home = destination;
    store.authRecoveryWrapper = newWrapper;
    store.vault = await load(destination, null, NEW_USER, newWrapper);
    expect(store.vault.locked).toBe(true);

    await expect(store.unlockVault('not the key')).rejects.toThrow(/passphrase/);
    await expect(store.unlockVault('telium-recovery-v1-AA')).rejects.toThrow(/malformed/i);
    const otherKey = generateAccountRecovery().text;
    await expect(store.unlockVault(otherKey)).rejects.toThrow(/recovery key did not open/);
    expect(store.vault.locked).toBe(true);

    const opened = await store.unlockVault(recovery.text);
    expect(b64(opened.raw)).toBe(b64(original.raw));
    expect(store.vault.locked).toBeFalsy();
    expect(store.accountRecoveryWrapper).toEqual(recovery.vaultWrapper);
    expect(store.custody.mode).toBe('opaque_custody');
    await expect(open(newWrapper, destination.held.ciphertext)).resolves.toBeTruthy();
  });

  it('asks for the recovery key in the recovery settings', async () => {
    const { recovery, original, destination, newWrapper } = await migrated();
    const store = new Store();
    store.session = { home: { user_id: NEW_USER, device_id: 'd1' } };
    store.home = destination;
    store.authRecoveryWrapper = newWrapper;
    store.vault = await load(destination, null, NEW_USER, newWrapper);
    store.custody = await destination.vaultMode();
    store.friendsIn = () => [];

    const user = userEvent.setup();
    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <RecoveryPane />
        </ModalProvider>
      </StoreProvider>,
    );

    const input = screen.getByLabelText('Recovery key');
    const button = screen.getByRole('button', { name: 'Unlock' });
    expect(button.disabled).toBe(true);
    await user.type(input, recovery.text);
    expect(button.disabled).toBe(false);
    await user.click(button);

    await waitFor(() => expect(store.vault?.key).toBeTruthy());
    expect(b64(store.vault.raw)).toBe(b64(original.raw));
    await waitFor(() => expect(screen.queryByLabelText('Recovery key')).toBe(null));
    await expect(open(newWrapper, destination.held.ciphertext)).resolves.toBeTruthy();
  });
});
