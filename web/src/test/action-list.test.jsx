import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ActionList, ActionRow } from '../components/index.js';

const Glyph = (props) => <svg {...props} data-testid="glyph" />;

describe('ActionRow', () => {
  it('reads as one pressable thing carrying both lines', () => {
    render(<ActionRow label="Transfer ownership" description="You will stop being the owner." />);
    expect(screen.getByRole('button', { name: /Transfer ownership/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /You will stop being the owner\./ })).toBeTruthy();
  });

  it('calls back when it is pressed', () => {
    const act = vi.fn();
    render(<ActionRow label="Leave guild" onClick={act} />);

    fireEvent.click(screen.getByRole('button', { name: 'Leave guild' }));
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('does not submit the dialog it is sitting in', () => {
    const submitted = vi.fn((e) => e.preventDefault());
    render(<form onSubmit={submitted}><ActionRow label="Leave guild" /></form>);

    fireEvent.click(screen.getByRole('button', { name: 'Leave guild' }));
    expect(submitted).not.toHaveBeenCalled();
  });

  it('marks the destructive one, so it is not drawn like the rest', () => {
    render(<ActionRow label="Delete guild" danger />);
    expect(screen.getByRole('button', { name: 'Delete guild' }).dataset.tone).toBe('danger');
  });

  it('leaves the tone unset for an ordinary row', () => {
    render(<ActionRow label="Leave guild" />);
    expect(screen.getByRole('button', { name: 'Leave guild' }).dataset.tone).toBe(undefined);
  });

  it('draws a glyph when it is given one and nothing when it is not', () => {
    const { unmount } = render(<ActionRow label="Leave guild" icon={Glyph} />);
    expect(screen.getByTestId('glyph')).toBeTruthy();
    unmount();

    render(<ActionRow label="Leave guild" />);
    expect(screen.queryByTestId('glyph')).toBe(null);
  });

  it('is named by its label alone when there is no description', () => {
    render(<ActionRow label="Leave guild" />);
    expect(screen.getByRole('button', { name: 'Leave guild' })).toBeTruthy();
  });
});

describe('ActionList', () => {
  it('holds its rows without becoming a toolbar', () => {
    render(
      <ActionList>
        <ActionRow label="One" />
        <ActionRow label="Two" />
      </ActionList>,
    );

    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('toolbar')).toBe(null);
  });
});
