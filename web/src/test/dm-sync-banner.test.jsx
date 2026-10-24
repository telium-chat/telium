import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConversationNotices } from '../views/chat/encryption.jsx';

function store({ joined = true } = {}) {
  return {
    mls: { joined: () => joined, errorFor: () => new Error('x') },
    vault: { needs_device: false, locked: false },
    custody: { mode: 'device_custody' },
    resetConversation: vi.fn(async () => ({ missing: [] })),
  };
}

function render_({ syncError, ...rest } = {}) {
  return render(
    <ConversationNotices
      store={store()}
      conversationId="dm1"
      awaiting={false}
      changedKey={false}
      syncError={syncError}
      onRetry={() => {}}
      {...rest}
    />,
  );
}

describe('the encryption-is-out-of-sync banner', () => {
  it('says why, in the crypto layer’s own words', () => {
    render_({ syncError: new Error('epoch 7 does not follow epoch 4') });

    expect(screen.getByText('epoch 7 does not follow epoch 4')).toBeTruthy();
    expect(screen.getByText(/out of sync/i)).toBeTruthy();
  });

  it('includes the cause underneath the error that was thrown', () => {
    const inner = new Error('ratchet tree does not match the commitment');
    const outer = new Error('could not process application message');
    outer.cause = inner;
    render_({ syncError: outer });

    const shown = document.querySelector('.enc-notice__detail').textContent;
    expect(shown).toContain('could not process application message');
    expect(shown).toContain('ratchet tree does not match the commitment');
  });

  it('reads a server error off its body', () => {
    const err = new Error('409');
    err.body = { message: 'this commit was built on an epoch that has already been replaced' };
    render_({ syncError: err });

    expect(document.querySelector('.enc-notice__detail').textContent)
      .toContain('already been replaced');
  });

  it('truncates a reason that would not fit', () => {
    render_({ syncError: new Error('y'.repeat(900)) });

    const shown = document.querySelector('.enc-notice__detail').textContent;
    expect(shown.length).toBeLessThanOrEqual(301);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('offers a way out, and does not arm it on the first press', async () => {
    render_({ syncError: new Error('epoch 7 does not follow epoch 4') });

    const arm = screen.getByRole('button', { name: /start the conversation over/i });
    expect(arm).toBeTruthy();
    expect(screen.queryByRole('button', { name: /yes, start over/i })).toBeNull();
  });

  it('still offers the retry', () => {
    render_({ syncError: new Error('epoch 7 does not follow epoch 4') });

    expect(screen.getByRole('button', { name: /retry sync/i })).toBeTruthy();
  });

  it('draws nothing when there is no error', () => {
    render_({ syncError: null });

    expect(document.querySelector('.enc-notice__detail')).toBeNull();
    expect(screen.queryByText(/out of sync/i)).toBeNull();
  });
});
