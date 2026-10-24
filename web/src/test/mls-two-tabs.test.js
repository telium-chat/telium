import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { wipe } from '../lib/mls.js';
import { FakeHome, device } from './mls-home.js';

function lockManager() {
  const tails = new Map();
  return {
    async request(name, fn) {
      const before = tails.get(name) || Promise.resolve();
      let release;
      const mine = new Promise((resolve) => { release = resolve; });
      tails.set(name, before.then(() => mine));
      await before;
      try { return await fn({ name }); } finally { release(); }
    },
  };
}

const texts = (engine, frames) => frames
  .filter((f) => f.kind === 'application')
  .map((f) => engine.textOf(f.id));

async function welcome(home, alice, conversationId) {
  const built = await alice.establish(conversationId, ['@b:h']);
  await home.for('@a:h', 'd-alice').sendFrame(conversationId, {
    kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
  });
}

describe('two tabs of one account', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: lockManager(), configurable: true,
    });
    localStorage.clear();
    await wipe();
  });

  it('lets the other side read both tabs, taking turns', async () => {
    const home = new FakeHome();
    const tabA = await device(home, '@a:h', 'd-alice');
    const tabB = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    await welcome(home, tabA, 'conv');
    const frames = () => home.frames.get('conv');
    await bob.sync('conv', frames());
    await tabB.sync('conv', frames());

    await tabA.send('conv', 'from tab a');
    await tabB.sync('conv', frames());
    await tabB.send('conv', 'from tab b');
    await tabA.sync('conv', frames());
    await tabA.send('conv', 'tab a again');
    await Promise.all([tabB.sync('conv', frames()), bob.sync('conv', frames())]);

    expect(bob.errorFor('conv')).toBeUndefined();
    expect(texts(bob, frames())).toEqual(['from tab a', 'from tab b', 'tab a again']);
    expect(texts(tabB, frames())).toEqual(['from tab a', 'from tab b', 'tab a again']);
    expect(texts(tabA, frames())).toEqual(['from tab a', 'from tab b', 'tab a again']);
  });

  it('lets the other side read both tabs when neither has seen the other send', async () => {
    const home = new FakeHome();
    const tabA = await device(home, '@a:h', 'd-alice');
    const tabB = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    await welcome(home, tabA, 'conv');
    const frames = () => home.frames.get('conv');
    await bob.sync('conv', frames());
    await tabB.sync('conv', frames());

    await tabA.send('conv', 'one');
    await tabB.send('conv', 'two');
    await Promise.all([tabA.send('conv', 'three'), tabB.send('conv', 'four')]);
    await bob.sync('conv', frames());

    expect(bob.errorFor('conv')).toBeUndefined();
    expect(texts(bob, frames()).sort()).toEqual(['four', 'one', 'three', 'two']);
  });

  it('keeps reading the other side after both tabs have walked the same frames', async () => {
    const home = new FakeHome();
    const tabA = await device(home, '@a:h', 'd-alice');
    const tabB = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    await welcome(home, tabA, 'conv');
    const frames = () => home.frames.get('conv');
    await bob.sync('conv', frames());
    for (const word of ['hello', 'are', 'you', 'there']) {
      await bob.send('conv', word);
      await Promise.all([tabA.sync('conv', frames()), tabB.sync('conv', frames())]);
    }
    await tabB.send('conv', 'yes');
    await Promise.all([tabA.sync('conv', frames()), bob.sync('conv', frames())]);

    expect(tabA.errorFor('conv')).toBeUndefined();
    expect(tabB.errorFor('conv')).toBeUndefined();
    expect(bob.errorFor('conv')).toBeUndefined();
    expect(texts(tabA, frames())).toEqual(['hello', 'are', 'you', 'there', 'yes']);
    expect(texts(bob, frames())).toEqual(['hello', 'are', 'you', 'there', 'yes']);

    const reloaded = await device(home, '@a:h', 'd-alice');
    await bob.send('conv', 'still here?');
    await reloaded.sync('conv', frames());
    expect(reloaded.errorFor('conv')).toBeUndefined();
    expect(texts(reloaded, frames()).pop()).toBe('still here?');
  });

  it('follows a membership change made in the other tab', async () => {
    const home = new FakeHome();
    const tabA = await device(home, '@a:h', 'd-alice');
    const tabB = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');
    const carol = await device(home, '@c:h', 'd-carol');

    await welcome(home, tabA, 'conv');
    const frames = () => home.frames.get('conv');
    await bob.sync('conv', frames());
    await tabB.sync('conv', frames());

    await tabA.addMembers('conv', ['@c:h']);
    await Promise.all([bob.sync('conv', frames()), carol.sync('conv', frames()), tabB.sync('conv', frames())]);
    await bob.send('conv', 'welcome carol');
    await tabB.sync('conv', frames());
    await tabB.send('conv', 'hi carol');
    await Promise.all([bob.sync('conv', frames()), carol.sync('conv', frames())]);

    expect(tabB.errorFor('conv')).toBeUndefined();
    expect(texts(tabB, frames())).toEqual(['welcome carol', 'hi carol']);
    expect(texts(carol, frames())).toEqual(['welcome carol', 'hi carol']);
    expect(texts(bob, frames())).toEqual(['welcome carol', 'hi carol']);
  });

  it('shows one tab the reactions, edits and receipts the other tab sent', async () => {
    const home = new FakeHome();
    const tabA = await device(home, '@a:h', 'd-alice');
    const tabB = await device(home, '@a:h', 'd-alice');
    const bob = await device(home, '@b:h', 'd-bob');

    await welcome(home, tabA, 'conv');
    const frames = () => home.frames.get('conv');
    await bob.sync('conv', frames());
    await bob.send('conv', 'hi');
    await Promise.all([tabA.sync('conv', frames()), tabB.sync('conv', frames())]);
    const hi = frames().find((f) => f.kind === 'application');

    await tabA.send('conv', 'typo');
    const typo = frames().filter((f) => f.kind === 'application').pop();
    await tabA.react('conv', hi.id, '👋');
    await tabA.editMessage('conv', typo.id, 'fixed');
    await tabA.typing('conv');
    await tabB.sync('conv', frames());

    expect(tabB.reactionsTo('conv', hi.id).map((r) => r.emoji)).toEqual(['👋']);
    expect(tabB.currentText('conv', typo.id)).toBe('fixed');
    for (const f of frames().filter((x) => x.kind === 'application' && x.sender === '@a:h')) {
      expect(tabB.payloadTypeOf(f.id)).toBeDefined();
    }
    await bob.sync('conv', frames());
    expect(bob.currentText('conv', typo.id)).toBe('fixed');
  });
});
