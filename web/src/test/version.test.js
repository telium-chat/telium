import { describe, expect, it } from 'vitest';
import { noticeKey, readDismissal, requiredReason, versionNotice, writeDismissal } from '../lib/version.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function behind({ severity, missed = 3, days = 20, security = false, latest = 'a'.repeat(40), required }) {
  return {
    state: 'behind',
    severity,
    behind_ms: days * DAY,
    detail: { missed, security, latest, stale_since: NOW - days * DAY, required },
    message: 'the server says how far behind it is, in one sentence',
  };
}

describe('when the client says anything at all', () => {
  it('says nothing when there is nothing to say', () => {
    expect(versionNotice(null, { now: NOW })).toBe(null);
    expect(versionNotice({ state: 'current', severity: 'quiet' }, { now: NOW })).toBe(null);
    expect(versionNotice({ state: 'disabled', severity: 'quiet' }, { now: NOW })).toBe(null);
  });

  it('does not put a banner up for a server that is barely behind', () => {
    expect(versionNotice(behind({ severity: 'notice', missed: 1, days: 2 }), { now: NOW })).toBe(null);
  });

  it('speaks up once being behind is worth saying', () => {
    const notice = versionNotice(behind({ severity: 'warn' }), { now: NOW });
    expect(notice).not.toBe(null);
    expect(notice.headline).toBe('This server is 3 releases behind, and has been for 20 days.');
    expect(notice.tone).toBe(undefined);
    expect(notice.detail).toBe('the server says how far behind it is, in one sentence');
  });

  it('gets louder rather than more frequent as it gets worse', () => {
    const warn = versionNotice(behind({ severity: 'warn' }), { now: NOW });
    const urgent = versionNotice(behind({ severity: 'urgent', days: 60 }), { now: NOW });
    const sec = versionNotice(behind({ severity: 'urgent', security: true, days: 1 }), { now: NOW });

    expect(warn.tone).toBe(undefined);
    expect(urgent.tone).toBe('warning');
    expect(sec.tone).toBe('danger');
    expect(sec.headline).toBe('This server is missing a security release.');
    expect(warn.snoozeMs).toBeGreaterThan(urgent.snoozeMs);
    expect(urgent.snoozeMs).toBeGreaterThan(sec.snoozeMs);
  });

  it('counts one release as a release', () => {
    const notice = versionNotice(behind({ severity: 'warn', missed: 1, days: 1 }), { now: NOW });
    expect(notice.headline).toBe('This server is 1 release behind, and has been for 1 day.');
  });

  it('says a check it cannot complete is a check it cannot complete', () => {
    const notice = versionNotice({
      state: 'unknown',
      severity: 'warn',
      detail: { reason: 'unreachable' },
      message: 'the release manifest could not be read',
    }, { now: NOW });
    expect(notice.headline).toBe('This server cannot tell whether it is up to date.');
    expect(notice.tone).toBe(undefined);
  });
});

