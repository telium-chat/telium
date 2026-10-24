import { debounce } from '../util.js';

const SIGNAL_IDLE = 4000;

export const signalMethods = {
  /// Off until turned on; read state is more intimate than a presence dot.
  readReceiptsIn(conversationId) {
    return this.signalFor('read', conversationId, false);
  },

  /// On by default: "a device of mine has this" is close to what servers infer. Reciprocal.
  deliveryAcksIn(conversationId) {
    return this.signalFor('delivered', conversationId, true);
  },

  typingSignalsIn(conversationId) {
    return this.signalFor('typing', conversationId, true);
  },

  signalFor(kind, conversationId, fallback) {
    const signals = this.prefs.signals || {};
    const override = signals.conversations?.[conversationId]?.[kind];
    if (override !== undefined) return override;
    return signals[kind] === undefined ? fallback : signals[kind];
  },

  setSignal(kind, value, conversationId = null) {
    if (!this.prefs.signals) this.prefs.signals = {};
    const signals = this.prefs.signals;
    if (!conversationId) {
      signals[kind] = value;
    } else {
      if (!signals.conversations) signals.conversations = {};
      const per = { ...signals.conversations[conversationId] };
      if (value === null) delete per[kind];
      else per[kind] = value;
      if (Object.keys(per).length) signals.conversations[conversationId] = per;
      else delete signals.conversations[conversationId];
    }
    this.savePrefs();
  },

  callPrivacyFor(conversationId) {
    const value = this.signalFor('call', conversationId, 'direct');
    return ['direct', 'relay', 'sfu'].includes(value) ? value : 'direct';
  },

  setCallPrivacy(value, conversationId = null) {
    this.setSignal('call', value, conversationId);
  },

  callCaps() {
    const doc = this.caps.get(this.session?.home?.domain);
    return {
      relay: false, sfu: false, mesh_max_participants: 4, ...(doc?.calls || {}),
    };
  },

  async setCallSfu(conversationId, endpoint) {
    if (!this.mls) throw new Error('Encryption is not ready on this device yet.');
    await this.mls.setCallSfu(conversationId, endpoint);
    this.emit('dm', { conversation_id: conversationId });
  },

  callSfuIn(conversationId) {
    return this.mls?.callSfuIn(conversationId) || null;
  },

  /// Signals are excluded: a watermark pointing at a receipt would claim later messages were read.
  lastReadable(conversationId) {
    const frames = this.dmFrames.get(conversationId) || [];
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i];
      if (frame.kind === 'application' && !this.mls?.isSignal(frame.id)) return frame.id;
    }
    return null;
  },

  /// Only the watermark moves; the flush sends, keeping a backlog scroll to one frame.
  markConversationRead(conversationId) {
    if (!this.mls) return;
    const last = this.lastReadable(conversationId);
    if (!last) return;
    this.mls.noteRead(conversationId, last);
    this.scheduleSignals(conversationId);
  },

  scheduleSignals(conversationId) {
    if (!this.signalFlushes.has(conversationId)) {
      this.signalFlushes.set(conversationId, debounce(
        () => this.mls?.flushSignals(conversationId).catch(() => {}),
        SIGNAL_IDLE,
      ));
    }
    this.signalFlushes.get(conversationId)();
  },

  async closeConversation(conversationId) {
    if (!this.mls) return;
    this.markConversationRead(conversationId);
    await this.mls.flushSignals(conversationId).catch(() => {});
  },

  notifyTyping(conversationId) {
    if (!this.home || !this.typingSignalsIn(conversationId)
      || this.prefs.typing === false || this.typedAt.has(conversationId)) return;
    this.typedAt.set(conversationId, true);
    this.gw.dmTyping(this.session?.home?.domain, conversationId, true);
  },

  notifyTypingStop(conversationId) {
    if (!this.home || !this.typedAt.has(conversationId)) return;
    this.typedAt.delete(conversationId);
    this.gw.dmTyping(this.session?.home?.domain, conversationId, false);
  },
};
