import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UploadsPane } from '../views/user-settings/UploadsPane.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';

const file = (hash, filename, size, extra = {}) => ({
  hash, filename, size, mime: 'image/png', created_at: 1_700_000_000_000,
  in_messages: 0, shared: false, deletable: true, ...extra,
});

function setup(files) {
  let list = files;
  const home = {
    listOwnMedia: vi.fn(async () => ({
      used_bytes: list.reduce((n, f) => n + f.size, 0), quota_bytes: 10_000,
      breakdown: { profile: { count: 1, bytes: 500 } }, files: list, next_offset: null,
    })),
    ownMediaMessage: vi.fn(async () => ({ channel_id: 'c1', message_id: 'm1' })),
    deleteMedia: vi.fn(async (hash) => { list = list.filter((f) => f.hash !== hash); }),
  };
  const store = {
    session: { home: { domain: 'home.example' } },
    home,
    loadCapabilities: vi.fn(async () => ({})),
    jumpTo: vi.fn(() => true),
    on: () => () => {},
  };
  const onClose = vi.fn();
  render(
    <StoreProvider store={store}>
      <ModalProvider><UploadsPane onClose={onClose} /><ModalHost /></ModalProvider>
    </StoreProvider>,
  );
  return { home, store, onClose };
}

describe('the uploads pane', () => {
  it('lists files, deletes the selection and refreshes the quota figure', async () => {
    const user = userEvent.setup();
    const { home, store } = setup([
      file('a', 'big.png', 3000), file('b', 'small.png', 100),
      file('c', 'shared.png', 50, { shared: true, deletable: false }),
    ]);
    await screen.findByText('big.png');
    expect(screen.getByRole('checkbox', { name: 'shared.png' }).getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('checkbox', { name: 'big.png' }));
    await user.click(screen.getByRole('button', { name: /Delete 1 selected/ }));
    await user.click(await screen.findByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(home.deleteMedia).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(screen.queryByText('big.png')).toBeNull());
    expect(store.loadCapabilities).toHaveBeenCalledWith('home.example');
    expect(home.deleteMedia).toHaveBeenCalledTimes(1);
  });
});

describe('the uploads pane on odd servers', () => {
  it('names an encrypted DM attachment honestly', async () => {
    setup([file('e', 'attachment.bin', 500, { mime: 'application/octet-stream' })]);
    expect(await screen.findByRole('checkbox', { name: 'Encrypted file (direct message)' })).toBeTruthy();
  });
});

describe('expiry and jumping to the message', () => {
  it('shows when each file expires and jumps to its message', async () => {
    const user = userEvent.setup();
    const { store, onClose } = setup([
      file('a', 'soon.png', 100, { in_messages: 1, expires_at: Date.now() + 86_400_000 }),
      file('b', 'forever.png', 50),
    ]);
    await screen.findByText('soon.png');
    expect(screen.getAllByText(/^Expires /).length).toBe(1);
    expect(screen.getByText('Does not expire')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show in chat' }));
    await waitFor(() => expect(store.jumpTo).toHaveBeenCalledWith('c1', 'm1'));
    expect(onClose).toHaveBeenCalled();
  });
});
