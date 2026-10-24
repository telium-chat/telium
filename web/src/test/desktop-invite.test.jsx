import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';
import { InviteLanding } from '../views/InviteLanding.jsx';
import { App } from '../App.jsx';
import { createFakeServer, freshStore, GUILD, HOME } from './fake-server.js';

vi.mock('../views/LoginView.jsx', () => ({
  LoginView: ({ onInvite }) => (
    <main>
      <h1>Sign in stand-in</h1>
      <button type="button" onClick={() => onInvite?.({ base: 'https://guilds.example', code: 'INVITE1' })}>
        Paste invite
      </button>
    </main>
  ),
}));

function requestedUrls() {
  return fetch.mock.calls.map(([input]) => String(input?.url || input));
}

describe('an invite pasted on desktop', () => {
  it('asks the server the link named, not the page origin', async () => {
    const server = createFakeServer();
    server.install();
    const store = freshStore();
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <InviteLanding code="INVITE1" base={GUILD} onBack={onBack} />
          <ModalHost />
        </ModalProvider>
      </StoreProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Telium' })).toBeTruthy();
    const urls = requestedUrls();
    expect(urls.some((url) => url.startsWith(`${GUILD}/`) && url.includes('INVITE1'))).toBe(true);
    expect(urls.some((url) => url.startsWith(window.location.origin))).toBe(false);
    expect(document.querySelector('.auth-host').textContent).toContain('guilds.example');

    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('offers the way back to sign in on a dead invite instead of the page root', async () => {
    const server = createFakeServer();
    server.install();
    const store = freshStore();
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <InviteLanding code="NOSUCHINVITE" base={GUILD} onBack={onBack} />
        </ModalProvider>
      </StoreProvider>,
    );

    await screen.findByRole('heading', { name: /invite/i });
    expect(screen.queryByRole('button', { name: 'Go to Telium' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('keeps the web invite screen as it was when no way back is given', async () => {
    const server = createFakeServer();
    server.install();
    const store = freshStore();
    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <InviteLanding code="INVITE1" base={GUILD} />
        </ModalProvider>
      </StoreProvider>,
    );

    await screen.findByRole('heading', { name: 'Telium' });
    expect(screen.queryByRole('button', { name: 'Back to sign in' })).toBeNull();
  });

  it('turns the sign-in screen into the invite, and back again', async () => {
    const server = createFakeServer();
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);

    await user.click(await screen.findByRole('button', { name: 'Paste invite' }));
    expect(await screen.findByRole('heading', { name: 'Telium' })).toBeTruthy();
    expect(screen.getByText(/alice invited you to join/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await screen.findByRole('heading', { name: 'Sign in stand-in' })).toBeTruthy();
  });

  it('signs up and joins from a pasted invite, then opens the guild', async () => {
    const server = createFakeServer({ userId: '@new:home.example' });
    server.install();
    sessionStorage.setItem('telium.lastHome', HOME);
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);

    await user.click(await screen.findByRole('button', { name: 'Paste invite' }));
    await screen.findByRole('heading', { name: 'Telium' });
    await user.type(screen.getByLabelText('Display name'), 'New Person');
    await user.type(screen.getByLabelText('Username'), 'new');
    await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Create account & join Telium' }));

    await waitFor(() => expect(server.state.joins).toEqual(['INVITE1']), { timeout: 15_000 });
    expect(store.session.home.domain).toBe('home.example');
    expect(store.route).toMatchObject({ view: 'chat', guildId: 'g1' });
    await waitFor(() => expect(screen.queryByText(/alice invited you to join/i)).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Sign in stand-in' })).toBeNull();
  });
});
