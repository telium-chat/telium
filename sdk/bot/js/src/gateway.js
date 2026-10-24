import { sleep } from './http.js';

// A missing ack means a dead path; the server acks immediately.
export const DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS = 15000;

// A connection must survive this long before backoff resets (see `reconnect()`).
export const DEFAULT_STABLE_AFTER_MS = 30000;

export class GatewayConnection {
  constructor({
    domain,
    gateway,
    token,
    intents,
    onDispatch,
    onReady,
    onError,
    onRefreshError,
    onStopped,
    onHeartbeatTimeout,
    refresh,
    retryBaseMs = 500,
    retryMaxMs = 30000,
    heartbeatAckTimeoutMs = DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS,
    stableAfterMs = DEFAULT_STABLE_AFTER_MS,
  }) {
    this.domain = domain;
    this.gateway = gateway;
    this.token = token;
    this.intents = intents;
    this.onDispatch = onDispatch;
    this.onReady = onReady;
    this.onError = onError;
    this.onRefreshError = onRefreshError;
    this.onStopped = onStopped;
    this.onHeartbeatTimeout = onHeartbeatTimeout;
    this.refresh = refresh;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.heartbeatAckTimeoutMs = Math.max(250, Number(heartbeatAckTimeoutMs) || DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS);
    this.stableAfterMs = Number.isFinite(Number(stableAfterMs))
      ? Math.max(0, Number(stableAfterMs))
      : DEFAULT_STABLE_AFTER_MS;
    this.socket = null;
    this.heartbeat = null;
    this.ackTimer = null;
    this.awaitingAck = false;
    this.lastAckAt = null;
    this.readyAt = null;
    this.closed = false;
    this.attempt = 0;
    this.reconnecting = false;
    this.reconnectPromise = null;
  }

  clearTimers() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.awaitingAck = false;
  }

  // Dead paths never fire `close`; clear `this.socket` first so a late event cannot tear down the replacement.
  dropUnacknowledged(socket) {
    if (this.socket !== socket) return;
    this.clearTimers();
    this.socket = null;
    this.readyAt = null;
    const error = new Error(
      `Gateway for ${this.domain} stopped acknowledging heartbeats within ${this.heartbeatAckTimeoutMs}ms; reconnecting`,
    );
    error.code = 'TELIUM_HEARTBEAT_TIMEOUT';
    try { socket.close(4000, 'heartbeat ack timeout'); } catch { /* already unusable */ }
    this.onHeartbeatTimeout?.(error, this.domain);
    this.reconnect();
  }

  open() {
    if (this.closed) return;
    this.clearTimers();
    const socket = new WebSocket(this.gateway);
    this.socket = socket;
    this.readyAt = null;

    // Listeners are bound to their socket so an abandoned one cannot act on its replacement.
    const isCurrent = () => this.socket === socket;

    socket.addEventListener('message', (event) => {
      if (!isCurrent()) return;
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.op === 'HELLO') {
        this.clearTimers();
        // Floor guards against a pathological interval spinning the CPU.
        const every = Math.max(100, Number(frame.d?.heartbeat_interval_ms) || 45000);
        // Ack window <= heartbeat period, or the liveness check has no edge to fire on.
        const ackWindow = Math.max(250, Math.min(this.heartbeatAckTimeoutMs, every));
        this.heartbeat = setInterval(() => {
          if (!isCurrent()) return;
          if (socket.readyState !== WebSocket.OPEN) return;
          if (this.awaitingAck) return;
          socket.send(JSON.stringify({ op: 'HEARTBEAT' }));
          this.awaitingAck = true;
          clearTimeout(this.ackTimer);
          this.ackTimer = setTimeout(() => {
            if (!isCurrent() || !this.awaitingAck) return;
            this.dropUnacknowledged(socket);
          }, ackWindow);
          this.ackTimer.unref?.();
        }, every);
        this.heartbeat.unref?.();
        socket.send(JSON.stringify({
          op: 'IDENTIFY',
          d: { token: this.token, intents: this.intents, presence: { status: 'online' } },
        }));
        return;
      }
      if (frame.op === 'HEARTBEAT_ACK') {
        this.awaitingAck = false;
        this.lastAckAt = Date.now();
        clearTimeout(this.ackTimer);
        this.ackTimer = null;
        return;
      }
      if (frame.op === 'READY') {
        // Backoff reset is deferred to `reconnect()`, which sees how long the connection lasted.
        this.readyAt = Date.now();
        this.onReady?.(frame.d, this.domain);
        return;
      }
      if (frame.op === 'DISPATCH') {
        this.onDispatch?.(frame.t, frame.d, this.domain);
      }
    });

    socket.addEventListener('error', (event) => {
      if (!isCurrent()) return;
      this.onError?.(event);
    });
    socket.addEventListener('close', () => {
      if (!isCurrent()) return;
      this.reconnect();
    });
  }

  reconnect() {
    if (this.closed) return Promise.resolve();
    if (this.reconnecting) return this.reconnectPromise;

    // READY alone proves nothing (a server can send it, then close); require the connection to stand a while before resetting backoff.
    const stable = this.readyAt !== null && Date.now() - this.readyAt >= this.stableAfterMs;
    if (stable) this.attempt = 0;
    this.readyAt = null;

    this.clearTimers();
    this.socket = null;
    this.reconnecting = true;

    this.reconnectPromise = (async () => {
      while (!this.closed) {
        this.attempt += 1;
        const delay = Math.min(
          this.retryMaxMs,
          this.retryBaseMs * (2 ** Math.min(this.attempt, 6)),
        );
        await sleep(delay);
        if (this.closed) return;

        try {
          const fresh = await this.refresh();
          if (this.closed) return;
          this.token = fresh.token;
          this.gateway = fresh.gateway;
          this.open();
          return;
        } catch (error) {
          let retry = true;
          if (this.onRefreshError) {
            try {
              retry = this.onRefreshError(error, this.attempt, this.domain) !== false;
            } catch (callbackError) {
              this.onError?.(callbackError);
            }
          } else {
            this.onError?.(error);
          }

          if (!retry) {
            this.closed = true;
            this.clearTimers();
            this.socket = null;
            this.onStopped?.(error, this.domain);
            return;
          }
        }
      }
    })().finally(() => {
      this.reconnecting = false;
      this.reconnectPromise = null;
    });

    return this.reconnectPromise;
  }

  close() {
    this.closed = true;
    this.clearTimers();
    this.readyAt = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
