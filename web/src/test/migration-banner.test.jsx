import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalProvider } from '../hooks/useModal.jsx';
import { Store } from '../lib/store.js';
import { MigrationBanner, describeMigration } from '../views/MigrationBanner.jsx';

const HOME = 'home.example';
const LATER = Date.now() + 24 * 3600 * 1000;
const waiting = {
  id: 'm1', subject_type: 'user', subject_id: '@alice:home.example',
  destination: 'new.example', state: 'pending', created_at: Date.now(), executes_at: LATER,
  email: 'sent',
};

function storeWith(alerts) {
  const store = new Store();
  store.session = { home: { user_id: '@alice:home.example', device_id: 'd1', domain: HOME } };
  store.home = {
    domain: HOME,
    migrationAlerts: vi.fn(async () => ({ alerts })),
    cancelMigration: vi.fn(async (id) => ({ id, state: 'cancelled' })),
  };
  return store;
}

function show(store) {
  return render(
    <StoreProvider store={store}>
      <ModalProvider>
        <MigrationBanner />
      </ModalProvider>
    </StoreProvider>,
  );
}

describe('migration banner', () => {
  it('shows nothing when no move is waiting', async () => {
    const store = storeWith([]);
    await store.loadMigrationAlerts();
    show(store);
    expect(screen.queryByRole('alert')).toBe(null);
  });

  it('names the destination and the deadline and cancels through the home', async () => {
    const store = storeWith([waiting]);
    await store.loadMigrationAlerts();
    show(store);

    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('new.example');
    expect(banner.textContent).toContain(new Date(LATER).toLocaleString());
    expect(banner.textContent).toContain('recovery email');

    store.home.migrationAlerts.mockResolvedValue({ alerts: [] });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel move' }));
    expect(store.home.cancelMigration).toHaveBeenCalledWith('m1');
    await waitFor(() => expect(screen.queryByRole('alert')).toBe(null));
  });

  it('appears when the home announces a move and comes down when another device cancels it', async () => {
    const store = storeWith([]);
    await store.loadMigrationAlerts();
    show(store);
    expect(screen.queryByRole('alert')).toBe(null);

    store.home.migrationAlerts.mockResolvedValue({ alerts: [waiting] });
    act(() => store.onDispatch({ domain: HOME, t: 'MIGRATION_ALERT', d: { ...waiting, email: null } }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('new.example'));

    store.home.migrationAlerts.mockResolvedValue({ alerts: [] });
    act(() => store.onDispatch({ domain: HOME, t: 'MIGRATION_UPDATE', d: { ...waiting, state: 'cancelled' } }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBe(null));
  });

  it('ignores a migration event from a server that is not the home', async () => {
    const store = storeWith([]);
    await store.loadMigrationAlerts();
    show(store);
    act(() => store.onDispatch({ domain: 'guilds.example', t: 'MIGRATION_ALERT', d: waiting }));
    expect(screen.queryByRole('alert')).toBe(null);
  });

  it('says a guild is moving when it is the guild', () => {
    const text = describeMigration({ ...waiting, subject_type: 'guild', subject_id: 'g1', email: null });
    expect(text).toContain('The guild g1');
    expect(text).not.toContain('recovery email');
  });
});
