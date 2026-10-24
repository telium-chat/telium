// One independent socket per server, with per-server backoff and status; one server down must never look like the app being down.

import { Emitter } from './util.js';
import { classify, Close, Role } from './failure.js';
import { teliumSocket } from './net/transport.js';
import { closeMessage } from './i18n/errors.js';

const HEARTBEAT_MS = 45_000;
const BACKOFF_BASE = 1_000;
const BACKOFF_MAX = 60_000;

/// Window for a planned restart (4005); jittered so clients told together don't return in one tick.
const RESTART_RETRY_MIN = 500;
const RESTART_RETRY_MAX = 3_000;

/// Gap between socket opens and the most the queue may run ahead; the shared resource is this tab's main thread.
const STAGGER_MS = 25;
const STAGGER_MAX_MS = 500;

/// In memory only: evidence for a bug report, not a log of who the account talks to.
const FAILURE_HISTORY = 30;

function typingKey(frame) {
  if (frame.op === 'TYPING' || frame.op === 'TYPING_STOP') {
    return `guild:${frame.d?.channel_id || ''}`;
  }
  if (frame.op === 'DM_TYPING_START' || frame.op === 'DM_TYPING_STOP') {
    return `dm:${frame.d?.conversation_id || ''}`;
  }
  return null;
}

function isTypingStart(frame) {
  return frame.op === 'TYPING' || frame.op === 'DM_TYPING_START';
}

/// Shared by the setting dialog and the store; the server enforces the same limit.
export const MAX_CUSTOM_STATUS = 128;

export const Status = {
  Connecting: 'connecting',
  Ready: 'ready',
  Degraded: 'degraded',
  Rejected: 'rejected',
  /// Incompatible protocol: signing in again won't fix it and it must never be retried (the server closes before reading the token).
  Incompatible: 'incompatible',
  Closed: 'closed',
};

class Connection extends Emitter {
  constructor(manager, { domain, url, token, intents, presence, role, name }) {
    super();
    this.manager = manager;
    this.domain = domain;
    /// Decides "your account server is down" vs "one guild is down"; can't be derived here.
    this.role = role === Role.Home ? Role.Home : Role.Guild;
    this.name = name || domain;
    this.lastCode = 0;
    this.lastReason = '';
    /// Lets "reconnecting" become "that server is down". Null while up.
    this.downSince = null;
    this.url = url;
    this.token = token;
    this.intents = intents;
    this.presence = presence || { status: 'online' };
    this.status = Status.Closed;
    this.ready = false;
    this.attempt = 0;
    this.socket = null;
    this.timer = null;
    this.heartbeat = null;
    this.wanted = false;
    this.lastError = null;
    this.queue = [];
    this.typing = new Map();
  }

  setStatus(status, detail) {
    if (this.status === status && !detail) return;
    this.status = status;
    this.lastError = detail || null;
    const failure = this.failure();
    this.manager.note(failure);
    this.manager.emit('status', {
      domain: this.domain,
      status,
      detail: detail || null,
      // Recomputed on every emit because `downFor` and `navigator.onLine` move on their own.
      failure,
    });
  }

  failure() {
    if (this.status === Status.Ready || this.status === Status.Closed) return null;
    if (this.status === Status.Connecting && !this.downSince) return null;
    const classified = classify({
      code: this.lastCode,
      reason: this.lastReason,
      role: this.role,
      name: this.name,
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
      downFor: this.downSince ? Date.now() - this.downSince : 0,
    });
    return {
      ...classified,
      domain: this.domain,
      name: this.name,
      role: this.role,
      // A bug report needs the number, the reader the sentence.
      code: this.lastCode || null,
    };
  }

  connect() {
    this.wanted = true;
    if (this.socket) return;
    clearTimeout(this.timer);
    this.ready = false;
    this.setStatus(this.attempt === 0 ? Status.Connecting : Status.Degraded);
    let socket;
    try {
      // `teliumSocket` returns a real or tunnelled WebSocket with the same events.
      socket = teliumSocket(this.url, undefined, { purpose: 'live connection' });
    } catch (e) {
      this.fail(String(e));
      return;
    }
    this.socket = socket;
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.onFrame(ev);
    };
    socket.onerror = () => { /* onclose always follows; handle it there */ };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      clearInterval(this.heartbeat);
      // Kept, not consumed, so the code reaches the UI.
      this.lastCode = ev.code || 0;
      this.lastReason = ev.reason || '';
      if (this.downSince == null) this.downSince = Date.now();

      // Translated close code, with the server's English `reason` as fallback for an unknown number. 4015 is inverted in `closeMessage`.

