import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TypingIndicator } from '../components/index.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const mount = (ui) => render(ui);

describe('the words', () => {
  it('says one person is typing', () => {
    mount(<TypingIndicator ids={['@alice:home.example']} />);
    expect(screen.getByRole('status').textContent).toBe('alice is typing');
  });

  it('names two or three of them', () => {
    mount(<TypingIndicator ids={['@alice:home.example', '@bob:home.example']} />);
    expect(screen.getByRole('status').textContent).toBe('alice, bob are typing');
  });

  it('stops naming them past three, rather than growing with the room', () => {
    mount(<TypingIndicator ids={['@a:h', '@b:h', '@c:h', '@d:h', '@e:h']} />);
    expect(screen.getByRole('status').textContent).toBe('a, b, c and others are typing');
  });

  it('ignores the gaps a filtered list leaves behind', () => {
    mount(<TypingIndicator ids={['@alice:home.example', null, undefined, '']} />);
    expect(screen.getByRole('status').textContent).toBe('alice is typing');
  });

  it('says nothing at all when nobody is typing', () => {
    render(<TypingIndicator ids={[]} />);
    expect(screen.queryByRole('status')).toBe(null);
  });

  it('survives being handed something that is not a list', () => {
    render(<TypingIndicator ids={null} />);
    expect(screen.queryByRole('status')).toBe(null);
  });
});

describe('the announcement', () => {
  it('lives in a polite live region, so it never interrupts', () => {
    const { container } = mount(<TypingIndicator ids={['@alice:h']} />);
    expect(container.firstChild.getAttribute('aria-live')).toBe('polite');
  });

  it('says the fact once, with the dots hidden beside it', () => {
    const { container } = mount(<TypingIndicator ids={['@alice:h']} />);

    expect(container.querySelector('.typing-dots').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getAllByText('alice is typing')).toHaveLength(1);
  });
});

describe('the line', () => {
  it('is dots and a sentence, whoever is typing', () => {
    for (const ids of [['@a:h'], ['@a:h', '@b:h', '@c:h', '@d:h']]) {
      const { container, unmount } = mount(<TypingIndicator ids={ids} />);
      expect(container.querySelectorAll('.typing-dot')).toHaveLength(3);
      expect(container.querySelector('.typing-faces')).toBe(null);
      expect(container.querySelector('img')).toBe(null);
      unmount();
    }
  });

  it('carries the label class the app asserts on', () => {
    const { container } = mount(<TypingIndicator ids={['@alice:h']} />);
    expect(container.querySelector('.typing-indicator-label').textContent).toBe('alice is typing');
  });
});

describe('the hold', () => {
  it('keeps the line and its words on screen while it leaves', () => {
    const { rerender } = mount(<TypingIndicator ids={['@alice:h']} />);
    rerender(<TypingIndicator ids={[]} />);

    expect(screen.getByRole('status').textContent).toBe('alice is typing');
  });

  it('is gone once the exit is over', () => {
    const { rerender } = mount(<TypingIndicator ids={['@alice:h']} />);
    rerender(<TypingIndicator ids={[]} />);

    act(() => { vi.advanceTimersByTime(200); });

    expect(screen.queryByRole('status')).toBe(null);
  });

  it('catches the line again if somebody starts typing during the exit', () => {
    const { rerender } = mount(<TypingIndicator ids={['@alice:h']} />);
    rerender(<TypingIndicator ids={[]} />);
    rerender(<TypingIndicator ids={['@bob:h']} />);

    act(() => { vi.advanceTimersByTime(200); });

    expect(screen.getByRole('status').textContent).toBe('bob is typing');
  });

  it('follows the cast changing without waiting for an exit', () => {
    const { rerender } = mount(<TypingIndicator ids={['@alice:h']} />);
    rerender(<TypingIndicator ids={['@alice:h', '@bob:h']} />);

    expect(screen.getByRole('status').textContent).toBe('alice, bob are typing');
  });
});
