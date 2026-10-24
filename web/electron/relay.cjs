'use strict';

// Protected transport: nested TLS over a relay byte tunnel. Nothing here may relax inner-session verification (no `rejectUnauthorized: false`, ever).

const crypto = require('node:crypto');
const http = require('node:http');
const { Duplex } = require('node:stream');
const tls = require('node:tls');
const zlib = require('node:zlib');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPEN_TIMEOUT_MS = 20_000;

const RESPONSE_TIMEOUT_MS = 60_000;

/// A frame header can claim a 64-bit length; believing it lets a peer allocate gigabytes.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const MAX_REDIRECTS = 5;

const CLOSE_CODE_ERRORS = {
  4001: 'unauthorized',
  4003: 'destination-refused',
  4008: 'idle',
  4013: 'budget',
  4029: 'rate-limited',
  4031: 'disabled',
  4504: 'unreachable',
};

const OWNED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/// Wrong by the time the reply crosses IPC: the body is decompressed and framing undone.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding',
]);

function relayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/// All logging goes through here so the rule (never token, path, body or header) is enforceable in one place.
function note(message) {
  console.warn(`[Telium relay] ${message}`);
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
}

// No WebSocket client dependency: Node's global one cannot send `Authorization` on the handshake or run over our socket. No extensions, so any RSV bit is a protocol error.

function clientFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.allocUnsafe(6);
    header[1] = 0x80 | body.length;
    mask.copy(header, 2);
  } else if (body.length < 65_536) {
    header = Buffer.allocUnsafe(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.allocUnsafe(14);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
    mask.copy(header, 10);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, masked]);
}

/// Payloads are views into the accumulation buffer, which is only replaced, never written into.
function createFrameReader({ onMessage, onPing, onClose, onError }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  let fragmentBytes = 0;
  let broken = false;

  const fail = (message) => {
    broken = true;
    onError(relayError('failed', message));
  };

  return function feed(chunk) {
    if (broken) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (broken || buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;

      // No extension negotiated, so a reserved bit means the peer speaks a protocol we did not agree to.
      if ((first & 0x70) !== 0) { fail('the peer framed with an extension we did not negotiate'); return; }
      // A masked frame from a server is a protocol violation.
      if ((second & 0x80) !== 0) { fail('the peer masked a server frame'); return; }

      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const claimed = buffer.readBigUInt64BE(2);
        if (claimed > BigInt(MAX_FRAME_BYTES)) { fail('the peer announced an implausibly large frame'); return; }
        length = Number(claimed);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) { fail('the peer announced an implausibly large frame'); return; }
      if (buffer.length < offset + length) return;

      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);

      if (opcode >= 0x8) {
        // Control frames may interleave a fragmented message; handle them before fragment bookkeeping.
        if (!fin || length > 125) { fail('the peer fragmented a control frame'); return; }
        if (opcode === 0x8) {
          const code = length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = length > 2 ? payload.subarray(2).toString('utf8') : '';
          onClose({ code, reason });
          return;
        }
        if (opcode === 0x9) onPing(payload);
        continue;
      }

      if (opcode === 0x0) {
        if (!fragments.length) { fail('the peer continued a message it had not started'); return; }
      } else {
        if (fragments.length) { fail('the peer started a message without finishing the last one'); return; }
        fragmentOpcode = opcode;
      }

      fragmentBytes += length;
      if (fragmentBytes > MAX_FRAME_BYTES) { fail('the peer sent an implausibly large message'); return; }
      fragments.push(payload);

      if (!fin) continue;
      const complete = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
      const binary = fragmentOpcode === 0x2;
      fragments = [];
      fragmentBytes = 0;
      onMessage(binary, complete);
    }
  };
}