      // The ends don't speak the same protocol; stop.
      if (ev.code === Close.PROTOCOL_INCOMPATIBLE) {
        this.setStatus(Status.Incompatible, closeMessage(ev.code, ev.reason));
        this.wanted = false;
        return;
      }
      // A frame neither end could parse is the same disagreement.
      if (ev.code === Close.MALFORMED) {
        this.setStatus(Status.Incompatible, closeMessage(ev.code, ev.reason));
        this.wanted = false;
        return;
      }
      // 4001 is "identify rejected"; retrying with the same token would busy-loop.
      if (ev.code === Close.IDENTIFY_EXPECTED || ev.code === Close.AUTH_FAILED) {
        this.setStatus(Status.Rejected, closeMessage(ev.code, ev.reason));
        this.wanted = false;
        return;
      }
      if (!this.wanted) { this.setStatus(Status.Closed); return; }
      // 4005 is a restart, not a failure: short window.
      if (ev.code === Close.RESTARTING) {
        this.restarting(closeMessage(ev.code, ev.reason));
        return;
      }
      // Capacity closes (4010, 4011, 4013) deliberately have no case: `fail`'s escalating backoff is the right load-shedding response; instant reconnects would cause a resync storm.
      this.fail(closeMessage(ev.code, ev.reason));
    };
  }

  /// `attempt` is neither reset nor advanced: a planned deploy shouldn't punish the client nor grant a fast retry.
  restarting(detail) {
    this.setStatus(Status.Degraded, detail);
    const wait = RESTART_RETRY_MIN + Math.random() * (RESTART_RETRY_MAX - RESTART_RETRY_MIN);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.wanted) this.connect(); }, wait);
  }

  fail(detail) {
    // A socket that never opened (throwing `new WebSocket`, bad DNS) skips `onclose`, so the clock starts here too.
    if (this.downSince == null) this.downSince = Date.now();
    this.attempt += 1;
    this.setStatus(Status.Degraded, detail);
    // Jittered, so a returning server doesn't get every client at once.
    const wait = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** (this.attempt - 1));
    const jittered = wait * (0.5 + Math.random() / 2);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.wanted) this.connect(); }, jittered);
  }

  onFrame(ev) {
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    switch (frame.op) {
      case 'HELLO':
        this.send({
          op: 'IDENTIFY',
          d: {
            token: this.token,
            intents: this.intents,
            // Per-connection presence; a reconnect must re-identify with the same answer.
            presence: this.presence,
            // Calls this device is still in; media survives the socket. Named by the session id minted at join.
            voice: this.manager.claimsFor(this.domain),
          },
        });
        break;
      case 'READY':
        this.attempt = 0;
        this.ready = true;
        // Clear the last failure so the next blip doesn't inherit the previous outage's sentence.
        this.lastCode = 0;
        this.lastReason = '';
        this.downSince = null;
        this.setStatus(Status.Ready);
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.send({ op: 'HEARTBEAT' }), HEARTBEAT_MS);
        for (const queued of this.queue.splice(0)) this.send(queued);
        for (const active of this.typing.values()) this.sendNow(active);
        this.manager.emit('ready', { domain: this.domain, data: frame });
        break;
      case 'HEARTBEAT_ACK':
        break;
      case 'INVALID_SESSION':
        // Said over an open socket, but the same failure as a 4004.
        this.lastCode = Close.AUTH_FAILED;
        this.lastReason = 'session invalid';
        if (this.downSince == null) this.downSince = Date.now();
        this.setStatus(Status.Rejected, 'session invalid');
        this.wanted = false;
        try { this.socket?.close(); } catch { /* already gone */ }
        break;
      case 'DISPATCH':
        this.manager.emit('dispatch', { domain: this.domain, t: frame.t, d: frame.d, s: frame.s });
        this.manager.emit(`e:${frame.t}`, { domain: this.domain, d: frame.d });
        break;
      default:
        break;
    }
  }

  send(frame) {
    const key = typingKey(frame);
    if (key) {
      if (isTypingStart(frame)) this.typing.set(key, frame);
      else this.typing.delete(key);
      return this.ready && this.sendNow(frame);
    }
    if (this.sendNow(frame)) return true;
    if (frame.op !== 'HEARTBEAT') this.queue.push(frame);
    return false;
  }

  sendNow(frame) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  close() {
    this.wanted = false;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.queue.length = 0;
    this.typing.clear();
    this.ready = false;
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* already gone */ }
    this.setStatus(Status.Closed);
  }
}

