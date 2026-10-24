import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
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

async function conversation(home, id) {
  const alice = await device(home, ALICE, `d-alice-${id}`);
  const bob = await device(home, BOB, `d-bob-${id}`);
  const built = await alice.establish(id, [BOB]);
  await home.for(ALICE, `d-alice-${id}`).sendFrame(id, {
    kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch,
  });
  await bob.sync(id, home.frames.get(id));
  return { alice, bob };
}

describe('a frame from a session of this account that the device list lost', () => {
  it('is stepped over rather than walked into', async () => {
    const home = server();
    const id = 'conv-forgotten-session';
    const { alice, bob } = await conversation(home, id);

    const said = await alice.send(id, 'from the first session');
    const frames = home.frames.get(id);
    expect(frames.find((f) => f.id === said.id)).toBeTruthy();

    const second = await device(home, ALICE, `d-alice-second-${id}`);
    second.ownDevices.delete(`d-alice-${id}`);
    expect(second.isMine(frames.find((f) => f.id === said.id))).toBe(false);

    await second.sync(id, frames);

    expect(second.errorFor(id)).toBeFalsy();
  });

  it('still reads what the other person says afterwards', async () => {
    const home = server();
    const id = 'conv-after-own-frame';
    const { alice, bob } = await conversation(home, id);

    await alice.send(id, 'from the first session');

    const second = await device(home, ALICE, `d-alice-second-${id}`);
    second.ownDevices.delete(`d-alice-${id}`);
    await second.sync(id, home.frames.get(id));

    const replied = await bob.send(id, 'and back to you');
    await second.sync(id, home.frames.get(id));

    expect(second.textOf(replied.id)).toBe('and back to you');
    expect(second.errorFor(id)).toBeFalsy();
  });

  it('remembers the session id it proved from the key', async () => {
    const home = server();
    const id = 'conv-learned-id';
    const { alice } = await conversation(home, id);
    const firstDeviceId = `d-alice-${id}`;

    await alice.send(id, 'from the first session');

    const second = await device(home, ALICE, `d-alice-second-${id}`);
    second.ownDevices.delete(firstDeviceId);

    await second.sync(id, home.frames.get(id));
    for (let i = 0; i < 30; i += 1) await Promise.resolve();

    expect(second.ownDevices.has(firstDeviceId)).toBe(true);
    expect(second.isMine({ sender: ALICE, sender_device: firstDeviceId })).toBe(true);
  });

  it('never steps over somebody else’s frame', async () => {
    const home = server();
    const id = 'conv-peer-frame';
    const { alice, bob } = await conversation(home, id);

    const said = await bob.send(id, 'from bob');
    await alice.sync(id, home.frames.get(id));

    expect(alice.textOf(said.id)).toBe('from bob');
    expect(alice.errorFor(id)).toBeFalsy();
  });

  it('says a foreign key is not its own', async () => {
    const home = server();
    const id = 'conv-foreign-key';
    const { alice, bob } = await conversation(home, id);

    const bobKey = await bob.leafKey();
    const aliceKey = await alice.leafKey();
    expect(bobKey).not.toBe(aliceKey);

    const bytes = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    expect(await alice.ownSignatureKey(bytes(bobKey))).toBe(false);
    expect(await alice.ownSignatureKey(bytes(aliceKey))).toBe(true);
    expect(await alice.ownSignatureKey(null)).toBe(false);
  });
});
