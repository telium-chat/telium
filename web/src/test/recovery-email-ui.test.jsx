import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toasted = [];
vi.mock('../hooks/useToast.jsx', () => ({
  toast: (message, opts) => { toasted.push({ message: String(message), error: Boolean(opts?.error) }); },
  ok: (message) => { toasted.push({ message: String(message), error: false }); },
  reportError: (e, context) => {
    const message = e?.body?.message || e?.message || String(e);
    toasted.push({ message: context ? `${context}: ${message}` : message, error: true });
    return message;
  },
  toasts: { add: () => {} },
  ToastHost: () => null,
}));

const { StoreProvider } = await import('../hooks/useStore.jsx');
const { ModalProvider } = await import('../hooks/useModal.jsx');
const { Store } = await import('../lib/store.js');
const { RecoveryEmailSection } = await import('../views/user-settings/AccountPane.jsx');

const HOME = 'home.example';

function storeWith(state, { mailer = true } = {}) {
  const store = new Store();
  store.session = { home: { user_id: `@alice:${HOME}`, device_id: 'd1', domain: HOME } };
  store.home = {
    base: `https://${HOME}`,
    domain: HOME,
    recoveryEmail: vi.fn(async () => state),
    setRecoveryEmail: vi.fn(async () => state),
    membershipMoves: vi.fn(async () => ({ moves: [] })),
  };
  store.caps.set(HOME, { features: { recovery_email: mailer } });
  return store;
}

function show(store) {
  return render(
    <StoreProvider store={store}>
      <ModalProvider>
        <RecoveryEmailSection store={store} />
      </ModalProvider>
    </StoreProvider>,
  );
}

const address = (over) => ({
  state: 'none',
  verified_email: null,
  verified_at: null,
  pending_email: null,
  pending_since: null,
  bounced_at: null,
  bounce_reason: null,
  mailer: true,
  ...over,
});

describe('recovery email', () => {
  beforeEach(() => { toasted.length = 0; });

  it('calls a confirmed address confirmed and an unconfirmed one unconfirmed', async () => {
    const store = storeWith(address({ state: 'verified', verified_email: 'alice@mail.example' }));
    show(store);
    expect((await screen.findByText(/Confirmed: alice@mail.example/)).textContent)
      .toContain('Security warnings about this account go here');
  });

  it('says where warnings still go while a replacement is unconfirmed', async () => {
    const store = storeWith(address({
      state: 'pending',
      verified_email: 'old@mail.example',
      pending_email: 'new@mail.example',
    }));
    show(store);
    const notice = await screen.findByText(/Waiting for new@mail.example to confirm/);
    expect(notice.textContent).toContain('warnings still go to old@mail.example');
  });

  it('does not report a confirmation that was not sent', async () => {
    const store = storeWith(address());
    store.home.setRecoveryEmail = vi.fn(async () => address({
      state: 'pending',
      pending_email: 'alice@mail.example',
      challenge_sent: false,
      challenge_error: 'that address has had too many of these lately',
    }));
    show(store);
    await userEvent.type(await screen.findByLabelText('Recovery email'), 'alice@mail.example');
    await userEvent.type(screen.getByLabelText('Current password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Send a confirmation' }));
    await waitFor(() => expect(toasted.length).toBe(1));
    expect(toasted[0].error).toBe(true);
    expect(toasted[0].message).toContain('no confirmation was sent');
    expect(toasted[0].message).toContain('too many of these lately');
  });

  it('is absent on a server with no mailer, and offers removal when one is on file', async () => {
    const empty = storeWith(address(), { mailer: false });
    const { unmount } = show(empty);
    await waitFor(() => expect(empty.home.recoveryEmail).toHaveBeenCalled());
    expect(screen.queryByText('Recovery email')).toBe(null);
    unmount();

    const held = storeWith(
      address({ state: 'verified', verified_email: 'alice@mail.example' }),
      { mailer: false },
    );
    show(held);
    expect((await screen.findByText(/no longer send email/)).textContent)
      .toContain('You can still remove it');
    expect(screen.getByLabelText('Recovery email').disabled).toBe(true);
  });
});