/// Messages arriving before the first `receive()` are queued; handlers are installed late because the relay socket needs two sets in sequence.
function openWebSocket({ url, headers = {}, protocols = null, createConnection }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'wss:' || target.protocol === 'https:';
    const key = crypto.randomBytes(16).toString('base64');

    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = createConnection;

    const requestHeaders = {
      Host: target.host,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      ...headers,
    };
    const offered = Array.isArray(protocols)
      ? protocols.filter((entry) => typeof entry === 'string' && entry.length)
      : (typeof protocols === 'string' && protocols ? [protocols] : []);
    if (offered.length) requestHeaders['Sec-WebSocket-Protocol'] = offered.join(', ');

    // `http:` is not a downgrade: `createConnection` returns an already-encrypted socket.
    const request = http.request({
      agent,
      method: 'GET',
      protocol: 'http:',
      host: target.hostname,
      port: Number(target.port) || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers: requestHeaders,
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      agent.destroy();
      reject(relayError('failed', 'the relay did not complete the handshake in time'));
    }, OPEN_TIMEOUT_MS);

    const giveUp = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent.destroy();
      reject(error);
    };

    request.on('error', () => giveUp(relayError('unreachable', 'the relay could not be reached')));

    // A plain response is the relay declining; keep 401 distinguishable (renewed home session, renderer retries).
    request.on('response', (response) => {
      response.resume();
      const status = response.statusCode || 0;
      if (status === 401) giveUp(relayError('unauthorized', 'the relay did not accept this session'));
      else if (status === 403) giveUp(relayError('disabled', 'the relay is not accepting tunnels from this account'));
      else if (status === 404) giveUp(relayError('unavailable', 'this account server does not offer a relay'));
      else if (status === 429) giveUp(relayError('rate-limited', 'the relay is asking this client to slow down'));
      else giveUp(relayError('failed', 'the relay refused the connection'));
    });

    request.on('upgrade', (response, socket, head) => {
      if (settled) { socket.destroy(); return; }

      // The accept value is the only evidence the peer understood the handshake, not a proxy returning 101.
      const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        giveUp(relayError('failed', 'the relay did not complete the WebSocket handshake'));
        return;
      }
      const negotiated = response.headers['sec-websocket-protocol'] || '';
      if (negotiated && !offered.includes(negotiated)) {
        socket.destroy();
        giveUp(relayError('failed', 'the peer selected a subprotocol that was not offered'));
        return;
      }
      // No extensions negotiated, so the peer may not select one.
      if (response.headers['sec-websocket-extensions']) {
        socket.destroy();
        giveUp(relayError('failed', 'the peer selected an extension that was not offered'));
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.setNoDelay(true);

      const queue = [];
      let handlers = null;
      let closed = false;

      const deliver = (event) => {
        if (handlers) handlers[event.kind]?.(event.a, event.b);
        else queue.push(event);
      };

      const finish = (code, reason) => {
        if (closed) return;
        closed = true;
        deliver({ kind: 'onClose', a: { code, reason } });
      };

      const reader = createFrameReader({
        onMessage: (binary, payload) => deliver({ kind: 'onMessage', a: binary, b: payload }),
        onPing: (payload) => {
          // Answering pings is required: the relay closes a client that ignores them as dead.
          if (!socket.destroyed) socket.write(clientFrame(0xA, payload));
        },
        onClose: ({ code, reason }) => {
          if (!socket.destroyed) {
            socket.write(clientFrame(0x8, Buffer.alloc(0)));
            socket.end();
          }
          finish(code, reason);
        },
        onError: (error) => {
          deliver({ kind: 'onError', a: error });
          socket.destroy();
        },
      });

      socket.on('data', (chunk) => reader(chunk));
      socket.on('error', () => deliver({ kind: 'onError', a: relayError('failed', 'the tunnel connection was lost') }));
      // 1006 is "closed without a close frame"; 1000 would report a clean shutdown for a cut connection.
      socket.on('close', () => finish(1006, ''));

      if (head && head.length) reader(head);

      resolve({
        socket,
        protocol: negotiated,
        receive(next) {
          handlers = next;
          for (const event of queue.splice(0)) handlers[event.kind]?.(event.a, event.b);
        },
        sendText(text) {
          if (socket.destroyed) return false;
          return socket.write(clientFrame(0x1, Buffer.from(text, 'utf8')));
        },
        sendBinary(bytes) {
          if (socket.destroyed) return false;
          return socket.write(clientFrame(0x2, bytes));
        },
        close(code = 1000, reason = '') {
          if (socket.destroyed) return;
          const body = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
          body.writeUInt16BE(code, 0);
          body.write(reason, 2, 'utf8');
          socket.write(clientFrame(0x8, body));
          socket.end();
        },
        destroy() {
          socket.destroy();
        },
      });
    });

    request.end();
  });
}


