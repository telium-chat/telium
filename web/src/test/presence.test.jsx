import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PRESENCE, PRESENCE_STATES, Presence } from '../components/index.js';

describe('the four states', () => {
  it('names every state a menu can choose', () => {
    expect(PRESENCE_STATES).toEqual(['online', 'idle', 'dnd', 'invisible']);
    for (const state of PRESENCE_STATES) {
      expect(PRESENCE[state].label).toBeTruthy();
      expect(PRESENCE[state].icon).toBeTruthy();
    }
  });

  it('spells out what the two non-obvious ones do', () => {
    expect(PRESENCE.dnd.note).toBe('no notifications');
    expect(PRESENCE.invisible.note).toBe('you appear offline');
  });

  it('gives each drawn badge its own name', () => {
    for (const [status, label] of [['online', 'Online'], ['idle', 'Idle'], ['dnd', 'Do not disturb'], ['offline', 'Offline']]) {
      const { unmount } = render(<Presence status={status} />);
      expect(screen.getByRole('img', { name: label })).toBeTruthy();
      unmount();
    }
  });

  it('draws a shape and not only a colour', () => {
    for (const status of ['online', 'idle', 'dnd', 'offline']) {
      const { container, unmount } = render(<Presence status={status} />);
      expect(container.querySelector('path').getAttribute('d')).toBeTruthy();
      unmount();
    }
  });

  it('gives the four states four different shapes', () => {
    const shapes = new Set();
    for (const status of ['online', 'idle', 'dnd', 'offline']) {
      const { container, unmount } = render(<Presence status={status} />);
      shapes.add(container.querySelector('path').getAttribute('d'));
      unmount();
    }
    expect(shapes.size).toBe(4);
  });
});

describe('the states that draw nothing', () => {
  it('draws nothing for a status nobody has told us', () => {
    const { container } = render(<Presence status={null} />);
    expect(container.firstChild).toBe(null);
  });

  it('draws nothing for a status it does not recognise', () => {
    const { container } = render(<Presence status="away-ish" />);
    expect(container.firstChild).toBe(null);
  });

  it('draws nothing for invisible, which is the point of choosing it', () => {
    const { container } = render(<Presence status="invisible" />);
    expect(container.firstChild).toBe(null);
  });

  it('keeps invisible invisible even while that person is typing', () => {
    const { container } = render(<Presence status="invisible" typing />);
    expect(container.firstChild).toBe(null);
  });
});

describe('typing', () => {
  it('is enough on its own, before we know anything about their presence', () => {
    render(<Presence status={null} typing />);
    expect(screen.getByRole('img', { name: 'typing' })).toBeTruthy();
  });

  it('is said alongside the presence when both are known', () => {
    render(<Presence status="online" typing />);
    expect(screen.getByRole('img', { name: 'Online, typing' })).toBeTruthy();
  });

  it('is the same badge stretched, not a second one that takes turns', () => {
    const { container } = render(<Presence status="online" typing />);
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(1);
  });
});

describe('sizing', () => {
  it('takes its size from the face it sits on, not from a guess per call site', () => {
    const { container } = render(<Presence status="online" size={104} />);
    expect(container.firstChild.style.getPropertyValue('--presence-avatar')).toBe('104px');
  });

  it('has a size without being told one', () => {
    const { container } = render(<Presence status="online" />);
    expect(container.firstChild.style.getPropertyValue('--presence-avatar')).toBe('36px');
  });
});
