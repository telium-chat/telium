export const RING_MS = 30_000;

export const CALL_LOG_MAX = 50;

export const CALL_KINDS = ['incoming', 'outgoing', 'missed', 'ended'];

export const callMethods = {
  hydrateVoice(roomId, states) {
    if (!roomId) return;
    this.voice.set(roomId, Array.isArray(states) ? states : []);
    this.emit('voice', roomId);
  },

  noteCall(d, before, after) {
    const conversationId = d?.conversation_id;
    if (!conversationId) return;

    // An echo of our own outgoing seat must not open the call clock.
    if (d.user_id && d.user_id === this.me?.user_id) {
      if (d.channel_id && !d.left) {
        if (this.ringing.has(conversationId)) this.stopRing(conversationId, 'answered');
        this.noteJoined(conversationId, d.user_id, before);
      } else if (!d.channel_id || d.left) {
        this.noteLeft(conversationId, d.user_id, after);
      }
      return;
    }

    if (after === 0) {
      this.declinedCalls.delete(conversationId);
      this.stopRing(conversationId, 'ended');
      this.noteLeft(conversationId, d.user_id, after);
      return;
    }

    if (before > 0) {
      this.noteJoined(conversationId, d.user_id, before);
      return;
    }
    if (this.declinedCalls.has(conversationId)) return;
    if (this.ringing.has(conversationId)) return;
    this.logCall(conversationId, { kind: 'incoming', from: d.user_id, at: Date.now() });
    if (this.isMuted?.(conversationId)) return;
    if ((this.prefs?.presence || 'online') === 'dnd') return;

    const ring = { conversationId, from: d.user_id, at: Date.now() };
    this.ringing.set(conversationId, ring);
    this.ringTimers.set(conversationId, setTimeout(
      () => this.stopRing(conversationId, 'missed'),
      RING_MS,
    ));
    this.emit('ring', { ...ring, ringing: true });
  },

  noteJoined(conversationId, userId, before) {
    if (!conversationId) return;
    const me = this.me?.user_id;
    // onVoice writes the roster first, so an echo of our own seat finds nobody else.
    const others = (this.voice.get(conversationId) || [])
      .filter((v) => v.user_id !== me).length;
    if (userId === me) {
      if (before === 0 && !this.outgoingCalls.has(conversationId)) {
        const at = Date.now();
        this.outgoingCalls.set(conversationId, { conversationId, at });
        this.logCall(conversationId, { kind: 'outgoing', from: me, at });
        this.emit('call-log', conversationId);
      } else if (others > 0) {
        this.callConnected.add(conversationId);
        if (!this.callStartedAt.has(conversationId)) {
          this.callStartedAt.set(conversationId, Date.now());
        }
      }
      return;
    }
    if (this.outgoingCalls.has(conversationId)) {
      this.outgoingCalls.delete(conversationId);
      this.callConnected.add(conversationId);
      this.callStartedAt.set(conversationId, Date.now());
      this.emit('call-log', conversationId);
    } else if (before > 0 && !this.callConnected.has(conversationId)) {
      this.callConnected.add(conversationId);
      this.callStartedAt.set(conversationId, Date.now());
    }
  },

  noteLeft(conversationId, userId, after) {
    if (!conversationId) return;
    if (after !== 0) return;
    this.outgoingCalls.delete(conversationId);
    const connected = this.callConnected.has(conversationId);
    const startedAt = this.callStartedAt.get(conversationId);
    this.callConnected.delete(conversationId);
    this.callStartedAt.delete(conversationId);
    if (connected && startedAt) {
      const at = Date.now();
      this.logCall(conversationId, {
        kind: 'ended',
        from: userId || this.me?.user_id || null,
        at,
        durationMs: Math.max(0, at - startedAt),
      });
    } else {
      this.markUnanswered(conversationId);
    }
    this.emit('call-log', conversationId);
  },

  logCall(conversationId, { kind, from = null, at = Date.now(), durationMs = null } = {}) {
    if (!conversationId || !CALL_KINDS.includes(kind)) return null;
    const list = this.callLogs.get(conversationId) || [];
    const entry = {
      id: `call-${at.toString(36)}-${list.length.toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`,
      conversationId,
      kind,
      from,
      at,
      endedAt: kind === 'ended' ? at : null,
      durationMs,
    };
    list.push(entry);
    while (list.length > CALL_LOG_MAX) list.shift();
    this.callLogs.set(conversationId, list);
    this.emit('call-log', conversationId);
    return entry;
  },

  markUnanswered(conversationId) {
    const list = this.callLogs.get(conversationId);
    if (!list?.length) return;
    const last = list[list.length - 1];
    if (last.kind === 'incoming' || last.kind === 'outgoing') {
      last.kind = 'missed';
      this.emit('call-log', conversationId);
    }
  },

  stopRing(conversationId, reason = 'ended') {
    clearTimeout(this.ringTimers.get(conversationId));
    this.ringTimers.delete(conversationId);
    if (!this.ringing.has(conversationId)) return;
    const ring = this.ringing.get(conversationId);
    this.ringing.delete(conversationId);
    if (reason === 'missed') this.markUnanswered(conversationId);
    else if (reason === 'answered') {
      this.callConnected.add(conversationId);
      if (!this.callStartedAt.has(conversationId)) {
        this.callStartedAt.set(conversationId, Date.now());
      }
    }
    this.emit('ring', { ...ring, ringing: false, reason });
  },

  declineCall(conversationId) {
    this.declinedCalls.add(conversationId);
    this.markUnanswered(conversationId);
    this.stopRing(conversationId, 'declined');
  },

  clearRings() {
    for (const id of [...this.ringing.keys()]) this.stopRing(id, 'ended');
    this.declinedCalls.clear();
    this.outgoingCalls.clear();
    this.callStartedAt.clear();
    this.callConnected.clear();
  },
};
