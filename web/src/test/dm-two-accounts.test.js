import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { freshStore } from './fake-server.js';
import { FakeHome, device } from './mls-home.js';

const ALICE = '@alice:home.example';
const BOB = '@bob:home.example';

let space = 0;
function server() {
  const home = new FakeHome();
  space += 1;
  home.seq = space * 1000;
  return home;
}

function storeFor(home, userId, deviceId, conversationId, mls) {
  const store = freshStore();
  store.me = { user_id: userId };
  store.conversations = [{ id: conversationId, kind: 'dm', members: [ALICE, BOB] }];
  store.refreshConversations = async () => {};
  store.home = home.for(userId, deviceId);
  store.mls = mls;
  store.navigate({ view: 'dms', conversationId });
  return store;
}

function waitForDm(store, conversationId, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for a dm event on ${conversationId}`));
    }, timeoutMs);
    const off = store.on('dm', (e) => {
      if (e?.conversation_id !== conversationId) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

describe('two accounts talking through the store', () => {
  it('both accounts see each other’s messages', async () => {
    const home = server();
    const id = 'conv-live';

    const aliceMls = await device(home, ALICE, 'd-alice-live');
    const alice = storeFor(home, ALICE, 'd-alice-live', id, aliceMls);
    const bobMls = await device(home, BOB, 'd-bob-live');
    const bob = storeFor(home, BOB, 'd-bob-live', id, bobMls);

    const built = await aliceMls.establish(id, [BOB, ALICE]);
    expect(built.welcome).toBeTruthy();
    const welcome = await home.for(ALICE, 'd-alice-live').sendFrame(id, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });

    bob.onDmFrame(welcome, false);
    await waitForDm(bob, id);
    expect(bobMls.joined(id)).toBe(true);

    const said = await aliceMls.send(id, 'hello from alice');
    const saidFrame = home.frames.get(id).find((f) => f.id === said.id);
    bob.onDmFrame(saidFrame, true);
    await waitForDm(bob, id);
    expect(bobMls.textOf(saidFrame.id)).toBe('hello from alice');

    const replied = await bobMls.send(id, 'hello from bob');
    const repliedFrame = home.frames.get(id).find((f) => f.id === replied.id);
    alice.onDmFrame(repliedFrame, true);
    await waitForDm(alice, id);
    expect(aliceMls.textOf(repliedFrame.id)).toBe('hello from bob');
    expect(aliceMls.textOf(saidFrame.id)).toBe('hello from alice');
  });

  it('works when the conversation is opened before anything arrives live', async () => {
    const home = server();
    const id = 'conv-opened';

    const aliceMls = await device(home, ALICE, 'd-alice-opened');
    const alice = storeFor(home, ALICE, 'd-alice-opened', id, aliceMls);
    const bobMls = await device(home, BOB, 'd-bob-opened');
    const bob = storeFor(home, BOB, 'd-bob-opened', id, bobMls);

    const built = await aliceMls.establish(id, [BOB, ALICE]);
    await home.for(ALICE, 'd-alice-opened').sendFrame(id, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    const said = await aliceMls.send(id, 'hey bob');

    await bob.openConversation(id);
    expect(bobMls.joined(id)).toBe(true);
    const saidFrame = home.frames.get(id).find((f) => f.id === said.id);
    expect(bobMls.textOf(saidFrame.id)).toBe('hey bob');

    const replied = await bobMls.send(id, 'hey alice');
    const repliedFrame = home.frames.get(id).find((f) => f.id === replied.id);
    alice.onDmFrame(repliedFrame, true);
    await waitForDm(alice, id);
    expect(aliceMls.textOf(repliedFrame.id)).toBe('hey alice');
  });

  it('reads a frame that arrived before the engine was published', async () => {
    const home = server();
    const id = 'conv-boot';

    const aliceMls = await device(home, ALICE, 'd-alice-boot');
    const bobMls = await device(home, BOB, 'd-bob-boot');

    const built = await aliceMls.establish(id, [BOB, ALICE]);
    const welcome = await home.for(ALICE, 'd-alice-boot').sendFrame(id, {
      kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
    });
    const said = await aliceMls.send(id, 'said during boot');
    const saidFrame = home.frames.get(id).find((f) => f.id === said.id);

    const bob = storeFor(home, BOB, 'd-bob-boot', id, null);
    bob.onDmFrame(welcome, false);
    bob.onDmFrame(saidFrame, true);
    expect(bobMls.textOf(saidFrame.id)).toBeUndefined();

    bob.mls = bobMls;
    bob.dmFrames.set(id, [welcome, saidFrame]);
    await bob.drainStartup();

    expect(bobMls.joined(id)).toBe(true);
    expect(bobMls.textOf(saidFrame.id)).toBe('said during boot');
  });
});
