import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactionPill } from '../components/index.js';

const people = (n) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, name: `Person ${i}` }));

describe('the accessible name', () => {
  it('says the emoji and the count', () => {
    render(<ReactionPill emoji=":wave:" count={4} reactors={people(4)}>{'\u{1F44B}'}</ReactionPill>);
    expect(screen.getByRole('button', { name: ':wave:, 4 reactions' })).toBeTruthy();
  });

  it('counts one reaction in the singular', () => {
    render(<ReactionPill emoji=":wave:" count={1} reactors={people(1)}>{'\u{1F44B}'}</ReactionPill>);
    expect(screen.getByRole('button', { name: ':wave:, 1 reaction' })).toBeTruthy();
  });

  it('says whether this account already reacted, since the press reverses', () => {
    render(<ReactionPill emoji=":wave:" count={2} reacted reactors={people(2)}>{'\u{1F44B}'}</ReactionPill>);
    expect(screen.getByRole('button', { name: ':wave:, 2 reactions, reacted by you' })).toBeTruthy();
  });

  it('does not claim a reaction that is not yours', () => {
    render(<ReactionPill emoji=":wave:" count={2} reactors={people(2)}>{'\u{1F44B}'}</ReactionPill>);
    expect(screen.queryByRole('button', { name: /reacted by you/ })).toBe(null);
  });
});

describe('the pill', () => {
  it('shows the count beside the emoji', () => {
    render(<ReactionPill emoji=":wave:" count={12} reactors={people(12)}>{'\u{1F44B}'}</ReactionPill>);
    const pill = screen.getByRole('button', { name: /:wave:/ });
    expect(pill.textContent).toContain('12');
    expect(pill.textContent).toContain('\u{1F44B}');
  });

  it('toggles when pressed', () => {
    const react = vi.fn();
    render(<ReactionPill emoji=":wave:" count={1} onClick={react}>{'\u{1F44B}'}</ReactionPill>);

    fireEvent.click(screen.getByRole('button', { name: /:wave:/ }));
    expect(react).toHaveBeenCalledTimes(1);
  });

  it('does not submit the composer it sits under', () => {
    const submitted = vi.fn((e) => e.preventDefault());
    render(<form onSubmit={submitted}><ReactionPill emoji=":wave:" count={1}>{'\u{1F44B}'}</ReactionPill></form>);

    fireEvent.click(screen.getByRole('button', { name: /:wave:/ }));
    expect(submitted).not.toHaveBeenCalled();
  });

  it('renders with nobody named, which is what a federated reaction looks like', () => {
    render(<ReactionPill emoji=":wave:" count={3}>{'\u{1F44B}'}</ReactionPill>);
    expect(screen.getByRole('button', { name: ':wave:, 3 reactions' })).toBeTruthy();
  });
});
