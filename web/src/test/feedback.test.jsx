import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Async, EmptyState, Loading, Notice, ProgressBar, RowSkeleton, Spinner,
} from '../components/index.js';

const content = (data) => <p>{`Loaded ${data.length}`}</p>;

describe('Async', () => {
  it('shows a placeholder shaped like the thing it is waiting for', () => {
    render(<Async state={{ loading: true }}>{content}</Async>);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
    expect(screen.queryByText(/Loaded/)).toBe(null);
  });

  it('shows the failure before anything else, even with data already in hand', () => {
    render(
      <Async state={{ loading: false, error: new Error('nope'), data: ['a'] }}>{content}</Async>,
    );
    expect(screen.getByText('That did not load')).toBeTruthy();
    expect(screen.queryByText('Loaded 1')).toBe(null);
  });

  it('prefers the sentence the server wrote to the one fetch would have', () => {
    render(
      <Async state={{ error: { body: { message: 'You are not in this guild.' }, message: 'HTTP 403' } }}>
        {content}
      </Async>,
    );
    expect(screen.getByText('You are not in this guild.')).toBeTruthy();
    expect(screen.queryByText('HTTP 403')).toBe(null);
  });

  it('falls back to the thrown message, and then to the thing itself', () => {
    const { unmount } = render(<Async state={{ error: new Error('offline') }}>{content}</Async>);
    expect(screen.getByText('offline')).toBeTruthy();
    unmount();

    render(<Async state={{ error: 'just a string' }}>{content}</Async>);
    expect(screen.getByText('just a string')).toBeTruthy();
  });

  it('says a list is empty when the caller gave it words for that', () => {
    render(<Async state={{ data: [] }} empty="No bans yet.">{content}</Async>);
    expect(screen.getByText('No bans yet.')).toBeTruthy();
  });

  it('treats absent data as empty too', () => {
    render(<Async state={{ data: null }} empty="No bans yet.">{content}</Async>);
    expect(screen.getByText('No bans yet.')).toBeTruthy();
  });

  it('renders the content for a non-empty list', () => {
    render(<Async state={{ data: ['a', 'b'] }} empty="No bans yet.">{content}</Async>);
    expect(screen.getByText('Loaded 2')).toBeTruthy();
  });

  it('hands an empty list to the children when no empty text was given', () => {
    render(<Async state={{ data: [] }}>{content}</Async>);
    expect(screen.getByText('Loaded 0')).toBeTruthy();
  });

  it('renders content for data that is not a list at all', () => {
    render(<Async state={{ data: { length: 7 } }} empty="Nothing.">{content}</Async>);
    expect(screen.getByText('Loaded 7')).toBeTruthy();
  });
});

describe('the announcing', () => {
  it('makes the sentence the live region, not the spinner', () => {
    render(<Loading label="Fetching members..." />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Fetching members...');
  });

  it('has something to announce by default', () => {
    render(<Loading />);
    expect(screen.getByRole('status').textContent).toContain('Loading...');
  });

  it('keeps a bare spinner out of the accessibility tree', () => {
    const { container } = render(<Spinner />);
    expect(container.firstChild.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('status')).toBe(null);
  });

  it('keeps a skeleton out of it too, and marks the block busy', () => {
    render(<RowSkeleton rows={2} />);
    const busy = screen.getByLabelText('Loading');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.textContent).toBe('');
  });
});

describe('ProgressBar', () => {
  it('carries the value to assistive tech, not only to a width', () => {
    render(<ProgressBar value={42} label="Uploading avatar" />);
    const bar = screen.getByRole('progressbar', { name: 'Uploading avatar' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
  });

  it('is named even when the caller did not name it', () => {
    render(<ProgressBar value={0} />);
    expect(screen.getByRole('progressbar', { name: 'Upload progress' })).toBeTruthy();
  });
});

describe('Notice', () => {
  it('interrupts for a failure and does not for a limitation', () => {
    const { unmount } = render(<Notice tone="danger">Your session expired.</Notice>);
    expect(screen.getByRole('alert').textContent).toContain('Your session expired.');
    unmount();

    render(<Notice tone="warn">This build cannot do that yet.</Notice>);
    expect(screen.queryByRole('alert')).toBe(null);
    expect(screen.getByText('This build cannot do that yet.')).toBeTruthy();
  });

  it('keeps a heading and two blocks as structure rather than one paragraph', () => {
    render(
      <Notice>
        <h3>Federation</h3>
        <p>First.</p>
        <p>Second.</p>
      </Notice>,
    );
    expect(screen.getByRole('heading', { name: 'Federation' })).toBeTruthy();
    expect(screen.getByText('First.')).toBeTruthy();
  });
});

describe('EmptyState', () => {
  it('says both halves when it has both', () => {
    render(<EmptyState title="No pins">Pin a message to keep it here.</EmptyState>);
    expect(screen.getByText('No pins')).toBeTruthy();
    expect(screen.getByText('Pin a message to keep it here.')).toBeTruthy();
  });

  it('works with only the sentence, which is how most panes call it', () => {
    render(<EmptyState>Nothing here.</EmptyState>);
    expect(screen.getByText('Nothing here.')).toBeTruthy();
  });
});
