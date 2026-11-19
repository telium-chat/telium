import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';
import { Store } from '../lib/store.js';
import { load } from '../lib/vault.js';
import { RecoveryPane } from '../views/user-settings/RecoveryPane.jsx';
import { ConversationNotices } from '../views/chat/encryption.jsx';

// Phase 4: a vault stored in a retired custody mode is locked, and the one thing offered is a new vault, on purpose.
const USER = '@alice:test.example';

class Home {
  constructor(mode, copy = null) {
    this.held = { mode, ciphertext: 'AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAA', independent_ciphertext: copy, version: 3 };
    this.writes = [];
  }

  async vault() { return { exists: true, ...this.held }; }

  async vaultMode() { return { exists: true, mode: this.held.mode, backup: { items: 0, updated_at: null } }; }

  async setVaultMode(body) {
    this.writes.push(body);
    this.held = { mode: body.mode, ciphertext: body.ciphertext, independent_ciphertext: null, version: this.held.version + 1 };
    return { mode: body.mode, version: this.held.version };
  }
}

async function mount({ mode, password = true, copy = null }) {
  const home = new Home(mode, copy);
  const store = new Store();
  store.session = { home: { user_id: USER, device_id: 'd1' } };
  store.home = home;
  store.authRecoveryWrapper = password ? crypto.getRandomValues(new Uint8Array(32)) : null;
  store.vault = await load(home, USER, store.authRecoveryWrapper);
  store.custody = await home.vaultMode();
  store.friendsIn = () => [];
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <ModalProvider>
        <RecoveryPane />
        <ModalHost />
      </ModalProvider>
    </StoreProvider>,
  );
  return { home, store, user };
}

describe('a vault in a retired custody mode', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it.each(['device_custody', 'self_custody', 'escrowed'])('says so in Settings and offers a new vault (%s)', async (mode) => {
    const { store } = await mount({ mode });
    expect(store.vault.retiredMode).toBe(mode);
    expect(screen.getByText('Your encrypted-message keys use a setup Telium has retired.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start a new vault' })).toBeTruthy();
    expect(screen.queryByText(/server-assisted/i)).toBeNull();
    expect(screen.queryByText(/passphrase/i)).toBeNull();
  });

  it('starts a new vault only after the user confirms that the old history stays locked', async () => {
    const { home, store, user } = await mount({ mode: 'escrowed' });
    await user.click(screen.getByRole('button', { name: 'Start a new vault' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/cannot be opened afterwards/)).toBeTruthy();
    expect(home.writes).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Start a new vault' }));
    await waitFor(() => expect(store.vault?.mode).toBe('opaque_custody'));
    expect(store.vault.locked).toBeFalsy();
    expect(home.writes).toHaveLength(1);
    expect(home.writes[0]).toMatchObject({ mode: 'opaque_custody', expected_version: 3 });
    expect(home.held.mode).toBe('opaque_custody');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Start a new vault' })).toBeNull());
  });

  it('asks for a password sign-in instead of writing anything when the session has no password key', async () => {
    const { home, user } = await mount({ mode: 'device_custody', password: false });
    await user.click(screen.getByRole('button', { name: 'Start a new vault' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(home.writes).toEqual([]);
  });

  it('puts Unlock with the recovery key before Start a new vault when a recovery copy exists, and warns that a new vault removes it', async () => {
    const { home, user } = await mount({ mode: 'device_custody', copy: 'k1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    const unlock = screen.getByRole('button', { name: 'Unlock' });
    const fresh = screen.getByRole('button', { name: 'Start a new vault' });
    expect(unlock.compareDocumentPosition(fresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Recovery key')).toBeTruthy();
    await user.click(fresh);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/also removes the recovery-key copy of the old vault/)).toBeTruthy();
    expect(home.writes).toEqual([]);
  });

  it('does not offer the recovery key field on a session without the password key, where it could never work', async () => {
    await mount({ mode: 'device_custody', password: false, copy: 'k1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(screen.queryByLabelText('Recovery key')).toBeNull();
    expect(screen.getByText('Sign out and sign in again with your password, then try again.')).toBeTruthy();
  });

  it('does not talk about a recovery copy when there is none', async () => {
    const { user } = await mount({ mode: 'escrowed' });
    expect(screen.queryByLabelText('Recovery key')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Start a new vault' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/recovery-key copy/)).toBeNull();
  });

  it('says it in the conversation, and not that the passphrase is the way back', async () => {
    const store = {
      mls: {}, vault: { locked: true, retiredMode: 'self_custody', key: null }, rejoinBlocked: new Set(),
    };
    render(<ConversationNotices store={store} conversationId="c1" awaiting={false} changedKey={false} />);
    expect(screen.getByText('This account’s message keys use a setup Telium has retired.')).toBeTruthy();
    expect(screen.getByText(/try your recovery key under Settings → Encryption key/)).toBeTruthy();
    expect(screen.queryByText(/passphrase/i)).toBeNull();
    expect(screen.queryByText('Your older messages are locked on this device.')).toBeNull();
  });
});

