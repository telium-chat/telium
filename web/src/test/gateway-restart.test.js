import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionManager } from '../lib/gateway.js';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    FakeSocket.opened.push(this);
  }

  send(data) { this.sent.push(data); }

  close() { this.onclose?.({ code: 1000, reason: 'closed' }); }

  serverClosed(code, reason) { this.onclose?.({ code, reason }); }
}
FakeSocket.opened = [];

function connect(manager) {
  manager.add({ domain: 'a.example', url: 'wss://a.example/gw', token: 't', intents: [] });
  vi.advanceTimersByTime(50);
  return FakeSocket.opened.at(-1);
}

describe('a server that says it is restarting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.opened = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects inside the restart window however long it has been failing', () => {
    const manager = new ConnectionManager();
    const socket = connect(manager);
    const conn = manager.connections.get('a.example');
    conn.attempt = 4;

    socket.serverClosed(4005, 'server restarting');

    vi.advanceTimersByTime(400);
    expect(FakeSocket.opened).toHaveLength(1);

    vi.advanceTimersByTime(2_700);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it('does not spend one of the backoff steps on the server being deployed', () => {
    const manager = new ConnectionManager();
    const socket = connect(manager);
    const conn = manager.connections.get('a.example');

    socket.serverClosed(4005, 'server restarting');
    expect(conn.attempt).toBe(0);

    vi.advanceTimersByTime(3_000);
    FakeSocket.opened.at(-1).serverClosed(1006, 'gone');
    expect(conn.attempt).toBe(1);
  });

  it('keeps the session, unlike a revocation', () => {
    const manager = new ConnectionManager();
    const socket = connect(manager);
    const conn = manager.connections.get('a.example');

    socket.serverClosed(4005, 'server restarting');
    expect(conn.wanted).toBe(true);
    expect(conn.status).toBe('degraded');
  });

  it('still escalates for a server that actually fell over', () => {
    const manager = new ConnectionManager();
    const socket = connect(manager);
    const conn = manager.connections.get('a.example');

    socket.serverClosed(1006, 'gone');
    expect(conn.attempt).toBe(1);
    vi.advanceTimersByTime(400);
    expect(FakeSocket.opened).toHaveLength(1);
    vi.advanceTimersByTime(700);
    expect(FakeSocket.opened).toHaveLength(2);
  });
});
