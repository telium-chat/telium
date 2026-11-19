import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StoreProvider } from '../hooks/useStore.jsx';
import { Store } from '../lib/store.js';
import { ModalProvider } from '../hooks/useModal.jsx';
import { ProfileCardProvider } from '../views/ProfileCard.jsx';
import { MessageRow } from '../views/chat/MessageRow.jsx';

afterEach(cleanup);

import { PERMISSION_MASKS } from '../lib/perms.js';

const namesToBits = (names) => names.reduce((bits, n) => bits | PERMISSION_MASKS.get(n), 0n);

const ME = '@alice:home.example';
const BOB = '@bob:home.example';

function mount(author, extra = {}) {
  const store = new Store();
  store.me = { user_id: ME };
  const surface = {
    guildId: null,
    perms: namesToBits(['SEND_MESSAGES', 'ADD_REACTIONS']),
    mayEdit: (m) => m.author === ME,
    menu: () => null,
    avatarFor: () => ({}),
    nameFor: () => 'name',
  };
  const onEdit = vi.fn();
  const onReply = vi.fn();
  const msg = {
    id: 'm1', channel_id: 'c1', author, content: 'hello there', created_at: Date.now(),
  };
  render(
    <StoreProvider store={store}><ModalProvider><ProfileCardProvider>
      <MessageRow
        msg={msg}
        surface={surface}
        onEdit={onEdit}
        onReply={onReply}
        {...extra}
      />
    </ProfileCardProvider></ModalProvider></StoreProvider>,
  );
  return { onEdit, onReply, msg };
}

describe('double-clicking a message', () => {
  it('starts a reply to someone else’s message', () => {
    const { onEdit, onReply, msg } = mount(BOB);
    fireEvent.doubleClick(screen.getByText('hello there'));
    expect(onReply).toHaveBeenCalledWith(msg);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('starts editing your own message', () => {
    const { onEdit, onReply } = mount(ME);
    fireEvent.doubleClick(screen.getByText('hello there'));
    expect(onEdit).toHaveBeenCalledWith('m1');
    expect(onReply).not.toHaveBeenCalled();
  });

  it('leaves buttons alone', () => {
    const { onReply } = mount(BOB);
    fireEvent.doubleClick(screen.getByRole('button', { name: /reply/i }));
    expect(onReply).not.toHaveBeenCalled();
  });
});
