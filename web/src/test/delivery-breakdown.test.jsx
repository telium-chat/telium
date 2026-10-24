import { useEffect, useRef } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModalHost, ModalProvider, useModal } from '../hooks/useModal.jsx';
import { DeliveryDetails } from '../views/chat/DeliveryDetails.jsx';

function OnMount({ ui }) {
  const modal = useModal();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    modal.open(() => ui);
  }, [modal, ui]);
  return null;
}

function open(people, state) {
  return render(
    <ModalProvider>
      <OnMount ui={<DeliveryDetails close={vi.fn()} people={people} state={state} />} />
      <ModalHost />
    </ModalProvider>,
  );
}

describe('delivery breakdown', () => {
  it('names each person once with their device count, and nobody else', () => {
    const { baseElement, getByText, queryByText } = open([
      { userId: '@bob:h', devices: 2, read: false },
      { userId: '@dana:h', devices: 1, read: true },
    ], 'delivered');

    const listed = [...baseElement.querySelectorAll('[data-delivered-to]')]
      .map((row) => row.getAttribute('data-delivered-to'));
    expect(listed).toEqual(['@bob:h', '@dana:h']);
    expect(getByText('on 2 devices')).toBeTruthy();
    expect(getByText('on 1 device')).toBeTruthy();
    expect(getByText('read')).toBeTruthy();
    expect(queryByText(/not delivered|unread|no receipt/i)).toBeNull();
  });

  it('says an older client’s account-level word is a device it did not name', () => {
    const { getByText } = open([{ userId: '@old:h', devices: 0, read: false }], 'delivered');
    expect(getByText('device not stated')).toBeTruthy();
  });

  it('draws an empty list as nothing yet rather than as nobody', () => {
    const { baseElement, getByText } = open([], 'sent');
    expect(baseElement.querySelectorAll('[data-delivered-to]')).toHaveLength(0);
    expect(getByText(/No acknowledgements yet/)).toBeTruthy();
    expect(getByText('Nothing yet.')).toBeTruthy();
  });
});
