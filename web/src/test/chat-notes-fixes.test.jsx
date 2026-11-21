import { describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { ME, signedInStore } from './harness.jsx';
import { rowsFor } from '../views/chat/Timeline.jsx';
import { suggestFor } from '../views/chat/Autocomplete.jsx';

const CAROL = '@carol:other.example';
const CONVO = {
  id: 'dm1', kind: 'dm', sequencer: 'home.example',
  members: [{ user_id: ME }, { user_id: CAROL }],
};

describe('day breaks', () => {
  it('draws one break per day, even with call lines between the messages', () => {
    const day = new Date(2026, 10, 19, 10).getTime();
    const rows = rowsFor([
      { kind: 'msg', id: '1', author: CAROL, created_at: day },
      { kind: 'call', id: 'call-a', created_at: day + 60_000 },
      { kind: 'msg', id: '2', author: CAROL, created_at: day + 120_000 },
      { kind: 'call', id: 'call-b', created_at: day + 180_000 },
      { kind: 'msg', id: '3', author: ME, created_at: day + 240_000 },
      { kind: 'msg', id: '4', author: ME, created_at: day + 24 * 3600_000 },
    ], null);
    expect(rows.filter((r) => r.kind === 'day')).toHaveLength(2);
  });
});

describe('call lines across a reload', () => {
  it('hands each new or changed line to the conversation state, and reads saved lines back', async () => {
    const s = signedInStore({ conversations: [CONVO] });
    const saved = [{
      id: 'call-old', conversationId: 'dm1', kind: 'ended', from: CAROL, at: 1000, durationMs: 3_600_000,
    }];
    const rememberCalls = vi.fn(async () => {});
    s.mls = { rememberCalls, callsIn: (id) => (id === 'dm1' ? saved : []) };

    expect(s.callLogFor('dm1')).toEqual(saved);

    let entry;
    act(() => { entry = s.logCall('dm1', { kind: 'incoming', from: CAROL, at: 2000 }); });
    expect(rememberCalls).toHaveBeenLastCalledWith('dm1', [entry]);
    expect(s.callLogFor('dm1').map((r) => r.id)).toEqual(['call-old', entry.id]);

    act(() => s.markUnanswered('dm1'));
    expect(rememberCalls).toHaveBeenLastCalledWith('dm1', [expect.objectContaining({ id: entry.id, kind: 'missed' })]);
  });
});

describe('mentioning someone in a DM', () => {
  it('shows the avatar the store already knows for them', () => {
    const s = signedInStore({ conversations: [CONVO] });
    s.friends.set(CAROL, { user_id: CAROL, display_name: 'Carol', avatar_ref: 'media:carol' });
    const rows = suggestFor(s, { people: () => [ME, CAROL] }, { kind: 'mention', query: 'carol', start: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].avatar).toMatchObject({ id: CAROL, mediaRef: 'media:carol' });
  });
});
