import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalProvider } from '../hooks/useModal.jsx';
import { Store } from '../lib/store.js';
import { activeSunset, describeSunset } from '../lib/sunset.js';
import { SunsetBanner } from '../views/SunsetBanner.jsx';

const HOME = 'home.example';
const LATER = Date.now() + 30 * 24 * 3600 * 1000;
const shutdown = {
  kind: 'domain_sunset', mode: 'shutdown', domain: HOME, new_domain: null,
  effective_at: LATER, message: 'Thanks for everything', announced_at: Date.now(),
  key_id: 'ed25519:k', signature: 'sig',
};

function storeWith(record) {
  const store = new Store();
  store.session = { home: { user_id: '@alice:home.example', device_id: 'd1', domain: HOME } };
  store.home = {
    domain: HOME,
    sunset: vi.fn(async () => record),
    accountBundle: vi.fn(async (proof) => ({ format: 'telium-account-bundle-v1', proof })),
  };
  return store;
}

function show(store) {
  return render(
    <StoreProvider store={store}>
      <ModalProvider>
        <SunsetBanner />
      </ModalProvider>
    </StoreProvider>,
  );
}

describe('sunset notice', () => {
  it('treats no announcement, and a withdrawn one, as nothing', () => {
    expect(activeSunset(null)).toBe(null);
    expect(activeSunset({ mode: 'none', domain: HOME })).toBe(null);
    expect(activeSunset(shutdown)).toBe(shutdown);
    expect(describeSunset({ mode: 'none', domain: HOME })).toBe(null);
  });

  it('does not put a relocation on every screen', () => {
    expect(describeSunset({ ...shutdown, mode: 'relocate', new_domain: 'new.example' })).toBe(null);
  });

  it('says when, and what to do before then', () => {
    const text = describeSunset(shutdown);
    expect(text).toContain(HOME);
    expect(text).toContain(new Date(LATER).toLocaleString());
    expect(text).toContain('move your account to another server');
    expect(text).toContain('download a copy');
  });

  it('says so once the server has shut down', () => {
    const text = describeSunset({ ...shutdown, effective_at: Date.now() - 1000, finalized: true });
    expect(text).toContain('has shut down');
    expect(text).not.toContain('before then');
  });

  it('shows nothing when the home announces nothing', async () => {
    const store = storeWith({ mode: 'none', domain: HOME });
    await store.loadSunset();
    show(store);
    expect(store.sunset).toBe(null);
    expect(screen.queryByRole('status')).toBe(null);
  });

  it('shows the banner and the operator message once the home announces a shutdown', async () => {
    const store = storeWith({ mode: 'none', domain: HOME });
    await store.loadSunset();
    show(store);
    expect(screen.queryByRole('status')).toBe(null);

    store.home.sunset.mockResolvedValue(shutdown);
    await act(() => store.loadSunset());
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('shutting down'));
    expect(screen.getByRole('status').textContent).toContain('Thanks for everything');

    store.home.sunset.mockResolvedValue({ mode: 'none', domain: HOME });
    await act(() => store.loadSunset());
    await waitFor(() => expect(screen.queryByRole('status')).toBe(null));
  });

  it('keeps what login said about the end when start asks again', async () => {
    const store = storeWith(shutdown);
    store.sunset = { ...shutdown, finalized: true };
    await store.loadSunset();
    expect(store.sunset.finalized).toBe(true);
    store.home.sunset.mockRejectedValue(new Error('offline'));
    await store.loadSunset();
    expect(store.sunset.mode).toBe('shutdown');
  });

  it('asks for the password before handing over the bundle', async () => {
    const store = storeWith(shutdown);
    await expect(store.accountBundle('')).rejects.toThrow('password');
    expect(store.home.accountBundle).not.toHaveBeenCalled();

    const bundle = await store.accountBundle('correct horse battery');
    expect(store.home.accountBundle).toHaveBeenCalledWith({ password: 'correct horse battery' });
    expect(bundle.format).toBe('telium-account-bundle-v1');
  });
});