export class ConnectionManager extends Emitter {
  constructor() {
    super();
    this.connections = new Map();
    // Must outlive a Connection (`add` replaces the object).
    this.voiceClaims = new Map();
    this.staggerAt = 0;
    /// `add` stamps the role onto each connection.
    this.home = null;
    this.history = [];
  }

  /// Called once the store knows, and again after a migration.
  setHome(domain) {
    this.home = domain || null;
    for (const conn of this.connections.values()) {
      conn.role = conn.domain === this.home ? Role.Home : Role.Guild;
    }
  }

  /// Only the classification is kept: it is what goes into a public issue.
  note(failure) {
    if (!failure) return;
    const last = this.history[this.history.length - 1];
    // Backoff re-emits the same status; recording each would push out the transition that explains it.
    if (last && last.domain === failure.domain && last.kind === failure.kind
      && last.code === failure.code) return;
    this.history.push({
      at: Date.now(),
      domain: failure.domain,
      role: failure.role,
      kind: failure.kind,
      action: failure.action,
      code: failure.code ?? null,
    });
    if (this.history.length > FAILURE_HISTORY) this.history.shift();
  }

  failures() {
    const out = [];
    for (const conn of this.connections.values()) {
      const failure = conn.failure();
      if (failure) out.push(failure);
    }
    return out;
  }

  /// So every IDENTIFY to that server says so.
  claimVoice(domain, roomId, sessionId) {
    if (!domain || !roomId || !sessionId) return;
    this.voiceClaims.set(domain, { room_id: roomId, session_id: sessionId });
  }

  /// By room, not domain, so a stale claim can't outlive its call.
  releaseVoice(roomId) {
    for (const [domain, claim] of [...this.voiceClaims]) {
      if (!roomId || claim.room_id === roomId) this.voiceClaims.delete(domain);
    }
  }

  claimsFor(domain) {
    const claim = this.voiceClaims.get(domain);
    return claim ? [claim] : [];
  }

  /// Staggered so a resume from sleep doesn't open a dozen sockets at once. Nothing is cached: each server is told something different.
  add(spec) {
    this.connections.get(spec.domain)?.close();
    // Role is filled in here so an account-home outage can't read as a guild outage.
    const conn = new Connection(this, {
      ...spec,
      role: spec.role || (spec.domain === this.home ? Role.Home : Role.Guild),
    });
    this.connections.set(spec.domain, conn);
    const now = Date.now();
    const at = Math.min(Math.max(now, this.staggerAt), now + STAGGER_MAX_MS);
    this.staggerAt = at + STAGGER_MS;
    // Stagger runs on the connection's own timer so closing it cancels a pending connect; otherwise a replaced connection opens an orphan socket.
    conn.timer = setTimeout(() => conn.connect(), at - now);
    return conn;
  }

  remove(domain) {
    this.connections.get(domain)?.close();
    this.connections.delete(domain);
  }

  get(domain) { return this.connections.get(domain); }

  statusOf(domain) { return this.connections.get(domain)?.status || Status.Closed; }

  send(domain, frame) { return this.connections.get(domain)?.send(frame) ?? false; }

  broadcast(frame) {
    for (const conn of this.connections.values()) conn.send(frame);
  }

  /// There is no global presence, so the caller gives each domain one whole answer; kept because IDENTIFY after reconnect repeats it.
  setPresence(resolve) {
    for (const conn of this.connections.values()) {
      conn.presence = resolve(conn.domain);
      conn.send({ op: 'PRESENCE_UPDATE', d: conn.presence });
    }
  }

  typing(domain, channelId) {
    this.send(domain, { op: 'TYPING', d: { channel_id: channelId } });
  }

  stopTyping(domain, channelId) {
    this.send(domain, { op: 'TYPING_STOP', d: { channel_id: channelId } });
  }

  dmTyping(domain, conversationId, active) {
    this.send(domain, {
      op: active ? 'DM_TYPING_START' : 'DM_TYPING_STOP',
      d: { conversation_id: conversationId },
    });
  }

  subscribe(domain, guildId, ranges) {
    this.send(domain, { op: 'SUBSCRIBE', d: { guild_id: guildId, member_ranges: ranges } });
  }

  requestChannels(domain, guildId) {
    this.send(domain, { op: 'REQUEST_GUILD_CHANNELS', d: { guild_id: guildId } });
  }

  closeAll() {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.voiceClaims.clear();
  }

  /// A slept browser wakes with dead-looking-open sockets; nudge degraded ones on visibility change.
  wake() {
    for (const conn of this.connections.values()) {
      if (conn.wanted && !conn.socket) { conn.attempt = 0; conn.connect(); }
    }
  }
}
