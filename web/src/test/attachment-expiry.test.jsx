import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExpiryNote } from '../views/chat/Attachments.jsx';

const DAY = 24 * 60 * 60 * 1000;

describe('the expiry note on a sent attachment', () => {
  it('counts the remaining life of a file the origin will sweep', () => {
    render(<ExpiryNote att={{ expires_at: Date.now() + 6 * DAY }} />);
    expect(screen.getByText(/Expires/).textContent).toMatch(/Expires in \d+d/);
  });

  it('says when the file is already gone', () => {
    render(<ExpiryNote att={{ expires_at: Date.now() - DAY }} />);
    expect(screen.getByText('This file has expired')).toBeTruthy();
  });

  it('says nothing when the origin keeps the file', () => {
    render(<ExpiryNote att={{}} />);
    expect(screen.queryByText(/Expires/)).toBeNull();
    expect(screen.queryByText(/expired/)).toBeNull();
  });
});
