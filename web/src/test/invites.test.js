import { describe, expect, it } from 'vitest';
import { DEFAULT_INVITE_EXPIRY, INVITE_EXPIRY_OPTIONS, inviteCreateBody } from '../lib/invites.js';

describe('inviteCreateBody', () => {
  it('sends the numbers as numbers, not as the strings a select hands back', () => {
    expect(inviteCreateBody('25', '86400')).toEqual({ max_uses: 25, expires_in_secs: 86400 });
  });

  it('turns every shade of "no limit" into null', () => {
    expect(inviteCreateBody('', '')).toEqual({ max_uses: null, expires_in_secs: null });
    expect(inviteCreateBody(undefined, undefined)).toEqual({ max_uses: null, expires_in_secs: null });
    expect(inviteCreateBody(0, 0)).toEqual({ max_uses: null, expires_in_secs: null });
  });

  it('lets one field be limited while the other is not', () => {
    expect(inviteCreateBody('1', '')).toEqual({ max_uses: 1, expires_in_secs: null });
    expect(inviteCreateBody('', '3600')).toEqual({ max_uses: null, expires_in_secs: 3600 });
  });
});

describe('the expiry options', () => {
  it('offers "never" as the empty value the body reads as no limit', () => {
    const never = INVITE_EXPIRY_OPTIONS.find(([, label]) => label === 'Never');
    expect(never[0]).toBe('');
    expect(inviteCreateBody('', never[0]).expires_in_secs).toBe(null);
  });

  it('defaults to an expiry the list actually offers', () => {
    expect(INVITE_EXPIRY_OPTIONS.map(([value]) => value)).toContain(DEFAULT_INVITE_EXPIRY);
    expect(inviteCreateBody('', DEFAULT_INVITE_EXPIRY).expires_in_secs).toBe(86400);
  });

  it('states every duration in seconds, which is the unit the body sends', () => {
    for (const [value, label] of INVITE_EXPIRY_OPTIONS) {
      if (!value) continue;
      expect(Number.isInteger(Number(value))).toBe(true);
      expect(label).toBeTruthy();
    }
  });
});
