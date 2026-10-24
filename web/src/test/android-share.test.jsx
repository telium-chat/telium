import { useEffect, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModalHost, ModalProvider, useModal } from '../hooks/useModal.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ForwardDialog } from '../views/chat/ForwardDialog.jsx';

function OnMount({ render: draw }) {
  const modal = useModal();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    modal.open(draw);
  }, [modal, draw]);
  return null;
}

describe('Android text sharing', () => {
  it('sends shared text verbatim instead of marking it as a forwarded Telium message', async () => {
    const send = vi.fn(async () => ({ id: 'shared-1' }));
    const close = vi.fn();
    const store = {
      me: { user_id: '@alice:home.example' },
      guilds: new Map([['g1', { id: 'g1', name: 'Telium', domain: 'guilds.example' }]]),
      conversations: [],
      channelsOf: () => [{ id: 'c1', name: 'general', type: 'text' }],
      permissionsIn: () => 2n,
      apiForChannel: () => ({ send }),
    };
    const user = userEvent.setup();
    const shared = 'Worth reading\nhttps://example.com/notes?from=android';

    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <OnMount render={() => (
            <ForwardDialog
              payload={{ text: shared, attachments: [] }}
              shared
              close={close}
            />
          )}
          />
          <ModalHost />
        </ModalProvider>
      </StoreProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Share to Telium' })).toBeTruthy();
    const row = screen.getByText('#general').closest('div');
    await user.click(within(row).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', {
      content: shared,
      attachments: [],
    }));
    expect(send.mock.calls[0][1].content).not.toContain('telium://forward/');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
