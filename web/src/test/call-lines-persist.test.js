import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Mls, wipe } from '../lib/mls.js';
import { FakeHome } from './mls-home.js';

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  await wipe();
});

async function engine(home) {
  const mls = new Mls(home.for('@a:h', 'd1'), { userId: '@a:h', deviceId: 'd1', backup: null });
  await mls.start();
  return mls;
}

describe('call lines', () => {
  it('survive a new engine (a reload), replaced by id, without writing the conversation state', async () => {
    const home = new FakeHome();
    const first = await engine(home);
    let wroteState = false;
    first.saveMessageState = () => { wroteState = true; };

    await first.rememberCalls('dm1', [{ id: 'c1', kind: 'incoming', from: '@b:h', at: 1000 }]);
    await first.rememberCalls('dm1', [{ id: 'c1', kind: 'missed', from: '@b:h', at: 1000 }]);
    await first.rememberCalls('dm1', [{ id: 'c2', kind: 'ended', from: '@b:h', at: 2000, durationMs: 3_600_000 }]);
    await Promise.all([...first.writes]);
    expect(wroteState).toBe(false);

    const again = await engine(home);
    expect(again.callsIn('dm1')).toEqual([]);
    await again.loadCalls('dm1');
    expect(again.callsIn('dm1').map((c) => [c.id, c.kind, c.durationMs])).toEqual([
      ['c1', 'missed', null],
      ['c2', 'ended', 3_600_000],
    ]);
  });
});
