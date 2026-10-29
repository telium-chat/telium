import { describe, expect, it } from 'vitest';
import { hostingNote } from '../lib/attachment-note.js';

const DAY = 24 * 60 * 60 * 1000;
const SOON = Date.now() + 6 * DAY;
const PAST = Date.now() - DAY;

describe('the attachment hosting note', () => {
  it('says where the bytes live and how long they will in one line', () => {
    expect(hostingNote('store.example', { expires_at: SOON }))
      .toMatch(/^Hosted on store\.example, expires in /);
  });

  it('marks an expired file on its host', () => {
    expect(hostingNote('store.example', { expires_at: PAST }))
      .toBe('Hosted on store.example — expired');
  });

  it('keeps the host line when the origin keeps the file', () => {
    expect(hostingNote('store.example', {})).toBe('Hosted on store.example');
  });

  it('still counts down for a file with no host to name', () => {
    expect(hostingNote(null, { expires_at: SOON })).toMatch(/^Expires in /);
    expect(hostingNote(null, { expires_at: PAST })).toBe('This file has expired');
  });

  it('says nothing when there is nothing to say', () => {
    expect(hostingNote(null, {})).toBeNull();
    expect(hostingNote('store.example', null)).toBe('Hosted on store.example');
  });
});
