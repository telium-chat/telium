import { isNativeShellRuntime } from '../platform.js';

function bridge() {
  return globalThis.teliumDesktop?.relay;
}

export function tunnelSupported() {
  return isNativeShellRuntime() && typeof bridge()?.fetch === 'function';
}

let capability = null;

let understood = false;

export function relayCapability() {
  return capability;
}

export function relayUnderstood() {
  return understood;
}

export function setRelayCapability(next, token, knows = false) {
  capability = next && next.enabled ? next : null;
  understood = knows || capability !== null;
  bridge()?.configure?.({
    url: capability?.url || null,
    token: capability ? token || null : null,
  });
}

async function serialize(url, init) {
  const request = new Request(url, init);
  const headers = [...request.headers.entries()];
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? null
    : new Uint8Array(await request.arrayBuffer());
  return { url: request.url, method: request.method, headers, body };
}

const NO_BODY = new Set([101, 204, 205, 304]);

export async function openTunnelFetch(domain, url, init = {}) {
  const relay = bridge();
  if (!relay?.fetch) {
    const err = new Error('this build cannot use protected connections');
    err.code = 'unsupported';
    throw err;
  }
  const request = await serialize(url, init);
  const reply = await relay.fetch({ domain, ...request });
  if (reply?.error) {
    const err = new Error(reply.message || 'the protected connection could not be opened');
    err.code = reply.error;
    throw err;
  }
  const bytes = reply.body ? new Uint8Array(reply.body) : null;
  return new Response(NO_BODY.has(reply.status) ? null : bytes, {
    status: reply.status,
    statusText: reply.statusText || '',
    headers: reply.headers || [],
  });
}

class TunnelSocket {
  static CONNECTING = 0;

  static OPEN = 1;

  static CLOSING = 2;

  static CLOSED = 3;

  constructor(domain, url, protocols) {
    this.url = url;
    this.protocol = '';
    this.readyState = TunnelSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._listeners = new Map();
    this._id = null;
    // Throw like a real WebSocket rather than drop the frame silently
    this._queue = [];
    this._closing = null;

    this._off = bridge().onSocketEvent((event) => {
      if (event.id !== this._id) return;
      this._handle(event);
    });

    bridge().socketOpen({ domain, url, protocols })
      .then((opened) => {
        if (opened?.error) throw Object.assign(new Error(opened.message || 'refused'), { code: opened.error });
        this._id = opened.id;
        this.protocol = opened.protocol || '';
        this.readyState = TunnelSocket.OPEN;
        this._emit({ type: 'open' });
        for (const pending of this._queue.splice(0)) this.send(pending);
        if (this._closing) this.close(...this._closing);
      })
      .catch((err) => {
        // Look like a refused TCP connection: error then close
        this.readyState = TunnelSocket.CLOSED;
        this._emit({ type: 'error', message: err.message });
        this._emit({ type: 'close', code: 4000, reason: err.message || '', wasClean: false });
        this._off?.();
      });
  }

  _handle(event) {
    if (event.type === 'message') {
      this._emit({ type: 'message', data: event.binary ? new Uint8Array(event.data).buffer : event.data });
      return;
    }
    if (event.type === 'error') {
      this._emit({ type: 'error', message: event.message });
      return;
    }
    if (event.type === 'close') {
      this.readyState = TunnelSocket.CLOSED;
      this._emit({ type: 'close', code: event.code ?? 1006, reason: event.reason || '', wasClean: Boolean(event.wasClean) });
      this._off?.();
    }
  }

  _emit(event) {
    this[`on${event.type}`]?.(event);
    for (const fn of this._listeners.get(event.type) || []) fn(event);
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  send(data) {
    if (this.readyState === TunnelSocket.CONNECTING) {
      this._queue.push(data);
      return;
    }
    if (this.readyState !== TunnelSocket.OPEN) return;
    const binary = typeof data !== 'string';
    bridge().socketSend({
      id: this._id,
      binary,
      data: binary ? new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer ?? data) : data,
    }).catch(() => {
      this.readyState = TunnelSocket.CLOSED;
      this._emit({ type: 'close', code: 1006, reason: 'tunnel lost', wasClean: false });
    });
  }

  close(code, reason) {
    if (this.readyState === TunnelSocket.CONNECTING) {
      this._closing = [code, reason];
      return;
    }
    if (this.readyState === TunnelSocket.CLOSED) return;
    this.readyState = TunnelSocket.CLOSING;
    bridge().socketClose({ id: this._id, code, reason }).catch(() => {});
  }
}

export function openTunnelSocket(domain, url, protocols) {
  const relay = bridge();
  if (!relay?.socketOpen) {
    const err = new Error('this build cannot use protected connections');
    err.code = 'unsupported';
    throw err;
  }
  return new TunnelSocket(domain, url, protocols);
}

export { TunnelSocket };
