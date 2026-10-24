import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { wipe } from '../lib/mls.js';
import { FakeHome, device } from './mls-home.js';

async function pair(conv) {
  const home = new FakeHome();
  const alice = await device(home, '@a:h', 'd-alice');
  const bob = await device(home, '@b:h', 'd-bob');
  await device(home, '@c:h', 'd-carol');
  const built = await alice.establish(conv, ['@b:h']);
  await home.for('@a:h', 'd-alice').sendFrame(conv, {
    kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
  });
  await bob.sync(conv, home.frames.get(conv));
  return { home, alice, bob };
}

const commitsBy = (home, conv, deviceId) => home.frames.get(conv)
  .filter((f) => f.kind === 'commit' && f.sender_device === deviceId);

async function stored(mls, conv) {
  mls.groups.delete(conv);
  return mls.loadGroup(conv);
}

describe('a pending commit', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  it('is adopted from its own echo when the answer was lost, even across a restart', async () => {
    const { home, alice } = await pair('p-echo');
    const before = alice.epochOf('p-echo');
    home.faults = [{ kind: 'commit', when: 'after', status: 503 }];
    await expect(alice.addMembers('p-echo', ['@c:h'])).rejects.toMatchObject({ status: 503 });
    expect(commitsBy(home, 'p-echo', 'd-alice')).toHaveLength(1);
    expect(alice.epochOf('p-echo')).toBe(before);
    expect((await stored(alice, 'p-echo')).pending?.epoch).toBe(before + 1);

    const again = await device(home, '@a:h', 'd-alice');
    await again.sync('p-echo', home.frames.get('p-echo'));
    expect(again.epochOf('p-echo')).toBe(before + 1);
    expect((await stored(again, 'p-echo')).pending).toBeFalsy();

    const carol = await device(home, '@c:h', 'd-carol');
    await again.send('p-echo', 'after the lost answer');
    await carol.sync('p-echo', home.frames.get('p-echo'));
    const said = home.frames.get('p-echo').findLast((f) => f.kind === 'application');
    expect(carol.textOf(said.id)).toBe('after the lost answer');
    expect(commitsBy(home, 'p-echo', 'd-alice')).toHaveLength(1);
  });

  it('is dropped when the sequencer names another commit as the winner', async () => {
    const { home, alice, bob } = await pair('p-lost');
    const before = alice.epochOf('p-lost');
    await bob.addMembers('p-lost', ['@c:h']);
    let refused;
    await alice.removeMembers('p-lost', ['@b:h']).catch((e) => { refused = e; });
    expect(refused?.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'epoch_conflict', winner_epoch: before + 1,
    });
    expect(refused.body.winner_digest).toBeTruthy();
    const entry = await stored(alice, 'p-lost');
    expect(entry.pending).toBeFalsy();
    expect(alice.epochOf('p-lost')).toBe(before);

    await alice.sync('p-lost', home.frames.get('p-lost'));
    expect(alice.epochOf('p-lost')).toBe(bob.epochOf('p-lost'));
    await bob.send('p-lost', 'still one group');
    await alice.sync('p-lost', home.frames.get('p-lost'));
    const said = home.frames.get('p-lost').findLast((f) => f.kind === 'application');
    expect(alice.textOf(said.id)).toBe('still one group');
  });

  it('is kept through a server error and settled by the next walk', async () => {
    const { home, alice, bob } = await pair('p-kept');
    const before = alice.epochOf('p-kept');
    home.faults = [{ kind: 'commit', when: 'before', status: 502 }];
    await expect(alice.setPolicy('p-kept', {
      creator: '@a:h', add: 'admins', remove: 'admins', policy: 'creator', admins: ['@a:h'],
    })).rejects.toMatchObject({ status: 502 });
    expect(commitsBy(home, 'p-kept', 'd-alice')).toHaveLength(0);
    expect((await stored(alice, 'p-kept')).pending?.epoch).toBe(before + 1);

    await alice.sync('p-kept', home.frames.get('p-kept'));
    expect(commitsBy(home, 'p-kept', 'd-alice')).toHaveLength(1);
    expect(alice.epochOf('p-kept')).toBe(before + 1);
    expect((await stored(alice, 'p-kept')).pending).toBeFalsy();

    await bob.sync('p-kept', home.frames.get('p-kept'));
    expect(bob.epochOf('p-kept')).toBe(before + 1);
    expect(bob.policyOf('p-kept')?.creator).toBe('@a:h');
  });

  it('is answered with the original when a lost answer is retried', async () => {
    const { home, alice } = await pair('p-retry');
    const before = alice.epochOf('p-retry');
    home.faults = [{ kind: 'commit', when: 'after', status: 504 }];
    await expect(alice.removeMembers('p-retry', ['@b:h'])).rejects.toMatchObject({ status: 504 });
    const landed = commitsBy(home, 'p-retry', 'd-alice');
    expect(landed).toHaveLength(1);

    const window = home.frames.get('p-retry').filter((f) => f.seq < landed[0].seq);
    await alice.sync('p-retry', window);
    expect(commitsBy(home, 'p-retry', 'd-alice')).toHaveLength(1);
    expect(alice.epochOf('p-retry')).toBe(before + 1);
  });
});
