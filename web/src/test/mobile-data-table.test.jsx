import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataTable } from '../components/index.js';

const originalWidth = window.innerWidth;

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: originalWidth,
  });
});

describe('mobile data tables', () => {
  it('restacks administrative records into readable cards on a phone', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 390,
    });

    render(
      <DataTable
        label="Devices"
        rows={[{ id: 'phone', seen: 'just now' }]}
        rowKey={(row) => row.id}
        columns={[
          { key: 'device', header: 'Device', render: (row) => row.id },
          { key: 'seen', header: 'Last seen', render: (row) => row.seen },
          {
            key: 'actions',
            header: '',
            render: () => <button type="button">Revoke</button>,
          },
        ]}
      />,
    );

    expect(screen.getByRole('list', { name: 'Devices' })).toBeTruthy();
    expect(screen.getByRole('listitem')).toBeTruthy();
    expect(screen.getByText('phone')).toBeTruthy();
    expect(screen.getByText('Last seen')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();
  });

  it('keeps the first desktop cell as the row header', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1280,
    });

    render(
      <DataTable
        label="Devices"
        rows={[{ id: 'phone', seen: 'just now' }]}
        rowKey={(row) => row.id}
        columns={[
          { key: 'device', header: 'Device', render: (row) => row.id },
          { key: 'seen', header: 'Last seen', render: (row) => row.seen },
        ]}
      />,
    );

    expect(screen.getByRole('table', { name: 'Devices' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'phone' })).toBeTruthy();
  });
});
