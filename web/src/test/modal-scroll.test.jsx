import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider, useModal } from '../hooks/useModal.jsx';
import { ModalShell } from '../components/Modal.jsx';
import { Button } from '../components/Button.jsx';
import { InviteLanding } from '../views/InviteLanding.jsx';
import { createFakeServer, freshStore, GUILD } from './fake-server.js';

function TallDialog({ close }) {
  return (
    <ModalShell
      title="Create your account"
      footer={<Button variant="primary" onClick={close}>Create account</Button>}
    >
      {Array.from({ length: 40 }, (_, i) => <p key={i}>{`Line ${i}`}</p>)}
    </ModalShell>
  );
}

function Opener({ options }) {
  const modal = useModal();
  return (
    <button type="button" onClick={() => modal.open((close) => <TallDialog close={close} />, options)}>
      Open
    </button>
  );
}

function open(options) {
  render(
    <ModalProvider>
      <Opener options={options} />
      <ModalHost />
    </ModalProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  const popup = screen.getByRole('dialog');
  return {
    popup,
    body: popup.querySelector('.telium-modal-body'),
    footer: popup.querySelector('.telium-modal-footer'),
  };
}

describe('a dialog too tall for the window', () => {
  it('keeps the primary action out of the part that scrolls', () => {
    const { popup, body, footer } = open();
    const submit = screen.getByRole('button', { name: 'Create account' });

    expect(footer).toBeTruthy();
    expect(footer.contains(submit)).toBe(true);
    expect(body.contains(submit)).toBe(false);

    expect(popup.className).toContain('overflow-hidden');
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('min-h-0');
    expect(body.hasAttribute('data-mobile-scroll')).toBe(true);
  });

  it('caps itself against the viewport that is actually there', () => {
    const { popup } = open();
    const cap = [...popup.classList].find((name) => name.startsWith('max-h-['));

    expect(cap).toBeTruthy();
    expect(cap).toContain('dvh');
    expect(cap).not.toMatch(/\d+vh\b/);
  });

  it('gives a dialog pinned near the top a ceiling of its own', () => {
    const { popup } = open({ place: 'top' });
    expect(popup.className).toContain('modal--top');

    const css = readFileSync(join(import.meta.dirname, '../menu.css'), 'utf8');
    const rule = css.slice(css.indexOf('.modal--top {'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('--modal-max-h:');
  });
});

describe('the invite landing on a short window', () => {
  it('scrolls itself rather than growing past the clip', async () => {
    createFakeServer().install();
    render(
      <StoreProvider store={freshStore()}>
        <ModalProvider>
          <InviteLanding code="INVITE1" base={GUILD} />
          <ModalHost />
        </ModalProvider>
      </StoreProvider>,
    );

    const frame = (await screen.findByRole('main')).closest('.overflow-y-auto');
    await waitFor(() => expect(frame).toBeTruthy());

    expect(frame.className).toContain('h-full');
    expect(frame.className).not.toContain('min-h-screen');
    expect(frame.className).toContain('items-start');
    expect(frame.firstElementChild.className).toContain('my-auto');
  });
});