class TunnelStream extends Duplex {
  constructor(ws) {
    // So TLS cannot try to finish a handshake into a gone socket.
    super({ allowHalfOpen: false });
    this._ws = ws;
    this._ws.receive({
      onMessage: (binary, payload) => {
        // Only CLOSE is defined; other text must not be pushed into TLS as ciphertext.
        if (!binary) {
          this.push(null);
          return;
        }
        this.push(payload);
      },
      onClose: ({ code, reason }) => {
        const mapped = CLOSE_CODE_ERRORS[code];
        if (mapped) this.destroy(relayError(mapped, reason || 'the relay closed the tunnel'));
        else this.push(null);
      },
      onError: (error) => this.destroy(error),
    });
  }

  _read() {
    // Flow follows socket data events; there is nowhere to push back except the TCP window.
  }

  _write(chunk, _encoding, callback) {
    if (this._ws.sendBinary(chunk)) { callback(); return; }
    // Wait for `drain` so backpressure reaches TLS and HTTP instead of buffering an unbounded upload.
    this._ws.socket.once('drain', callback);
  }

  _final(callback) {
    this._ws.sendText(JSON.stringify({ op: 'CLOSE' }));
    this._ws.close(1000, '');
    callback();
  }

  _destroy(error, callback) {
    this._ws.destroy();
    callback(error);
  }
}

