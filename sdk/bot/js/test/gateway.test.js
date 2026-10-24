import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayConnection } from '../src/gateway.js';

test('gateway reconnect survives transient 502s and eventually reopens', async () => {
  let attempts = 0;
  let opened = 0;
  const warnings = [];

  const connection = new GatewayConnection({
    domain: 'guild.example',
    gateway: 'wss://guild.example/gateway/v1',
    token: 'old',
    intents: [],
    retryBaseMs: 1,
    retryMaxMs: 2,
    refresh: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('HTTP 502');
        error.status = 502;
        throw error;
      }
      return {
        token: 'fresh',
        gateway: 'wss://guild.example/gateway/v1',
      };
    },
    onRefreshError: (error, attempt) => {
      warnings.push([error.status, attempt]);
      return true;
    },
  });
  connection.open = () => { opened += 1; };

  await connection.reconnect();

  assert.equal(attempts, 3);
  assert.equal(opened, 1);
  assert.equal(connection.token, 'fresh');
  assert.deepEqual(warnings, [[502, 1], [502, 2]]);
});

test('gateway reconnect can stop a terminal refresh without looping forever', async () => {
  let attempts = 0;
  let stopped = 0;

  const connection = new GatewayConnection({
    domain: 'guild.example',
    gateway: 'wss://guild.example/gateway/v1',
    token: 'old',
    intents: [],
    retryBaseMs: 1,
    retryMaxMs: 2,
    refresh: async () => {
      attempts += 1;
      const error = new Error('bot is not installed on this guild server');
      error.status = 403;
      throw error;
    },
    onRefreshError: () => false,
    onStopped: () => { stopped += 1; },
  });
  connection.open = () => {
    throw new Error('terminal reconnect should not reopen');
  };

  await connection.reconnect();

  assert.equal(attempts, 1);
  assert.equal(stopped, 1);
  assert.equal(connection.closed, true);
});

// Fake WebSocket that can stop answering without emitting `close` (half-open socket).
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
    this.listeners = new Map();
    this.closedWith = null;
    this.answerHeartbeats = true;
    FakeSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    const set = this.listeners.get(type) || new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  dispatch(type, event) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }

  receive(frame) {
    this.dispatch('message', { data: JSON.stringify(frame) });
  }

  send(raw) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (frame.op === 'HEARTBEAT' && this.answerHeartbeats) {
      queueMicrotask(() => this.receive({ op: 'HEARTBEAT_ACK' }));
    }
  }

  close(code, reason) {
    this.closedWith = { code, reason };
    this.readyState = FakeSocket.CLOSED;
  }
}

async function withFakeSockets(fn) {
  const original = globalThis.WebSocket;
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket;
  try {
    return await fn();
  } finally {
    globalThis.WebSocket = original;
  }
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a socket that stops acknowledging heartbeats is torn down and reconnected', async () => {
  await withFakeSockets(async () => {
    let refreshes = 0;
    const timeouts = [];
    const connection = new GatewayConnection({
      domain: 'guild.example',
      gateway: 'wss://guild.example/gateway/v1',
      token: 'session',
      intents: [],
      retryBaseMs: 1,
      retryMaxMs: 2,
      heartbeatAckTimeoutMs: 250,
      refresh: async () => {
        refreshes += 1;
        return { token: 'fresh', gateway: 'wss://guild.example/gateway/v1' };
      },
      onHeartbeatTimeout: (error) => timeouts.push(error),
    });

    connection.open();
    const socket = FakeSocket.instances[0];
    socket.receive({ op: 'HELLO', d: { heartbeat_interval_ms: 100 } });
    assert.deepEqual(socket.sent.map((f) => f.op), ['IDENTIFY']);

    socket.answerHeartbeats = false;
    await tick(500);

    assert.deepEqual(socket.sent.map((f) => f.op), ['IDENTIFY', 'HEARTBEAT']);
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].code, 'TELIUM_HEARTBEAT_TIMEOUT');
    assert.equal(socket.closedWith?.code, 4000);

    await connection.reconnectPromise;
    assert.equal(refreshes, 1, 'the ordinary reconnect path must take over');
    assert.equal(FakeSocket.instances.length, 2);
    connection.close();
  });
});

test('an acknowledged heartbeat keeps the connection alive', async () => {
  await withFakeSockets(async () => {
    const timeouts = [];
    const connection = new GatewayConnection({
      domain: 'guild.example',
      gateway: 'wss://guild.example/gateway/v1',
      token: 'session',
      intents: [],
      heartbeatAckTimeoutMs: 250,
      refresh: async () => { throw new Error('should not reconnect'); },
      onHeartbeatTimeout: (error) => timeouts.push(error),
    });

    connection.open();
    const socket = FakeSocket.instances[0];
    socket.receive({ op: 'HELLO', d: { heartbeat_interval_ms: 100 } });
    await tick(360);

    assert.ok(socket.sent.filter((f) => f.op === 'HEARTBEAT').length >= 2);
    assert.deepEqual(timeouts, []);
    assert.equal(connection.socket, socket);
    assert.equal(socket.closedWith, null);
    connection.close();
  });
});

test('a late close from an abandoned socket cannot tear down its replacement', async () => {
  await withFakeSockets(async () => {
    let refreshes = 0;
    const connection = new GatewayConnection({
      domain: 'guild.example',
      gateway: 'wss://guild.example/gateway/v1',
      token: 'session',
      intents: [],
      retryBaseMs: 1,
      retryMaxMs: 2,
      heartbeatAckTimeoutMs: 250,
      refresh: async () => {
        refreshes += 1;
        return { token: 'fresh', gateway: 'wss://guild.example/gateway/v1' };
      },
    });

    connection.open();
    const stale = FakeSocket.instances[0];
    stale.receive({ op: 'HELLO', d: { heartbeat_interval_ms: 100 } });
    stale.answerHeartbeats = false;
    await tick(500);
    await connection.reconnectPromise;

    const live = FakeSocket.instances[1];
    assert.ok(live && live !== stale);

    stale.dispatch('close', {});
    await tick(20);

    assert.equal(refreshes, 1, 'a stale close must not trigger another reconnect');
    assert.equal(connection.socket, live);
    connection.close();
  });
});

test('backoff is not reset by a READY the server immediately hangs up on', async () => {
  const connection = new GatewayConnection({
    domain: 'guild.example',
    gateway: 'wss://guild.example/gateway/v1',
    token: 'session',
    intents: [],
    retryBaseMs: 1,
    retryMaxMs: 2,
    stableAfterMs: 60000,
    refresh: async () => ({ token: 'fresh', gateway: 'wss://guild.example/gateway/v1' }),
  });
  connection.open = () => {};

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    connection.readyAt = Date.now();      // READY arrived...
    await connection.reconnect();          // ...and the socket closed at once.
    assert.equal(connection.attempt, cycle, 'backoff must keep escalating');
  }
  connection.close();
});

test('backoff is forgiven once a connection has actually stood up', async () => {
  const connection = new GatewayConnection({
    domain: 'guild.example',
    gateway: 'wss://guild.example/gateway/v1',
    token: 'session',
    intents: [],
    retryBaseMs: 1,
    retryMaxMs: 2,
    stableAfterMs: 10,
    refresh: async () => ({ token: 'fresh', gateway: 'wss://guild.example/gateway/v1' }),
  });
  connection.open = () => {};

  connection.attempt = 5;
  connection.readyAt = Date.now() - 50;
  await connection.reconnect();
  assert.equal(connection.attempt, 1, 'a long-lived connection starts over at the floor');
  connection.close();
});
