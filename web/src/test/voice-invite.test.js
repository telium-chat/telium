import { describe, expect, it } from 'vitest';
import { INVITE_SHOWN_MS, invitable, liveInvites } from '../views/VoiceInvite.jsx';
import { isClassified, mayInterrupt } from '../lib/interrupts.js';

const base = { me: 'me', inChannel: null, presence: 'online', now: 1_000_000 };
const invite = (over = {}) => ({ channelId: 'c1', guildId: 'g', from: 'bob', shownAt: base.now - 1000, ...over });

describe('which call invites are shown', () => {
  it('shows a fresh one', () => {
    expect(liveInvites([invite()], base)).toHaveLength(1);
  });
  it('drops one that has gone stale, so nothing lingers', () => {
    expect(liveInvites([invite({ shownAt: base.now - INVITE_SHOWN_MS - 1 })], base)).toEqual([]);
  });
  it('drops one to a call I am already in', () => {
    expect(liveInvites([invite()], { ...base, inChannel: 'c1' })).toEqual([]);
  });
  it('shows nothing on do-not-disturb', () => {
    expect(liveInvites([invite()], { ...base, presence: 'dnd' })).toEqual([]);
  });
  it('ignores my own', () => {
    expect(liveInvites([invite({ from: 'me' })], base)).toEqual([]);
  });
});

describe('who can be invited', () => {
  const member = (user_id, extra = {}) => [user_id, { user_id, display_name: user_id, ...extra }];
  const store = {
    me: { user_id: 'me' },
    voice: new Map([['c1', [{ user_id: 'in-call' }]]]),
    presence: new Map([['online-one', { status: 'online' }]]),
    users: new Map(),
    members: new Map([['g', new Map([
      member('me'), member('in-call'), member('zed'), member('online-one'), member('robot', { bot: true }),
    ])]]),
  };
  it('leaves out me, people already in the call and bots, online first', () => {
    const rows = invitable(store, 'g', 'c1', '');
    expect(rows.map((r) => r.userId)).toEqual(['online-one', 'zed']);
  });
  it('filters by what is typed', () => {
    expect(invitable(store, 'g', 'c1', 'ZE').map((r) => r.userId)).toEqual(['zed']);
  });
});

describe('the invite event', () => {
  it('is classified and may interrupt', () => {
    expect(isClassified('VOICE_INVITE')).toBe(true);
    expect(mayInterrupt('VOICE_INVITE')).toBe(true);
  });
});