function createRelayBridge({ sendSocketEvent }) {
  /// A live home session bearer: never logged, never in an error message.
  let config = { url: null, token: null };

  const liveTunnels = new Set();
  const agents = new Map();
  const sockets = new Map();
  let nextSocketId = 1;

  function requireConfig() {
    if (!config.url || !config.token) {
      throw relayError('unavailable', 'no relay is configured for this session');
    }
    return config;
  }

  /// `serverName` is the policy name the relay checks; `host` is what the certificate must match. They differ for delegated servers, so do not collapse them.
  async function openTunnel({ serverName, host, port }) {
    const { url, token } = requireConfig();
    const relayUrl = new URL(url);
    const ws = await openWebSocket({
      url,
      headers: { Authorization: `Bearer ${token}` },
      createConnection: (_options, callback) => {
        const socket = tls.connect({
          host: relayUrl.hostname,
          port: Number(relayUrl.port) || 443,
          servername: relayUrl.hostname,
          ALPNProtocols: ['http/1.1'],
        });
        // Wait for `secureConnect` so a bad relay certificate is a connection error here.
        socket.once('secureConnect', () => callback(null, socket));
        socket.once('error', (error) => callback(error));
      },
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(relayError('failed', 'the relay did not answer the tunnel request')),
          OPEN_TIMEOUT_MS,
        );
        // Variadic: forwarding only the first argument would blame the relay for our bug.
        const settle = (fn) => (...args) => { clearTimeout(timer); fn(...args); };
        ws.receive({
          onMessage: settle((binary, payload) => {
            if (binary) {
              reject(relayError('failed', 'the relay sent payload before it answered'));
              return;
            }
            let frame;
            try {
              frame = JSON.parse(payload.toString('utf8'));
            } catch {
              reject(relayError('failed', 'the relay sent something that was not a control frame'));
              return;
            }
            if (frame?.op === 'READY') { resolve(frame.d || {}); return; }
            if (frame?.op === 'REFUSED') {
              // The relay's own code, verbatim; it knows why it said no.
              reject(relayError(frame.d?.error || 'failed', frame.d?.message || 'the relay refused the destination'));
              return;
            }
            reject(relayError('failed', 'the relay answered with an unknown control frame'));
          }),
          onClose: settle(({ code, reason }) => {
            reject(relayError(CLOSE_CODE_ERRORS[code] || 'failed', reason || 'the relay closed the tunnel'));
          }),
          onError: settle(reject),
        });
        ws.sendText(JSON.stringify({ op: 'OPEN', d: { server_name: serverName, host, port } }));
      });
    } catch (error) {
      ws.destroy();
      throw error;
    }

    const tunnel = new TunnelStream(ws);
    liveTunnels.add(tunnel);
    tunnel.once('close', () => liveTunnels.delete(tunnel));
    return tunnel;
  }

  /// Must never be relaxed: `rejectUnauthorized` stays true. WebPKI verification separates a forwarding relay from one that reads everything.
  async function connectSecurely({ serverName, host, port }) {
    const tunnel = await openTunnel({ serverName, host, port });
    return new Promise((resolve, reject) => {
      const secure = tls.connect({
        socket: tunnel,
        servername: host,
        ALPNProtocols: ['http/1.1'],
      });
      // Only pre-handshake failures tear down; afterwards the socket's own error reaches its reader.
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        tunnel.destroy();
        secure.destroy();
        reject(error);
      };
      secure.once('secureConnect', () => {
        if (!secure.authorized) {
          // Already enforced by `rejectUnauthorized`; checked again so a loosened option cannot yield an unverified session.
          fail(relayError('failed', 'the destination certificate did not verify'));
          return;
        }
        settled = true;
        resolve({ secure, tunnel });
      });
      secure.once('error', () => fail(relayError('failed', 'the protected connection to the server failed')));
      tunnel.once('error', (error) => fail(error.code ? error : relayError('failed', 'the tunnel failed')));
    });
  }

  /// `keepAlive` off: idle pooled tunnels would hold relay concurrency slots.
  function agentFor(serverName, host, port) {
    const key = `${serverName} ${host} ${port}`;
    const existing = agents.get(key);
    if (existing) return existing;
    const agent = new http.Agent({ keepAlive: false, maxSockets: 6 });
    agent.createConnection = (_options, callback) => {
      connectSecurely({ serverName, host, port }).then(
        ({ secure }) => callback(null, secure),
        (error) => callback(error),
      );
    };
    agents.set(key, agent);
    return agent;
  }

  /// Responses are accepted compressed because every tunnelled byte counts against the relay's budgets.
  function decode(response, body) {
    const encoding = String(response.headers['content-encoding'] || '').toLowerCase().trim();
    if (!encoding || encoding === 'identity' || !body.length) return body;
    try {
      if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(body);
      if (encoding === 'deflate') return zlib.inflateSync(body);
      if (encoding === 'br') return zlib.brotliDecompressSync(body);
      if (encoding === 'zstd' && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(body);
    } catch {
      throw relayError('failed', 'the server sent a body that could not be decoded');
    }
    throw relayError('failed', 'the server used a content encoding this client cannot read');
  }

  /// Second check after `transport.js` since the renderer runs page-supplied code; proves only a credential-free `https:` URL with a plausible host.
  function destinationOf(domain, raw, { schemes }) {
    const serverName = String(domain || '').toLowerCase();
    if (!serverName || serverName.length > 253 || !/^[a-z0-9.-]+$/.test(serverName)) {
      throw relayError('unsupported', 'that is not a server this client can protect');
    }
    let url;
    try {
      url = new URL(String(raw || ''));
    } catch {
      throw relayError('unsupported', 'that address cannot be opened');
    }
    if (!schemes.has(url.protocol)) {
      // Plaintext through the tunnel would expose bodies and headers to the relay.
      throw relayError('unsupported', 'protected connections must be encrypted end to end');
    }
    if (url.username || url.password) {
      throw relayError('unsupported', 'protected connections cannot carry credentials in the address');
    }
    return { serverName, url, host: url.hostname, port: Number(url.port) || 443 };
  }

  function requestHeadersFrom(pairs) {
    const headers = {};
    for (const pair of pairs || []) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const name = String(pair[0]);
      if (OWNED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      const value = String(pair[1]);
      // Repeated names are meaningful; Node sends an array as repeated header lines.
      if (headers[name] === undefined) headers[name] = value;
      else if (Array.isArray(headers[name])) headers[name].push(value);
      else headers[name] = [headers[name], value];
    }
    return headers;
  }

  function responseHeadersFrom(response) {
    const pairs = [];
    // `rawHeaders`, since `headers` collapses repeated `set-cookie`.
    for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
      const name = response.rawHeaders[i];
      if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
      pairs.push([name, response.rawHeaders[i + 1]]);
    }
    return pairs;
  }

  function exchange({ serverName, url, host, port, method, headers, body }) {
    return new Promise((resolve, reject) => {
      const request = http.request({
        agent: agentFor(serverName, host, port),
        method,
        protocol: 'http:',
        host,
        port,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, Host: url.host },
      }, (response) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            response.destroy();
            reject(relayError('failed', 'the response was too large to carry through the tunnel'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () => reject(relayError('failed', 'the response was cut short')));
        response.on('end', () => {
          try {
            resolve({ response, body: decode(response, Buffer.concat(chunks, total)) });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.setTimeout(RESPONSE_TIMEOUT_MS, () => {
        request.destroy();
        reject(relayError('failed', 'the protected request timed out'));
      });
      // Our errors carry lowercase codes; Node's `ECONNRESET`-style errors collapse to 'failed'.
      request.on('error', (error) => reject(
        typeof error?.code === 'string' && !/^[A-Z][A-Z0-9_]*$/.test(error.code)
          ? error
          : relayError('failed', 'the protected request could not be completed'),
      ));
      if (body && body.length) request.end(body);
      else request.end();
    });
  }

  /// Redirects are followed as `fetch` does; a cross-host redirect opens a new tunnel so the relay's published-host check applies.
  async function relayFetch({ domain, url: raw, method = 'GET', headers = [], body = null }) {
    let target = destinationOf(domain, raw, { schemes: new Set(['https:']) });
    let verb = String(method || 'GET').toUpperCase();
    let outgoing = requestHeadersFrom(headers);
    let payload = body && body.length ? asBuffer(body) : null;

    for (let hop = 0; ; hop += 1) {
      const { response, body: bytes } = await exchange({ ...target, method: verb, headers: outgoing, body: payload });
      const status = response.statusCode || 0;
      const location = response.headers.location;
      const redirects = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
      if (!redirects || !location || hop >= MAX_REDIRECTS) {
        return {
          status,
          statusText: response.statusMessage || '',
          headers: responseHeadersFrom(response),
          body: new Uint8Array(bytes),
        };
      }

      const next = destinationOf(domain, new URL(location, target.url).href, { schemes: new Set(['https:']) });
      if (next.url.origin !== target.url.origin) {
        // Credentials must not follow a redirect to a different origin.
        outgoing = Object.fromEntries(
          Object.entries(outgoing).filter(([name]) => {
            const lower = name.toLowerCase();
            return lower !== 'authorization' && lower !== 'cookie';
          }),
        );
      }
      // 303 means GET, and 301/302 have in practice for long enough.
      if (status === 303 || ((status === 301 || status === 302) && verb !== 'HEAD')) {
        verb = 'GET';
        payload = null;
        outgoing = Object.fromEntries(
          Object.entries(outgoing).filter(([name]) => !/^content-/i.test(name)),
        );
      }
      target = next;
    }
  }


  async function relaySocketOpen({ domain, url: raw, protocols = null }) {
    const target = destinationOf(domain, raw, { schemes: new Set(['wss:']) });
    const { secure, tunnel } = await connectSecurely(target);

    let handed = false;
    const ws = await openWebSocket({
      url: target.url.href,
      protocols,
      createConnection: (_options, callback) => {
        // A one-time hand-off; a second request would interleave on one stream.
        if (handed) { callback(relayError('failed', 'the tunnel cannot carry a second request')); return; }
        handed = true;
        callback(null, secure);
      },
    }).catch((error) => {
      tunnel.destroy();
      secure.destroy();
      throw error;
    });

    const id = nextSocketId;
    nextSocketId += 1;
    const entry = { ws, tunnel, secure };
    sockets.set(id, entry);

    const forget = () => {
      if (!sockets.has(id)) return;
      sockets.delete(id);
      tunnel.destroy();
    };

    ws.receive({
      onMessage: (binary, payload) => sendSocketEvent({
        id,
        type: 'message',
        binary,
        data: binary ? new Uint8Array(payload) : payload.toString('utf8'),
      }),
      onClose: ({ code, reason }) => {
        forget();
        sendSocketEvent({
          id,
          type: 'close',
          code,
          reason,
          // 1000 is the only clean close; reconnection logic must tell it from the rest (including 1006).
          wasClean: code === 1000,
        });
      },
      onError: (error) => sendSocketEvent({ id, type: 'error', message: error.message }),
    });

    return { id, protocol: ws.protocol || '' };
  }

  function relaySocketSend({ id, binary, data }) {
    const entry = sockets.get(id);
    if (!entry) return;
    if (binary) entry.ws.sendBinary(asBuffer(data));
    else entry.ws.sendText(String(data));
  }

  function relaySocketClose({ id, code, reason }) {
    const entry = sockets.get(id);
    if (!entry) return;
    entry.ws.close(Number(code) || 1000, String(reason || ''));
  }

  /// Those tunnels still count against the relay's budgets; a crashing renderer's reload loop would exhaust them.
  function reset() {
    const stranded = sockets.size + liveTunnels.size;
    for (const id of [...sockets.keys()]) {
      const entry = sockets.get(id);
      sockets.delete(id);
      try { entry.ws.destroy(); } catch { /* already gone */ }
      try { entry.tunnel.destroy(); } catch { /* already gone */ }
    }
    for (const tunnel of [...liveTunnels]) {
      liveTunnels.delete(tunnel);
      try { tunnel.destroy(); } catch { /* already gone */ }
    }
    for (const agent of agents.values()) agent.destroy();
    agents.clear();
    // Counted, not named: which servers they went to is what this feature avoids recording.
    if (stranded) note(`ended ${stranded} tunnel(s) left over from a page that is gone`);
  }

  return {
    /// Called on every discovery read, since the token renews on 401; changing the URL tears down the old session's tunnels.
    configure({ url, token } = {}) {
      const nextUrl = typeof url === 'string' && url ? url : null;
      const nextToken = typeof token === 'string' && token ? token : null;
      if (nextUrl !== config.url) reset();
      config = { url: nextUrl, token: nextToken };
      if (!nextUrl || !nextToken) reset();
    },
    relayUrl() {
      return config.url;
    },
    fetch: relayFetch,
    socketOpen: relaySocketOpen,
    socketSend: relaySocketSend,
    socketClose: relaySocketClose,
    reset,
    dispose() {
      reset();
      config = { url: null, token: null };
    },
  };
}

module.exports = {
  createRelayBridge,
  // Exported for `web/src/test/relay-framing.test.js`: framing can only be pinned by feeding it bytes.
  clientFrame,
  createFrameReader,
};
