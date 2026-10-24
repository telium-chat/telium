import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Crumb, Dots, Flow, Way, Ways } from '../components/index.js';

describe('Flow', () => {
  it('shows the step it was given', () => {
    render(<Flow step="pick"><p>Which server?</p></Flow>);
    expect(screen.getByText('Which server?')).toBeTruthy();
  });

  it('keeps the old step on screen while it leaves, but out of the reading order', () => {
    const { rerender, container } = render(
      <Flow step="one" depth={0}><button type="button">Continue</button></Flow>,
    );
    rerender(<Flow step="two" depth={1}><button type="button">Finish</button></Flow>);

    expect(screen.getByRole('button', { name: 'Finish' })).toBeTruthy();
    expect(container.textContent).toContain('Continue');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBe(null);
  });

  it('takes focus off the control that advanced the step', () => {
    const { rerender } = render(
      <Flow step="one" depth={0}><button type="button">Continue</button></Flow>,
    );
    const advance = screen.getByRole('button', { name: 'Continue' });
    advance.focus();
    expect(document.activeElement).toBe(advance);

    rerender(<Flow step="two" depth={1}><button type="button">Finish</button></Flow>);

    expect(document.activeElement).not.toBe(advance);
  });

  it('keeps each step\u2019s own state, rather than reconciling two unrelated trees', () => {
    const Step = ({ name }) => {
      const id = `${name}-field`;
      return <input id={id} aria-label={name} defaultValue={name} />;
    };

    const { rerender } = render(<Flow step="one" depth={0}><Step name="one" /></Flow>);
    fireEvent.change(screen.getByLabelText('one'), { target: { value: 'typed' } });

    rerender(<Flow step="two" depth={1}><Step name="two" /></Flow>);

    expect(screen.getByLabelText('two').value).toBe('two');
  });
});

describe('Crumb', () => {
  it('is named after where it goes, not after "back"', () => {
    const back = vi.fn();
    render(<Crumb label="Choose a server" onClick={back} />);

    const crumb = screen.getByRole('button', { name: 'Choose a server' });
    fireEvent.click(crumb);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('does not submit the form it is sitting in', () => {
    const submitted = vi.fn((e) => e.preventDefault());
    render(<form onSubmit={submitted}><Crumb label="Back to sign in" onClick={() => {}} /></form>);

    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(submitted).not.toHaveBeenCalled();
  });
});

describe('Way', () => {
  it('is a row you press, not a radio you select', () => {
    const go = vi.fn();
    render(<Way name="Join with an invite" onClick={go} />);

    const way = screen.getByRole('button', { name: /Join with an invite/ });
    expect(screen.queryByRole('radio')).toBe(null);
    fireEvent.click(way);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('carries the sentence under the name when there is one', () => {
    render(<Way name="Host it yourself" description="You will need a domain." />);
    expect(screen.getByRole('button', { name: /You will need a domain\./ })).toBeTruthy();
  });

  it('reads fine with no description and no icon, which is the usual case', () => {
    render(<Way name="Join with an invite" />);
    expect(screen.getByRole('button', { name: 'Join with an invite' })).toBeTruthy();
  });

  it('cannot be taken when it is disabled', () => {
    const go = vi.fn();
    render(<Way name="Create a guild" disabled onClick={go} />);

    const way = screen.getByRole('button', { name: /Create a guild/ });
    expect(way.disabled).toBe(true);
    fireEvent.click(way);
    expect(go).not.toHaveBeenCalled();
  });
});

describe('Dots', () => {
  const markers = (container) => container.querySelectorAll('i');

  it('draws one marker per step', () => {
    const { container } = render(<Dots steps={['a', 'b', 'c']} at="b" />);
    expect(markers(container)).toHaveLength(3);
    expect(container.querySelector('[aria-hidden="true"] i')).toBeTruthy();
  });

  it('writes the position down for a reader who cannot see the fill', () => {
    const { container } = render(<Dots steps={['a', 'b', 'c']} at="b" />);
    expect(container.textContent).toContain('Step 2 of 3');
  });

  it('draws the same markers on a detour, rather than claiming a position', () => {
    const { container } = render(<Dots steps={['a', 'b', 'c']} at="somewhere-else" />);
    expect(markers(container)).toHaveLength(3);
    expect(container.textContent).not.toContain('Step');
  });
});

describe('Ways', () => {
  it('is a column of the rows it was given', () => {
    render(<Ways><Way name="One" /><Way name="Two" /></Ways>);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