describe('available against required', () => {

  it('leaves an ordinary missed release ordinary', () => {
    const notice = versionNotice(behind({ severity: 'warn' }), { now: NOW });
    expect(requiredReason(behind({ severity: 'warn' }))).toBe(null);
    expect(notice.required).toBe(null);
    expect(notice.tone).toBe(undefined);
    expect(notice.headline).toBe('This server is 3 releases behind, and has been for 20 days.');
  });

  it('says what a compatibility break actually costs, rather than counting releases', () => {
    const notice = versionNotice(behind({ severity: 'urgent', required: 'compatibility' }), { now: NOW });
    expect(notice.required).toBe('compatibility');
    expect(notice.headline).toBe('This server must be updated to keep talking to other servers.');
    expect(notice.tone).toBe('danger');
  });

  it('escalates a required update even when the release count is mild', () => {
    const notice = versionNotice(behind({ severity: 'warn', missed: 1, days: 1, required: 'compatibility' }), { now: NOW });
    expect(notice.tone).toBe('danger');
    expect(notice.snoozeMs).toBe(4 * 60 * 60 * 1000);
  });

  it('prefers the security sentence when a release is both', () => {
    const notice = versionNotice(
      behind({ severity: 'urgent', security: true, required: 'security' }),
      { now: NOW },
    );
    expect(notice.headline).toBe('This server is missing a security release.');
    expect(notice.security).toBe(true);
  });

  it('believes only the two reasons it knows', () => {
    expect(requiredReason(behind({ severity: 'warn', required: 'vibes' }))).toBe(null);
    expect(requiredReason(behind({ severity: 'warn', required: true }))).toBe(null);
    expect(requiredReason(null)).toBe(null);
    expect(versionNotice(behind({ severity: 'warn', required: 'vibes' }), { now: NOW }).tone).toBe(undefined);
  });

  it('does not let a dismissal from before the requirement cover it', () => {
    const available = behind({ severity: 'urgent' });
    const notice = versionNotice(available, { now: NOW });
    const dismissal = { key: notice.key, until: NOW + notice.snoozeMs };

    const required = behind({ severity: 'urgent', required: 'compatibility' });
    expect(noticeKey(required)).not.toBe(noticeKey(available));
    expect(versionNotice(required, { now: NOW, dismissal })).not.toBe(null);
  });
});

describe('dismissal', () => {
  it('silences the notice for as long as it was snoozed, and not a moment longer', () => {
    const status = behind({ severity: 'warn' });
    const notice = versionNotice(status, { now: NOW });
    const dismissal = { key: notice.key, until: NOW + notice.snoozeMs };

    expect(versionNotice(status, { now: NOW, dismissal })).toBe(null);
    expect(versionNotice(status, { now: NOW + notice.snoozeMs - 1, dismissal })).toBe(null);
    expect(versionNotice(status, { now: NOW + notice.snoozeMs, dismissal })).not.toBe(null);
  });

  it('does not carry over to something the operator has not been told yet', () => {
    const mild = behind({ severity: 'warn' });
    const notice = versionNotice(mild, { now: NOW });
    const dismissal = { key: notice.key, until: NOW + notice.snoozeMs };

    const worse = behind({ severity: 'urgent', days: 60 });
    const newer = behind({ severity: 'warn', latest: 'b'.repeat(40) });
    const sec = behind({ severity: 'urgent', security: true });

    expect(versionNotice(worse, { now: NOW, dismissal })).not.toBe(null);
    expect(versionNotice(newer, { now: NOW, dismissal })).not.toBe(null);
    expect(versionNotice(sec, { now: NOW, dismissal })).not.toBe(null);
  });

  it('gives the same situation the same name every time', () => {
    expect(noticeKey(behind({ severity: 'warn' }))).toBe(noticeKey(behind({ severity: 'warn', days: 21 })));
    expect(noticeKey(behind({ severity: 'warn' }))).not.toBe(noticeKey(behind({ severity: 'urgent' })));
    expect(noticeKey(null)).toBe(null);
  });
});

describe('storage that will not cooperate', () => {
  it('treats junk as no dismissal rather than as a crash', () => {
    expect(readDismissal(null)).toBe(null);
    expect(readDismissal({ getItem: () => 'not json' })).toBe(null);
    expect(readDismissal({ getItem: () => '{"key":1}' })).toBe(null);
    expect(readDismissal({ getItem: () => { throw new Error('blocked'); } })).toBe(null);
  });

  it('shows the notice again rather than pretending a failed write worked', () => {
    expect(() => writeDismissal({ setItem: () => { throw new Error('full'); } }, 'k', 1)).not.toThrow();
    expect(() => writeDismissal(null, 'k', 1)).not.toThrow();
  });

  it('round-trips a dismissal through something that behaves like storage', () => {
    const cell = {};
    const storage = { getItem: (k) => cell[k] ?? null, setItem: (k, v) => { cell[k] = v; } };
    writeDismissal(storage, 'warn:behind:abc', NOW + DAY);
    expect(readDismissal(storage)).toEqual({ key: 'warn:behind:abc', until: NOW + DAY });
  });
});
