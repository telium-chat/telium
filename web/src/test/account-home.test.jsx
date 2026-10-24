import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';
import { LoginView } from '../views/LoginView.jsx';
import { createFakeServer, freshStore } from './fake-server.js';
import { chooseWay } from './sign-in.js';

const HERE = window.location.origin;

function serving(overrides = {}) {
  const server = createFakeServer(overrides);
  server.state.reachable.add(HERE);
  server.install();
  return server;
}

function mount(store) {
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <ModalProvider>
        <LoginView onSignedIn={vi.fn()} />
        <ModalHost />
      </ModalProvider>
    </StoreProvider>,
  );
  return { user };
}

afterEach(() => vi.unstubAllEnvs());

describe('where a new account is offered a home', () => {
  it('asks for no homeserver at all when the serving operator has not asked it to', async () => {
    vi.stubEnv('VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY', 'test-pinned-recommendation-key');
    serving();
    const { user } = mount(freshStore());

    await chooseWay(user, { register: true });

    expect(screen.queryByTestId('account-home-picker')).toBeNull();
    expect(screen.queryByLabelText('Home server')).toBeNull();
    expect(document.querySelector('.stage__cur .auth-host').textContent)
      .toContain(window.location.host);

    await new Promise((done) => { setTimeout(done, 50); });
    expect(screen.queryByTestId('account-home-picker')).toBeNull();
    expect(screen.queryByLabelText('Home server')).toBeNull();
  });

  it('offers the distributed picker when the serving operator has asked it to', async () => {
    vi.stubEnv('VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY', 'test-pinned-recommendation-key');
    serving({ suggestAlternatives: true });
    const { user } = mount(freshStore());

    await chooseWay(user, { register: true });

    await waitFor(() => expect(screen.getByTestId('account-home-picker')).toBeTruthy());
  });

  it('keeps its own counsel on a build that pinned no key, whatever the operator asked for', async () => {
    serving({ suggestAlternatives: true });
    const { user } = mount(freshStore());

    await chooseWay(user, { register: true });

    await new Promise((done) => { setTimeout(done, 50); });
    expect(screen.queryByTestId('account-home-picker')).toBeNull();
    expect(screen.queryByLabelText('Home server')).toBeNull();
    expect(document.querySelector('.stage__cur .auth-host').textContent)
      .toContain(window.location.host);
  });

  it('still lets anyone who wants a different homeserver go and name one', async () => {
    serving();
    const { user } = mount(freshStore());

    await chooseWay(user, { register: true });
    await user.click(await screen.findByRole('button', { name: 'Choose a different home' }));
    const field = await screen.findByRole('textbox', { name: 'Home server' });
    await user.clear(field);
    await user.type(field, 'elsewhere.example');
    expect(field.value).toBe('elsewhere.example');
  });
});
