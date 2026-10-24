import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { LoginView } from '../views/LoginView.jsx';
import { createFakeServer, freshStore, HOME } from './fake-server.js';
import { chooseRecovery, signIn } from './sign-in.js';

function mount(store) {
  const onSignedIn = vi.fn();
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <ModalProvider>
        <LoginView onSignedIn={onSignedIn} />
        <ModalHost />
      </ModalProvider>
    </StoreProvider>,
  );
  return { user, onSignedIn };
}

const KEY = 'telium-recovery-v1-AQgPFh0kKzI5QEdOVVxjanF4f4aNlJuiqbC3vsXM09o';

describe('account recovery UI', () => {
  it('shows a recovery key after a real current-server registration', async () => {
    const server = createFakeServer({
      userId: '@new:home.example',
      recoveryKeyReset: true,
    });
    server.install();
    const store = freshStore();
    const { user, onSignedIn } = mount(store);

    await signIn(user, { home: HOME, username: 'new', register: true });

    expect(await screen.findByText('Save your recovery key', {}, { timeout: 15_000 })).toBeTruthy();
    expect(screen.getByText(/^telium-recovery-v1-/)).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(store.signedIn).toBe(false);
  });


  it('stops after registration until the generated recovery key is saved', async () => {
    const key = 'telium-recovery-v1-abcdefghijklmnopqrstuvwxyz0123456789';
    const store = {
      signIn: vi.fn().mockResolvedValue({
        user_id: '@alice:home.example',
        recovery_key: key,
      }),
      confirmRecoveryKey: vi.fn().mockResolvedValue(key),
    };
    const { user, onSignedIn } = mount(store);

    await signIn(user, { home: HOME, password: 'correct horse battery', register: true });

    expect(await screen.findByText('Save your recovery key')).toBeTruthy();
    expect(screen.getByText(key)).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();

    sessionStorage.setItem('telium.pending-account-recovery.v1', key);
    await user.click(screen.getByRole('button', { name: 'I saved my recovery key' }));

    expect(sessionStorage.getItem('telium.pending-account-recovery.v1')).toBeNull();
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('offers recovery-key password reset from the sign-in screen', async () => {
    createFakeServer({ recoveryKeyReset: true }).install();
    const store = {
      resetPassword: vi.fn().mockResolvedValue({
        user_id: '@alice:home.example',
      }),
    };
    const { user, onSignedIn } = mount(store);

    const address = await screen.findByRole('textbox', { name: 'Telium address' });
    await user.type(address, '@alice:home.example');
    await chooseRecovery(user);
    expect(screen.getByRole('textbox', { name: 'Username' }).value).toBe('@alice:home.example');
    await user.type(screen.getByLabelText('Recovery key'), KEY);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('New password'), 'a much newer password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a much newer password');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(store.resetPassword).toHaveBeenCalledWith(
      'https://home.example',
      '@alice:home.example',
      KEY,
      'a much newer password',
      { home: 'https://home.example' },
    );
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });
});
