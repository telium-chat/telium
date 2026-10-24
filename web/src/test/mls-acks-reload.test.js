import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { wipe } from '../lib/mls.js';
import { FakeHome, device } from './mls-home.js';

const CONV = 'conv-reload';

async function pairUp() {
  const home = new FakeHome();
  const alice = await device(home, '@a:h', 'd-alice');
  const bob = await device(home, '@b:h', 'd-bob');
  for (const m of [alice, bob]) m.sendsRead = () => true;
  const built = await alice.establish(CONV, ['@b:h']);
  await home.for('@a:h', 'd-alice').sendFrame(CONV, {
    kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
  });
  await bob.sync(CONV, home.frames.get(CONV));
  return { home, alice, bob };
}

async function reload(home, userId, deviceId) {
  const mls = await device(home, userId, deviceId);
  mls.sendsRead = () => true;
  await mls.sync(CONV, home.frames.get(CONV));
  return mls;
}

describe('acknowledgements after a reload', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  it('keeps what the sender was told', async () => {
    const { home, alice, bob } = await pairUp();
    const read = await alice.send(CONV, 'read this');
    await bob.sync(CONV, home.frames.get(CONV));
    bob.noteRead(CONV, read.id);
    await bob.flushSignals(CONV);
    const delivered = await alice.send(CONV, 'and this');
    await bob.sync(CONV, home.frames.get(CONV));
    await bob.flushSignals(CONV);
    await alice.sync(CONV, home.frames.get(CONV));
    expect(alice.deliveryState(CONV, read)).toBe('read');
    expect(alice.deliveryState(CONV, delivered)).toBe('delivered');

    const again = await reload(home, '@a:h', 'd-alice-2');
    expect(again.deliveryState(CONV, read)).toBe('read');
    expect(again.deliveryState(CONV, delivered)).toBe('delivered');
    expect(again.deliveredDevices(CONV, delivered.id)).toHaveLength(1);
  });

  it('says nothing again that it has already said, and moves on from there', async () => {
    const { home, alice, bob } = await pairUp();
    const said = await alice.send(CONV, 'hello');
    await bob.sync(CONV, home.frames.get(CONV));
    bob.noteRead(CONV, said.id);
    expect(await bob.flushSignals(CONV)).toBeTruthy();

    const again = await reload(home, '@b:h', 'd-bob-2');
    again.noteRead(CONV, said.id);
    expect(await again.flushSignals(CONV)).toBeNull();

    const next = await alice.send(CONV, 'still there?');
    await again.sync(CONV, home.frames.get(CONV));
    again.noteRead(CONV, next.id);
    expect(await again.flushSignals(CONV)).toBeTruthy();
    await alice.sync(CONV, home.frames.get(CONV));
    expect(alice.deliveryState(CONV, next)).toBe('read');
    expect(alice.deliveredDevices(CONV, next.id)).toHaveLength(1);
    expect(alice.deliveredDevices(CONV, said.id)).toHaveLength(1);
  });
});
