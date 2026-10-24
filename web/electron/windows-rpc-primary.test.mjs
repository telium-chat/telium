import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWindowsRpcPrimaryPromoter,
  discordPipePath,
  rpcPipeSlot,
} from './windows-rpc-primary.mjs';

test('parses Discord IPC slots', () => {
  assert.equal(discordPipePath(0), '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(rpcPipeSlot('\\\\?\\pipe\\discord-ipc-7'), 7);
  assert.equal(rpcPipeSlot('/tmp/discord-ipc-2'), 2);
  assert.equal(rpcPipeSlot('not-rpc'), null);
});

test('promotes a secondary Windows listener when pipe zero becomes free', async () => {
  let closed = false;
  let promoted = null;
  const server = {
    ipc: {
      server: {
        address: () => '\\\\?\\pipe\\discord-ipc-1',
        close: () => { closed = true; },
      },
    },
  };
  const next = {
    server: {
      address: () => '\\\\?\\pipe\\discord-ipc-0',
      close: () => {},
    },
  };
  const promoter = createWindowsRpcPrimaryPromoter({
    platform: 'win32',
    server,
    isPipeOccupied: async () => false,
    createIpc: async () => next,
    onPromoted: (value) => { promoted = value; },
  });

  assert.equal(await promoter.check(), true);
  assert.equal(server.ipc, next);
  assert.equal(closed, true);
  assert.deepEqual(promoted, { from: 1, to: 0 });
});

test('does not disturb the current listener while pipe zero is occupied', async () => {
  const original = {
    server: {
      address: () => '\\\\?\\pipe\\discord-ipc-1',
      close: () => { throw new Error('must not close'); },
    },
  };
  const server = { ipc: original };
  const promoter = createWindowsRpcPrimaryPromoter({
    platform: 'win32',
    server,
    isPipeOccupied: async () => true,
    createIpc: async () => { throw new Error('must not create'); },
  });

  assert.equal(await promoter.check(), false);
  assert.equal(server.ipc, original);
});
