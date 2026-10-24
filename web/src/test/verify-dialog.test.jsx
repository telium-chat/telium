import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVerificationLifetime } from '../views/dialogs/VerifyDialog.jsx';

function Probe({ store, exchange }) {
  useVerificationLifetime(store, exchange);
  return null;
}

describe('verification dialog lifetime', () => {
  it('does not cancel a live verification during the StrictMode effect remount', async () => {
    const store = { endVerification: vi.fn() };
    const exchange = { txn: 'verify-strict-mode' };

    const mounted = render(
      <StrictMode>
        <Probe store={store} exchange={exchange} />
      </StrictMode>,
    );

    await act(async () => { await Promise.resolve(); });
    expect(store.endVerification).not.toHaveBeenCalled();

    mounted.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(store.endVerification).toHaveBeenCalledTimes(1);
    expect(store.endVerification).toHaveBeenCalledWith('verify-strict-mode');
  });
});
