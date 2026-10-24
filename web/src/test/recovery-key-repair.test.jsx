import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ed25519 } from '@noble/curves/ed25519.js';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';
import { generateAccountRecovery, recoveryPublicKey } from '../lib/account-recovery.js';
import { Store } from '../lib/store.js';
import { load } from '../lib/vault.js';
import { unb64 } from '../lib/util.js';
import { RecoveryPane } from '../views/user-settings/RecoveryPane.jsx';

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const USER = '@alice:test.example';
const te = new TextEncoder();

class FakeRecoveryHome {
  constructor() {
    this.held = null;
    this.publicKey = null;
    this.attempts = new Map();
    this.modes = [];
  }

  async vault() {
    if (!this.held) return { exists: false };
    return {
      exists: true,
      mode: this.held.mode,
      ciphertext: this.held.ciphertext,
      independent_ciphertext: this.held.independent_ciphertext || null,
      recovery_key_enrolled: Boolean(this.publicKey),
    };
  }

  async putVault(body) {
    this.held = {
      mode: body.mode,
      ciphertext: body.ciphertext,
      independent_ciphertext: body.independent_ciphertext || null,
    };
  }

  async setVaultMode(body) {
    this.modes.push(body);
    const before = this.held?.independent_ciphertext || null;
    this.held = {
      mode: body.mode,
      ciphertext: body.ciphertext,
      independent_ciphertext: body.clear_independent
        ? null
        : body.independent_ciphertext || before,
    };
  }

  async vaultMode() {
    const v = await this.vault();
    return {
      exists: Boolean(v.exists),
      mode: v.mode || 'none',
      server_can_recover: false,
      recovery_copy_missing: v.mode === 'opaque_custody'
        && Boolean(v.recovery_key_enrolled) && !v.independent_ciphertext,
      backup: { items: 0, updated_at: null, server_can_read: false },
    };
  }

  async recoveryCopyStart() {
    const id = `attempt-${this.attempts.size + 1}`;
    const challenge = b64(crypto.getRandomValues(new Uint8Array(16)));
    this.attempts.set(id, challenge);
    return { user_id: USER, attempt_id: id, challenge };
  }

  async recoveryCopyFinish({ attempt_id: id, recovery_vault_ciphertext: copy, signature }) {
    const challenge = this.attempts.get(id);
    this.attempts.delete(id);
    const payload = te.encode(
      `telium-recovery-k1-restore:v1|${USER}|${id}|${challenge}|${copy}`,
    );
    let ok = false;
    try {
      ok = Boolean(challenge) && ed25519.verify(unb64(signature), payload, unb64(this.publicKey));
    } catch { ok = false; }
    if (!ok) throw new Error('invalid recovery proof');
    if (this.held.independent_ciphertext) throw new Error('already has a copy');
    this.held.independent_ciphertext = copy;
    return { recovery_copy_restored: true };
  }
}

async function brokenAccount() {
  const recovery = generateAccountRecovery();
  const home = new FakeRecoveryHome();
  const wrapper = crypto.getRandomValues(new Uint8Array(32));
  const original = await load(home, null, USER, wrapper, recovery.vaultWrapper);
  home.publicKey = recovery.publicKey;
  expect(home.held.independent_ciphertext).toMatch(/^k1\./);
  home.held.independent_ciphertext = null;

  const store = new Store();
  store.session = { home: { user_id: USER, device_id: 'd1' } };
  store.home = home;
  store.authRecoveryWrapper = wrapper;
  store.vault = await load(home, null, USER, wrapper);
  store.custody = await home.vaultMode();
  store.friendsIn = () => [];
  return { recovery, home, store, original };
}

function renderPane(store) {
  return render(
    <StoreProvider store={store}>
      <ModalProvider>
        <RecoveryPane />
        <ModalHost />
      </ModalProvider>
    </StoreProvider>,
  );
}

describe('a recovery key whose copy of the vault went missing', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('puts the copy back when the key is typed in, and the copy opens the same keyring', async () => {
    const { recovery, home, store, original } = await brokenAccount();
    expect(store.custody.recovery_copy_missing).toBe(true);
    expect(recoveryPublicKey(recovery.text)).toBe(home.publicKey);

    await expect(store.restoreRecoveryCopy(generateAccountRecovery().text))
      .rejects.toThrow(/invalid recovery proof/);
    expect(home.held.independent_ciphertext).toBe(null);

    await store.restoreRecoveryCopy(recovery.text);
    expect(home.held.independent_ciphertext).toMatch(/^k1\./);
    expect(store.vault.recoveryKey).toBe(true);
    expect(store.custody.recovery_copy_missing).toBe(false);

    globalThis.indexedDB = new IDBFactory();
    const elsewhere = await load(home, null, USER, null, recovery.vaultWrapper);
    expect(b64(elsewhere.raw)).toBe(b64(original.raw));
  });

  it('offers to reconnect the key in the recovery settings', async () => {
    const { recovery, home, store } = await brokenAccount();
    const user = userEvent.setup();
    renderPane(store);

    const button = screen.getByRole('button', { name: 'Reconnect my key' });
    expect(button.disabled).toBe(true);
    await user.type(screen.getByLabelText('Recovery key'), recovery.text);
    await user.click(button);

    await waitFor(() => expect(home.held.independent_ciphertext).toMatch(/^k1\./));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reconnect my key' })).toBe(null));
  });
});

describe('replacing a recovery key', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('asks the server to swap, and a failure leaves the old copy in place', async () => {
    const recovery = generateAccountRecovery();
    const home = new FakeRecoveryHome();
    const wrapper = crypto.getRandomValues(new Uint8Array(32));
    await load(home, null, USER, wrapper, recovery.vaultWrapper);
    home.publicKey = recovery.publicKey;
    const copy = home.held.independent_ciphertext;

    const store = new Store();
    store.session = { home: { user_id: USER, device_id: 'd1' } };
    store.home = home;
    store.authRecoveryWrapper = wrapper;
    store.vault = await load(home, null, USER, wrapper);
    store.custody = await home.vaultMode();
    store.friendsIn = () => [];
    store.enrollRecoveryKey = vi.fn(async () => {
      throw new Error('invalid credentials');
    });
    expect(store.vault.recoveryKey).toBe(true);

    const user = userEvent.setup();
    renderPane(store);
    await user.click(screen.getByRole('button', { name: 'Make a new recovery key' }));
    await user.click(await screen.findByRole('button', { name: 'Make a new one' }));
    await user.type(await screen.findByLabelText('Your password'), 'not the password');
    await user.click(screen.getByRole('button', { name: 'Make the new key' }));

    await waitFor(() => expect(store.enrollRecoveryKey).toHaveBeenCalled());
    expect(store.enrollRecoveryKey).toHaveBeenCalledWith('not the password', { replace: true });
    expect(home.modes).toEqual([]);
    expect(home.held.independent_ciphertext).toBe(copy);
    expect(store.vault.recoveryKey).toBe(true);
  });
});
