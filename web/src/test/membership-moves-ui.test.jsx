import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalProvider } from '../hooks/useModal.jsx';
import { Store } from '../lib/store.js';
import { MembershipMovesSection } from '../views/user-settings/AccountPane.jsx';

function storeWith(moves) {
  const store = new Store();
  store.session = { home: { user_id: '@alice:new.example', device_id: 'd1', domain: 'new.example' } };
  store.home = {
    domain: 'new.example',
    membershipMoves: vi.fn(async () => ({ moves })),
    retryMembershipMoves: vi.fn(async () => ({ retried: 1 })),
  };
  return store;
}

function show(store) {
  return render(
    <StoreProvider store={store}>
      <ModalProvider>
        <MembershipMovesSection store={store} />
      </ModalProvider>
    </StoreProvider>,
  );
}

const move = (over) => ({
  id: 'mv1', old_id: '@alice:old.example', guild_server: 'guilds.example', state: 'done',
  attempts: 1, next_attempt_at: 0, last_error: null, created_at: 1, completed_at: 2,
  guild_ids: ['g1', 'g2'], ...over,
});

describe('membership moves', () => {
  it('shows nothing when no move brought memberships', async () => {
    const store = storeWith([]);
    show(store);
    await waitFor(() => expect(store.home.membershipMoves).toHaveBeenCalled());
    expect(screen.queryByText(/Guild memberships that moved here/)).toBe(null);
  });

  it('shows nothing on a home without the route', async () => {
    const store = storeWith([]);
    store.home.membershipMoves = vi.fn(async () => { throw new Error('404'); });
    show(store);
    await waitFor(() => expect(store.home.membershipMoves).toHaveBeenCalled());
    expect(screen.queryByText(/Guild memberships that moved here/)).toBe(null);
  });

  it('says how far each guild server has got and offers no retry when none gave up', async () => {
    const store = storeWith([
      move(),
      move({ id: 'mv2', guild_server: 'slow.example', state: 'pending', attempts: 3,
        next_attempt_at: Date.now() + 60_000, last_error: 'connection refused', guild_ids: ['g3'] }),
    ]);
    show(store);
    const list = await screen.findByRole('list', { name: 'Guild servers' });
    expect(list.textContent).toContain('guilds.example');
    expect(list.textContent).toContain('Moved');
    expect(list.textContent).toContain('2 guilds');
    expect(list.textContent).toContain('slow.example');
    expect(list.textContent).toContain('Tried 3 times');
    expect(list.textContent).toContain('connection refused');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBe(null);
  });

  it('puts the servers that gave up back in the queue and shows the result', async () => {
    const store = storeWith([
      move({ state: 'failed', attempts: 10, last_error: 'guild server answered 503' }),
    ]);
    show(store);
    const button = await screen.findByRole('button', { name: 'Try again' });
    store.home.membershipMoves.mockResolvedValue({
      moves: [move({ state: 'pending', attempts: 0, next_attempt_at: Date.now() })],
    });
    await userEvent.click(button);
    expect(store.home.retryMembershipMoves).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBe(null));
    expect(screen.getByRole('list', { name: 'Guild servers' }).textContent).toContain('Waiting to be told');
  });
});
