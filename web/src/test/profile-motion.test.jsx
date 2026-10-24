import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProfileCardProvider } from '../views/profile/ProfileCardProvider.jsx';
import { useProfileCard } from '../hooks/useProfileCard.js';
import { ModalProvider } from '../hooks/useModal.jsx';

const THEM = '@bob:home.example';

vi.mock('../views/profile/ProfileBody.jsx', () => ({
  ProfileBody: () => <div>card</div>,
}));

const read = (name) => readFileSync(join(import.meta.dirname, `../${name}`), 'utf8');

const rule = (css, header) => {
  const at = css.indexOf(header);
  expect(at).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
};

const startingStyle = (css, selector) => {
  const header = '@starting-style {';
  let from = css.indexOf(header);
  while (from > -1) {
    const body = rule(css.slice(from), header);
    if (body.includes(selector)) return body;
    from = css.indexOf(header, from + 1);
  }
  return null;
};

const declarations = (block) => Object.fromEntries(
  block
    .split(';')
    .map((line) => line.trim())
    .filter((line) => line.includes(':'))
    .map((line) => line.split(':').map((part) => part.trim())),
);

describe('the card arriving', () => {
  it('starts from the frame the popup itself finishes on', () => {
    const popup = declarations(rule(read('menu.css'), '.popup[data-starting-style]'));
    const block = startingStyle(read('profile-card.css'), '.pc-popup');
    expect(block).toBeTruthy();
    const card = declarations(rule(block, '.pc-popup'));

    expect(popup).toEqual(card);
    expect(popup).toEqual({ opacity: '0', transform: 'scale(0.96)' });
  });

  it('takes its duration and curve from the popup rather than naming its own', () => {
    const transition = rule(read('menu.css'), '.popup {');

    expect(transition).toContain('var(--dur-1)');
    expect(transition).toContain('var(--ease)');

    const box = rule(read('profile-card.css'), '.pc-popup {');
    expect(box).not.toContain('transition');
  });

  it('is written against the popover the card actually opens', () => {
    function Opener() {
      const profiles = useProfileCard();
      return <button type="button" onClick={() => profiles.open(THEM)}>Open</button>;
    }

    render(
      <ModalProvider>
        <ProfileCardProvider>
          <Opener />
        </ProfileCardProvider>
      </ModalProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    const popup = document.querySelector('[data-profile-card-popover]');
    expect(popup.className).toContain('pc-popup');
  });
});
