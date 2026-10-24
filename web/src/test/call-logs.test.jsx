import { describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import { mount, ME, signedInStore } from './harness.jsx';
import { RING_MS } from '../lib/store/calls.js';
import { CallLogRow, formatCallDuration } from '../views/chat/CallLog.jsx';

const CAROL = '@carol:other.example';
const DAVE = '@dave:other.example';

const CONVO = {
  id: 'dm1',
  kind: 'dm',
  sequencer: 'home.example',
  members: [{ user_id: ME }, { user_id: CAROL }, { user_id: DAVE }],
};

function store(prefs = {}) {
  return signedInStore({ conversations: [CONVO], prefs });
}

const joins = (userId) => ({
  user_id: userId, conversation_id: 'dm1', channel_id: 'dm1',
});

const leaves = (userId) => ({
  user_id: userId, conversation_id: 'dm1', channel_id: null,
});

const logs = (s) => s.callLogs.get('dm1') || [];

describe('outgoing calls', () => {
  it('logs placing a call and shows it as ringing', () => {
    const s = store();
    act(() => s.onVoice(joins(ME)));

    expect(s.outgoingCalls.has('dm1')).toBe(true);
    expect(logs(s)).toHaveLength(1);
    expect(logs(s)[0]).toMatchObject({ kind: 'outgoing', from: ME });
    expect(s.callConnected.has('dm1')).toBe(false);
  });

  it('does not log its own join twice when the gateway echoes it back', () => {
    const s = store();
    act(() => s.onVoice(joins(ME)));
    act(() => s.onVoice(joins(ME)));

    expect(logs(s)).toHaveLength(1);
    expect(s.callConnected.has('dm1')).toBe(false);
  });

  it('connects when somebody joins, and ends with a duration', () => {
    const s = store();
    act(() => s.onVoice(joins(ME)));
    act(() => s.onVoice(joins(CAROL)));

    expect(s.outgoingCalls.has('dm1')).toBe(false);
    expect(s.callConnected.has('dm1')).toBe(true);

    act(() => { s.onVoice(leaves(ME)); s.onVoice(leaves(CAROL)); });

    const kinds = logs(s).map((e) => e.kind);
    expect(kinds).toEqual(['outgoing', 'ended']);
    expect(logs(s)[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('marks an unanswered outgoing as missed when the caller gives up', () => {
    const s = store();
    act(() => s.onVoice(joins(ME)));
    act(() => s.onVoice(leaves(ME)));

    expect(s.outgoingCalls.has('dm1')).toBe(false);
    expect(logs(s).map((e) => e.kind)).toEqual(['missed']);
  });

  it('marks an unanswered outgoing as missed when the ring lapses', () => {
    vi.useFakeTimers();
    try {
      const s = store();
      act(() => s.onVoice(joins(CAROL)));
      act(() => vi.advanceTimersByTime(RING_MS + 10));
      expect(logs(s).map((e) => e.kind)).toEqual(['missed']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('incoming calls', () => {
  it('logs a ring as incoming', () => {
    const s = store();
    act(() => s.onVoice(joins(CAROL)));

    expect(logs(s)).toHaveLength(1);
    expect(logs(s)[0]).toMatchObject({ kind: 'incoming', from: CAROL });
  });

  it('keeps the log even where the ring stays quiet', () => {
    const muted = store({ muted: { dm1: true } });
    act(() => muted.onVoice(joins(CAROL)));
    expect(muted.ringing.size).toBe(0);
    expect(logs(muted).map((e) => e.kind)).toEqual(['incoming']);

    const dnd = store({ presence: 'dnd' });
    act(() => dnd.onVoice(joins(CAROL)));
    expect(dnd.ringing.size).toBe(0);
    expect(logs(dnd).map((e) => e.kind)).toEqual(['incoming']);
  });

  it('marks a declined call as missed', () => {
    const s = store();
    act(() => s.onVoice(joins(CAROL)));
    act(() => s.declineCall('dm1'));

    expect(logs(s).map((e) => e.kind)).toEqual(['missed']);
  });

  it('ends a connected call with a duration', () => {
    const s = store();
    act(() => s.onVoice(joins(CAROL)));
    act(() => s.onVoice(joins(ME)));
    act(() => { s.onVoice(leaves(ME)); s.onVoice(leaves(CAROL)); });

    expect(logs(s).map((e) => e.kind)).toEqual(['incoming', 'ended']);
    expect(logs(s)[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('never logs a guild voice channel', () => {
    const s = signedInStore({
      conversations: [CONVO],
      guilds: [{
        id: 'g1',
        name: 'Guild',
        channels: [{ id: 'vc1', name: 'Voice', kind: 'voice' }],
        roles: [],
        me: { user_id: ME, roles: [] },
      }],
    });
    act(() => s.onVoice({ user_id: CAROL, guild_id: 'g1', channel_id: 'vc1' }));
    expect(s.callLogs.size).toBe(0);
    expect(s.outgoingCalls.size).toBe(0);
  });
});

describe('the log row', () => {
  it('formats durations as m:ss', () => {
    expect(formatCallDuration(0)).toBe('0:00');
    expect(formatCallDuration(65_000)).toBe('1:05');
    expect(formatCallDuration(3_600_000 + 120_000)).toBe('1:02:00');
  });

  it('draws each outcome in words', async () => {
    const s = store();
    const at = Date.now();
    const cases = [
      [{ callKind: 'incoming', from: CAROL }, 'Incoming call'],
      [{ callKind: 'outgoing', from: ME }, 'Outgoing call'],
      [{ callKind: 'missed', from: CAROL }, 'Missed call'],
      [{ callKind: 'ended', from: CAROL, durationMs: 61_000 }, 'Call ended · 1:01'],
    ];
    for (const [entry, text] of cases) {
      const { unmount } = mount(
        <CallLogRow entry={{ id: `call-${entry.callKind}`, conversationId: 'dm1', at, ...entry }} />,
        s,
      );
      // eslint-disable-next-line no-await-in-loop
      expect(await screen.findByText(text)).toBeTruthy();
      unmount();
    }
  });
});
