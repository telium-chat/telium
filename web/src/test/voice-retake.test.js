import { describe, expect, it } from 'vitest';
import {
  RETAKE_BACKOFF_MS,
  RETAKE_UNREACHABLE_BACKOFF_MS,
  joinUnanswered,
} from '../hooks/useVoice.jsx';

describe('which retake failures time can fix', () => {
  it('bridges a server that never answered or said it is busy', () => {
    expect(joinUnanswered(new TypeError('fetch failed'))).toBe(true);
    expect(joinUnanswered(new Error('could not reach guilds.example'))).toBe(true);
    const sfu = new Error('SFU /session returned 503');
    sfu.status = 503;
    expect(joinUnanswered(sfu)).toBe(true);
    for (const status of [0, 408, 429, 500, 502, 503]) {
      const e = new Error('busy or broken');
      e.status = status;
      expect(joinUnanswered(e)).toBe(true, `status ${status}`);
    }
  });

  it('does not bridge a server that answered no', () => {
    const cases = [
      ['channel is full', 409],
      ['missing permission', 403],
      ['bad request', 400],
      ['not connected', 404],
      ['expired session', 401],
    ];
    for (const [message, status] of cases) {
      const e = new Error(message);
      e.status = status;
      expect(joinUnanswered(e)).toBe(false, message);
    }
    const guarded = new Error('SFU calls are never carried any other way');
    guarded.answered = true;
    expect(joinUnanswered(guarded)).toBe(false);
  });

  it('keeps the unreachable ladder strictly longer than the ordinary one', () => {
    expect(RETAKE_UNREACHABLE_BACKOFF_MS.length).toBeGreaterThan(RETAKE_BACKOFF_MS.length);
    const total = (ladder) => ladder.reduce((a, b) => a + b, 0);
    expect(total(RETAKE_UNREACHABLE_BACKOFF_MS)).toBeGreaterThan(300_000);
    expect(total(RETAKE_BACKOFF_MS)).toBeLessThan(120_000);
  });
});
