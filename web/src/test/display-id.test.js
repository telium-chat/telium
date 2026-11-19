import { describe, expect, it } from 'vitest';
import { displayId } from '../lib/util.js';
import { fullId } from '../lib/people.js';
import { formatAddress, parseAddress, registrationPreview } from '../lib/account-address.js';

describe('addresses read as user@server', () => {
  it('shows a stored id the way people write it', () => {
    expect(displayId('@ada:chat.example.com')).toBe('ada@chat.example.com');
    expect(displayId('@ada:localhost:8080')).toBe('ada@localhost:8080');
  });

  it('leaves anything that is not an id alone', () => {
    expect(displayId('')).toBe('');
    expect(displayId(null)).toBe('');
    expect(displayId('ada')).toBe('ada');
  });

  it('accepts either form where an id is typed, and stores the wire form', () => {
    expect(fullId('ada@chat.example.com', 'home.test')).toBe('@ada:chat.example.com');
    expect(fullId('@ada:chat.example.com', 'home.test')).toBe('@ada:chat.example.com');
    expect(fullId('ada', 'home.test')).toBe('@ada:home.test');
  });

  it('parses both forms at sign-in', () => {
    expect(parseAddress('ada@chat.example.com')).toEqual({ kind: 'handle', user: 'ada', host: 'chat.example.com' });
    expect(parseAddress('@ada:chat.example.com')).toEqual({ kind: 'handle', user: 'ada', host: 'chat.example.com' });
  });

  it('previews a new account in the new form and tolerates a pasted address', () => {
    expect(formatAddress('ada', 'chat.example.com')).toBe('ada@chat.example.com');
    expect(registrationPreview('Ada@other.com', 'chat.example.com').address).toBe('ada@chat.example.com');
    expect(registrationPreview('@ada:other.com', 'chat.example.com').address).toBe('ada@chat.example.com');
  });
});
