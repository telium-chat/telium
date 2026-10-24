import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { wipe } from '../lib/mls.js';
import { FakeHome, device } from './mls-home.js';

const CONV = 'conv-live';

async function live() {
  const home = new FakeHome();
  const alice = await device(home, '@a:h', 'd-alice');
  const bob = await device(home, '@b:h', 'd-bob');
  const as = home.for('@a:h', 'd-alice');
  const first = await alice.establish(CONV, ['@b:h'], { generation: 0 });
  await as.sendFrame(CONV, {
    kind: 'welcome', ciphertext: first.welcome, epoch: first.epoch, start_over: true, generation: 0,
  });
  await bob.sync(CONV, home.frames.get(CONV));
  const again = await alice.establish(CONV, ['@b:h'], { generation: 1, from: home.frames.get(CONV).length });
  await as.sendFrame(CONV, {
    kind: 'welcome', ciphertext: again.welcome, epoch: again.epoch, start_over: true, generation: 1,
  });
  await bob.sync(CONV, home.frames.get(CONV));
  expect(home.generations.get(CONV)).toBe(2);
  expect(bob.joined(CONV)).toBe(true);

  const elsewhere = new FakeHome();
  elsewhere.device('@b:h', 'd-bob').push(...home.device('@b:h', 'd-bob').splice(0, 2));
  await device(elsewhere, '@d:h', 'd-dave');
  const carol = await device(elsewhere, '@c:h', 'd-carol');
  return { home, alice, bob, carol, elsewhere };
}

const snapshot = (mls) => ({
  epoch: mls.epochOf(CONV),
  members: mls.devicesIn(CONV).map((d) => `${d.userId}|${d.signatureKey}`).sort(),
});

async function stillReads({ home, alice, bob }) {
  const said = await alice.send(CONV, 'the real group');
  await bob.sync(CONV, home.frames.get(CONV));
  expect(bob.errorFor(CONV)).toBeFalsy();
  expect(bob.textOf(said.id)).toBe('the real group');
}

describe('a Welcome into a conversation the device is live in', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  it('is refused when its group is another conversation’s, and the group is untouched', async () => {
    const world = await live();
    const { home, bob, carol } = world;
    const before = snapshot(bob);
    const theirs = await carol.establish('conv-elsewhere', ['@b:h']);
    await home.for('@a:h', 'd-alice').sendFrame(CONV, {
      kind: 'welcome', ciphertext: theirs.welcome, epoch: theirs.epoch, generation: 2,
    });
    await bob.sync(CONV, home.frames.get(CONV));
    expect(snapshot(bob)).toEqual(before);
    await stillReads(world);
  });

  it('is refused when it is from a generation the conversation has replaced', async () => {
    const world = await live();
    const { home, bob, carol } = world;
    const before = snapshot(bob);
    const theirs = await carol.establish(CONV, ['@b:h']);
    const frames = home.frames.get(CONV);
    frames.push({
      id: 'late-welcome', conversation_id: CONV, seq: frames.length + 1, kind: 'welcome',
      sender: '@c:h', sender_device: 'd-carol', ciphertext: theirs.welcome, epoch: 1, generation: 1,
    });
    await bob.sync(CONV, frames);
    expect(snapshot(bob)).toEqual(before);
    expect(bob.devicesIn(CONV).some((d) => d.userId === '@c:h')).toBe(false);
    await stillReads(world);
  });

  it('is refused at the current generation when it is not a fresh group', async () => {
    const world = await live();
    const { home, bob, carol, elsewhere } = world;
    const before = snapshot(bob);
    const theirs = await carol.establish(CONV, ['@d:h']);
    await elsewhere.for('@c:h', 'd-carol').sendFrame(CONV, {
      kind: 'welcome', ciphertext: theirs.welcome, epoch: theirs.epoch,
    });
    await carol.addMembers(CONV, ['@b:h']);
    const forged = elsewhere.frames.get(CONV).findLast((f) => f.kind === 'welcome');
    expect(forged.epoch).toBeGreaterThan(1);
    await home.for('@a:h', 'd-alice').sendFrame(CONV, {
      kind: 'welcome', ciphertext: forged.ciphertext, epoch: forged.epoch, generation: 2,
    });
    await bob.sync(CONV, home.frames.get(CONV));
    expect(snapshot(bob)).toEqual(before);
    await stillReads(world);
  });
});
