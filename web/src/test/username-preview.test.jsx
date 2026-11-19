import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { registrationPreview } from '../lib/account-address.js';
import { UsernamePreview } from '../views/AccountHome.jsx';
import { mount, signedInStore } from './harness.jsx';

describe('registrationPreview', () => {
  it('shows the lowercased name on the chosen server', () => {
    expect(registrationPreview('  Ada ', 'example.org')).toEqual({
      localpart: 'ada', address: 'ada@example.org', fault: '',
    });
  });

  it('keeps the name from a pasted full address and ignores its server', () => {
    expect(registrationPreview('@Ada:other.net', 'example.org').address).toBe('ada@example.org');
  });

  it('has no address until something is typed', () => {
    expect(registrationPreview('', 'example.org')).toMatchObject({ address: null, fault: '' });
  });

  it('names characters and lengths the server would refuse', () => {
    expect(registrationPreview('ada lovelace', 'h').fault).toBe('charset');
    expect(registrationPreview('ada!', 'h').fault).toBe('charset');
    expect(registrationPreview('a'.repeat(33), 'h').fault).toBe('too_long');
    expect(registrationPreview('a'.repeat(32), 'h').fault).toBe('');
    expect(registrationPreview('a.b_c-d9', 'h').fault).toBe('');
  });
});

describe('UsernamePreview', () => {
  it('spells out that the server is part of the username as the name is typed', () => {
    const { rerender } = mount(<UsernamePreview user="" host="example.org" />, signedInStore({}));
    expect(screen.getByTestId('username-preview').textContent).toContain('yourname@example.org');

    rerender(<UsernamePreview user="Ada" host="example.org" />);
    expect(screen.getByTestId('username-preview').textContent).toContain('ada@example.org');
  });

  it('warns instead of previewing a name that cannot be registered', () => {
    mount(<UsernamePreview user="ada lovelace" host="example.org" />, signedInStore({}));
    expect(screen.getByTestId('username-preview').textContent).toMatch(/letters, digits, dots, dashes and underscores/);
  });
});
