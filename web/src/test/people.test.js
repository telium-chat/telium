import { describe, expect, it } from 'vitest';
import { fullId, knownPeople, rankPeople } from '../lib/people.js';

const ME = '@me:home.example';

function fakeStore() {
  const friends = new Map([
    ['@bob:home.example', { user_id: '@bob:home.example', state: 'accepted', display_name: 'Bob Stone' }],
    ['@mal:home.example', { user_id: '@mal:home.example', state: 'blocked', display_name: 'Mal' }],
    ['@req:home.example', { user_id: '@req:home.example', state: 'pending_in', display_name: 'Req' }],
  ]);
  const roster = new Map([
    ['@kiwi_77:far.example', { user_id: '@kiwi_77:far.example', display_name: 'Priya Natarajan' }],
    ['@mal:home.example', { user_id: '@mal:home.example', display_name: 'Mal' }],
    [ME, { user_id: ME, display_name: 'Me' }],
  ]);
  return {
    me: { user_id: ME },
    friends,
    peerProfiles: new Map(),
    conversations: [{ id: 'c1', members: [{ user_id: ME }, { user_id: '@sam:home.example' }] }],
    members: new Map([['g1', roster]]),
    identityOf: () => null,
  };
}

describe('knownPeople', () => {
  it('knows friends, people you talk to and server members -- never you, the blocked or a request', () => {
    const ids = knownPeople(fakeStore()).map((p) => p.id).sort();
    expect(ids).toEqual(['@bob:home.example', '@kiwi_77:far.example', '@sam:home.example']);
  });
});

describe('rankPeople', () => {
  const people = knownPeople(fakeStore());

  it('opens on friends and the people you talk to, not every member of every server', () => {
    const ids = rankPeople(people, '').map((r) => r.person.id);
    expect(ids[0]).toBe('@bob:home.example');
    expect(ids).not.toContain('@kiwi_77:far.example');
  });

  it('finds a server member by name once something is typed', () => {
    expect(rankPeople(people, 'priya')[0].person.id).toBe('@kiwi_77:far.example');
  });

  it('finds somebody by their handle, and marks it there', () => {
    const [hit] = rankPeople(people, 'kiwi');
    expect(hit.person.id).toBe('@kiwi_77:far.example');
    expect(hit.positions).toEqual([]);
    expect(hit.idPositions).toEqual([1, 2, 3, 4]);
  });

  it('leaves out who it is told to', () => {
    const ids = rankPeople(people, '', { exclude: new Set(['@bob:home.example']) }).map((r) => r.person.id);
    expect(ids).not.toContain('@bob:home.example');
  });
});

describe('fullId', () => {
  it('finishes a bare name on your own server and leaves a whole one alone', () => {
    expect(fullId('bob', 'home.example')).toBe('@bob:home.example');
    expect(fullId('@carol:other.example', 'home.example')).toBe('@carol:other.example');
  });
});
