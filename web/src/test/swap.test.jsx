import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { StageSwap, TextSwap, useIsStageGhost } from '../components/index.js';
import { nudge, reduced } from '../components/Swap.jsx';

const realMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

const preferReducedMotion = () => {
  window.matchMedia = (query) => ({
    ...realMatchMedia(query),
    matches: /reduce/.test(query),
  });
};

describe('reduced', () => {
  it('is false by default and true once the preference is set', () => {
    expect(reduced()).toBe(false);
    preferReducedMotion();
    expect(reduced()).toBe(true);
  });

  it('is false where there is no matchMedia at all', () => {
    window.matchMedia = undefined;
    expect(reduced()).toBe(false);
  });
});

describe('TextSwap', () => {
  it('shows its children', () => {
    render(<TextSwap k="a">Save</TextSwap>);
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('keeps the old text for the exit, but only sighted people get it twice', () => {
    const { rerender } = render(<TextSwap k="a">Save</TextSwap>);
    rerender(<TextSwap k="b">Saved</TextSwap>);

    expect(screen.getByText('Saved')).toBeTruthy();
    const leaving = screen.getByText('Save');
    expect(leaving.closest('[aria-hidden="true"]')).toBeTruthy();
  });

  it('makes no ghost when the key has not changed', () => {
    const { rerender } = render(<TextSwap k="a">Save</TextSwap>);
    rerender(<TextSwap k="a">Save changes</TextSwap>);

    expect(screen.queryByText('Save')).toBe(null);
    expect(screen.getByText('Save changes')).toBeTruthy();
  });

  it('makes no ghost at all under reduced motion', () => {
    preferReducedMotion();
    const { rerender } = render(<TextSwap k="a">Save</TextSwap>);
    rerender(<TextSwap k="b">Saved</TextSwap>);

    expect(screen.queryByText('Save')).toBe(null);
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('can be an element other than a span, so it fits inside a button', () => {
    const { container } = render(<TextSwap k="a" as="div">Save</TextSwap>);
    expect(container.firstChild.tagName).toBe('DIV');
  });
});

describe('StageSwap', () => {
  it('shows the current step', () => {
    render(<StageSwap k="one"><p>Pick a server</p></StageSwap>);
    expect(screen.getByText('Pick a server')).toBeTruthy();
  });

  it('holds the old step for its exit, out of reach of anything that reads or tabs', () => {
    const { rerender } = render(
      <StageSwap k="one"><button type="button">Continue</button></StageSwap>,
    );
    rerender(<StageSwap k="two"><button type="button">Finish</button></StageSwap>);

    expect(screen.getByText('Continue')).toBeTruthy();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('Finish');
  });

  it('cuts straight to the new step under reduced motion', () => {
    preferReducedMotion();
    const { rerender } = render(<StageSwap k="one"><p>Pick a server</p></StageSwap>);
    rerender(<StageSwap k="two"><p>Sign in</p></StageSwap>);

    expect(screen.queryByText('Pick a server')).toBe(null);
    expect(screen.getByText('Sign in')).toBeTruthy();
  });

  it('drops the old step even if its exit never reports back', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<StageSwap k="one"><p>Pick a server</p></StageSwap>);
      rerender(<StageSwap k="two"><p>Sign in</p></StageSwap>);
      expect(screen.getByText('Pick a server')).toBeTruthy();

      act(() => { vi.advanceTimersByTime(600); });

      expect(screen.queryByText('Pick a server')).toBe(null);
      expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the leaving copy that it is a ghost', () => {
    const seen = [];
    function Step({ name }) {
      const ghost = useIsStageGhost();
      seen.push([name, ghost]);
      return <p>{name}</p>;
    }

    const { rerender } = render(<StageSwap k="one"><Step name="one" /></StageSwap>);
    expect(seen).toEqual([['one', false]]);

    seen.length = 0;
    rerender(<StageSwap k="two"><Step name="two" /></StageSwap>);

    expect(seen).toContainEqual(['one', true]);
    expect(seen).toContainEqual(['two', false]);
  });

  it('is a plain false outside any stage', () => {
    let ghost = null;
    function Probe() {
      ghost = useIsStageGhost();
      return null;
    }
    render(<Probe />);
    expect(ghost).toBe(false);
  });
});

describe('nudge', () => {
  it('shakes the control that refused', () => {
    const el = { animate: vi.fn() };
    nudge(el);

    expect(el.animate).toHaveBeenCalledTimes(1);
    const [frames, options] = el.animate.mock.calls[0];
    expect(frames.length).toBeGreaterThan(2);
    expect(options.duration).toBeGreaterThan(0);
  });

  it('does nothing rather than throwing when there is nothing to shake', () => {
    expect(() => nudge(null)).not.toThrow();
    expect(() => nudge(undefined)).not.toThrow();
    expect(() => nudge({})).not.toThrow();
  });

  it('stays still under reduced motion', () => {
    preferReducedMotion();
    const el = { animate: vi.fn() };

    nudge(el);

    expect(el.animate).not.toHaveBeenCalled();
  });
});

describe('focus across a step change', () => {
  const Step = ({ id, onNext, field }) => (
    <div>
      <h2>{id}</h2>
      {field ? <input aria-label={`${id} field`} autoFocus /> : null}
      <button type="button" onClick={onNext}>{`leave ${id}`}</button>
    </div>
  );

  function Wizard({ field = false }) {
    const [step, setStep] = useState('one');
    return (
      <StageSwap k={step}>
        <Step id={step} field={field} onNext={() => setStep(step === 'one' ? 'two' : 'one')} />
      </StageSwap>
    );
  }

  it('puts the reader inside the step that arrived, not on the document', async () => {
    const user = userEvent.setup();
    const { container } = render(<Wizard />);

    await user.click(screen.getByRole('button', { name: 'leave one' }));

    expect(document.activeElement).not.toBe(document.body);
    expect(container.querySelector('.stage__cur').contains(document.activeElement)).toBe(true);
  });

  it('parks on the step box itself, which is not a tab stop', async () => {
    const user = userEvent.setup();
    const { container } = render(<Wizard />);

    await user.click(screen.getByRole('button', { name: 'leave one' }));

    const box = container.querySelector('.stage__cur');
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute('tabindex')).toBe('-1');
  });

  it('yields to a step that wanted the caret for its own field', async () => {
    const user = userEvent.setup();
    render(<Wizard field />);

    await user.click(screen.getByRole('button', { name: 'leave one' }));

    expect(document.activeElement?.getAttribute('aria-label')).toBe('two field');
  });

  it('leaves focus alone when the reader was not holding the step', async () => {
    function Outside() {
      const [step, setStep] = useState('one');
      return (
        <div>
          <button type="button" onClick={() => setStep('two')}>outside</button>
          <StageSwap k={step}><p>{step}</p></StageSwap>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Outside />);
    const outside = screen.getByRole('button', { name: 'outside' });

    await user.click(outside);

    expect(document.activeElement).toBe(outside);
  });
});
