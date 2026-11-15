import { describe, expect, it } from 'vitest';
import { formatCallElapsed } from '../lib/call-elapsed.js';

describe('formatCallElapsed', () => {
  it('shows minutes and seconds under an hour', () => {
    expect(formatCallElapsed(0)).toBe('00:00');
    expect(formatCallElapsed(65)).toBe('01:05');
    expect(formatCallElapsed(3599)).toBe('59:59');
  });
  it('switches to hours at one hour', () => {
    expect(formatCallElapsed(3600)).toBe('1:00:00');
    expect(formatCallElapsed(3725)).toBe('1:02:05');
    expect(formatCallElapsed(36000)).toBe('10:00:00');
  });
});
