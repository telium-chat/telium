import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DataTable } from '../components/index.js';

const originalWidth = window.innerWidth;

const setWidth = (value) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value });
};

afterEach(() => { setWidth(originalWidth); });

const columns = [
  { key: 'device', header: 'Device', render: (row) => row.name },
  { key: 'seen', header: 'Last seen', render: (row) => row.seen },
  { key: 'actions', header: '', render: (row) => <button type="button">{`Revoke ${row.name}`}</button> },
];

const rows = [{ name: 'phone', seen: 'just now' }, { name: 'laptop', seen: 'yesterday' }];

describe('an empty list', () => {
  it('says so rather than drawing a table with no rows in it', () => {
    setWidth(1280);
    render(<DataTable label="Devices" rows={[]} columns={columns} empty="No devices signed in." />);

    expect(screen.getByText('No devices signed in.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBe(null);
  });

  it('has something to say even when the caller forgot to write it', () => {
    setWidth(1280);
    render(<DataTable label="Devices" rows={[]} columns={columns} />);
    expect(screen.getByText('Nothing here.')).toBeTruthy();
  });

  it('says so at every width and in every layout', () => {
    setWidth(390);
    const { rerender } = render(<DataTable label="Devices" rows={[]} columns={columns} empty="None." />);
    expect(screen.getByText('None.')).toBeTruthy();

    rerender(<DataTable label="Devices" rows={[]} columns={columns} empty="None." layout="rows" />);
    expect(screen.getByText('None.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBe(null);
  });
});

describe('layout="rows"', () => {
  it('reads a record out as a row at a desktop width, never as a grid', () => {
    setWidth(1280);
    render(<DataTable label="Devices" rows={rows} rowKey={(r) => r.name} columns={columns} layout="rows" />);

    expect(screen.queryByRole('table')).toBe(null);
    expect(screen.getByRole('list', { name: 'Devices' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Revoke phone' })).toBeTruthy();
  });

  it('stays a list when the window is resized, since width was never the reason', () => {
    setWidth(1280);
    render(<DataTable label="Devices" rows={rows} columns={columns} layout="rows" />);

    setWidth(390);
    fireEvent(window, new Event('resize'));

    expect(screen.getByRole('list', { name: 'Devices' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBe(null);
  });
});

describe('the switch between the grid and the card', () => {
  it('restacks when the window crosses into phone width, without a remount', () => {
    setWidth(1280);
    render(<DataTable label="Devices" rows={rows} columns={columns} />);
    expect(screen.getByRole('table', { name: 'Devices' })).toBeTruthy();

    setWidth(390);
    fireEvent(window, new Event('resize'));

    expect(screen.queryByRole('table')).toBe(null);
    expect(screen.getByRole('list', { name: 'Devices' })).toBeTruthy();
  });

  it('stops listening once it is gone', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    setWidth(1280);
    const { unmount } = render(<DataTable label="Devices" rows={rows} columns={columns} />);

    unmount();

    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    remove.mockRestore();
  });
});

describe('the partition', () => {
  it('treats an unheaded column as an action rather than an unlabelled fact', () => {
    setWidth(390);
    render(<DataTable label="Devices" rows={[rows[0]]} columns={columns} layout="rows" />);

    expect(screen.getByRole('button', { name: 'Revoke phone' })).toBeTruthy();
    expect(screen.getByText('Last seen')).toBeTruthy();
  });

  it('leaves out a fact that rendered to nothing, rather than a label with no value', () => {
    setWidth(390);
    render(
      <DataTable
        label="Invites"
        layout="rows"
        rows={[{ code: 'abc', uses: null, note: '', expiry: false }]}
        columns={[
          { key: 'code', header: 'Code', render: (row) => row.code },
          { key: 'uses', header: 'Uses', render: (row) => row.uses },
          { key: 'note', header: 'Note', render: (row) => row.note },
          { key: 'expiry', header: 'Expires', render: (row) => row.expiry },
          { key: 'seen', header: 'Last used', render: () => 'never' },
        ]}
      />,
    );

    expect(screen.getByText('abc')).toBeTruthy();
    expect(screen.getByText('Last used')).toBeTruthy();
    expect(screen.queryByText('Uses')).toBe(null);
    expect(screen.queryByText('Note')).toBe(null);
    expect(screen.queryByText('Expires')).toBe(null);
  });

  it('keeps a zero, which is a number somebody wanted to read', () => {
    setWidth(390);
    render(
      <DataTable
        label="Invites"
        layout="rows"
        rows={[{ code: 'abc', uses: 0 }]}
        columns={[
          { key: 'code', header: 'Code', render: (row) => row.code },
          { key: 'uses', header: 'Uses', render: (row) => row.uses },
        ]}
      />,
    );

    expect(screen.getByText('Uses')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('names the row by its first column in every shape', () => {
    setWidth(390);
    const { rerender } = render(<DataTable label="Devices" rows={[rows[0]]} columns={columns} />);
    expect(screen.getByText('phone')).toBeTruthy();

    rerender(<DataTable label="Devices" rows={[rows[0]]} columns={columns} layout="rows" />);
    expect(screen.getByText('phone')).toBeTruthy();

    setWidth(1280);
    fireEvent(window, new Event('resize'));
    rerender(<DataTable label="Devices" rows={[rows[0]]} columns={columns} />);
    expect(screen.getByRole('rowheader', { name: 'phone' })).toBeTruthy();
  });

  it('draws every row without a rowKey, falling back to the index', () => {
    setWidth(1280);
    render(<DataTable label="Devices" rows={rows} columns={columns} />);
    expect(screen.getAllByRole('row')).toHaveLength(rows.length + 1);
  });
});
