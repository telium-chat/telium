import { useEffect, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useModal } from '../hooks/useModal.jsx';
import { ChangelogDialog } from '../views/dialogs/ChangelogDialog.jsx';
import { mount, signedInStore } from './harness.jsx';

const READ_ROW = 'telium.changelog.v1';

const SAMPLE = `
# Telium changelog

## 15 October 2026

- Feedback came in-app: **Settings → Help & feedback**.
- The desktop address field opens the web client.

## 14 October 2026

- Native installs get an updater, Raspberry Pi included.
`;

const ok = (body) => async () => ({
  ok: true,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

const seed = (row) => localStorage.setItem(READ_ROW, JSON.stringify(row));

function mountOpened(ui) {
  function Opener() {
    const modal = useModal();
    const done = useRef(false);
    useEffect(() => {
      if (done.current) return;
      done.current = true;
      modal.open(() => ui, { wide: true });
    }, [modal]);
    return null;
  }
  return mount(<Opener />, signedInStore());
}

describe('ChangelogDialog', () => {
  it('renders the fetched entries, newest first, and marks the newest read', async () => {
    vi.stubGlobal('fetch', ok(SAMPLE));
    mountOpened(<ChangelogDialog />);
    expect(await screen.findByText('15 October 2026')).toBeTruthy();
    expect(screen.getByText('14 October 2026')).toBeTruthy();
    expect(screen.queryByText('**Settings → Help & feedback**')).toBeNull();
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(READ_ROW)).read).toBe('15 October 2026');
    });
    expect(await screen.findByText('Full changelog on GitHub')).toBeTruthy();
  });

  it('offline with a saved copy shows the copy under an honest notice, and still reads it', async () => {
    seed({ read: null, at: Date.now() - 7 * 60 * 60 * 1000, text: SAMPLE });
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 0 }));
    mountOpened(<ChangelogDialog />);
    expect(await screen.findByText(
      "Couldn't fetch the latest changelog just now — showing your saved copy.",
    )).toBeTruthy();
    expect(screen.getByText('15 October 2026')).toBeTruthy();
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(READ_ROW)).read).toBe('15 October 2026');
    });
  });

  it('offline with nothing saved offers the two ways out', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 0 }));
    mountOpened(<ChangelogDialog />);
    expect(await screen.findByText('Try again')).toBeTruthy();
    expect(screen.getByText('Open on GitHub')).toBeTruthy();
    expect(screen.queryByText('15 October 2026')).toBeNull();
  });

  it('tells the caller when it unmounts, however it was closed', async () => {
    vi.stubGlobal('fetch', ok(SAMPLE));
    const onClosed = vi.fn();
    mountOpened(<ChangelogDialog onClosed={onClosed} />);
    await screen.findByText('15 October 2026');
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
  });
});
