import { describe, expect, it } from 'vitest';
import { cleanServerVersion } from '../hooks/useServerVersion.js';

describe('cleanServerVersion', () => {
  it('reads the version from the capabilities document', () => {
    expect(cleanServerVersion({ server_version: '0.14.2' })).toBe('0.14.2');
    expect(cleanServerVersion({ server_version: ' 1.0.0-rc.1+abc ' })).toBe('1.0.0-rc.1+abc');
  });
  it('says nothing for a missing or odd value', () => {
    expect(cleanServerVersion(null)).toBe('');
    expect(cleanServerVersion({})).toBe('');
    expect(cleanServerVersion({ server_version: 12 })).toBe('');
    expect(cleanServerVersion({ server_version: '<b>x</b>' })).toBe('');
  });
});
