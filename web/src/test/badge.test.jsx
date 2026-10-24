import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../components/index.js';

describe('the figure', () => {
  it('shows the count up to and including ninety-nine', () => {
    render(<Badge count={99} />);
    expect(screen.getByText('99')).toBeTruthy();
  });

  it('stops counting at a hundred', () => {
    render(<Badge count={100} />);
    expect(screen.getByText('99+')).toBeTruthy();
    expect(screen.queryByText('100')).toBe(null);
  });

  it('stays truncated however far past it goes', () => {
    render(<Badge count={4212} />);
    expect(screen.getByText('99+')).toBeTruthy();
  });

  it('draws a single-digit count as itself', () => {
    render(<Badge count={1} />);
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('passes a string through, because a caller that wrote one has decided', () => {
    render(<Badge count="@" />);
    expect(screen.getByText('@')).toBeTruthy();
  });

  it('does not truncate a string that happens to be a big number', () => {
    render(<Badge count="1000+" />);
    expect(screen.getByText('1000+')).toBeTruthy();
  });
});

describe('nothing waiting', () => {
  it('renders nothing at all, and holds no space', () => {
    const { container } = render(<Badge count={0} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing for an absent count', () => {
    const { container } = render(<Badge count={undefined} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing for an empty string, not an empty pill', () => {
    const { container } = render(<Badge count="" />);
    expect(container.textContent).toBe('');
  });
});

describe('what the call site passes through', () => {
  it('carries an accessible name onto the pill it draws', () => {
    render(<Badge count={3} aria-label="3 unread" />);
    expect(screen.getByLabelText('3 unread').textContent).toBe('3');
  });
});
