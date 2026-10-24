import { normalizeRail } from '../rail.js';

const PIN_NOTICE_MAX = 200;

export const timelineMethods = {
  async loadHistory(channelId, { before } = {}) {
    const api = this.apiForChannel(channelId);
    if (!api) return [];
    const resp = await api.history(channelId, { before, limit: 50 });
    const batch = resp.messages || [];
    const existing = this.messages.get(channelId) || [];
    if (before) {
      const ids = new Set(existing.map((m) => m.id));
      this.messages.set(channelId, [...batch.filter((m) => !ids.has(m.id)), ...existing]);
    } else if (batch.length && existing.length) {
      // A tail refresh can race a jump paging older messages; refresh only the returned id window.
      const first = batch[0].id;
      const last = batch[batch.length - 1].id;
      const older = existing.filter((m) => m.id < first);
      const newer = existing.filter((m) => m.id > last);
      this.messages.set(channelId, [...older, ...batch, ...newer]);
    } else {
      this.messages.set(channelId, batch);
    }
    // A short page means the hot store ran out, not the channel: older history is in cold segments.
    const oldest = (this.messages.get(channelId) || [])[0]?.id;
    let more = batch.length >= 50 || !!resp.archived;
    if (!more && oldest) more = await this.hasColdBefore(channelId, oldest);
    this.hasMore.set(channelId, more);
    this.emit('history', { channelId, archived: !!resp.archived });
    return batch;
  },

  /// Entry written before the request so a pin landing in flight joins the same set; the answer is merged.
  async loadChannelPins(channelId) {
    if (this.channelPins.has(channelId)) return;
    const api = this.apiForChannel(channelId);
    if (!api) return;
    const held = new Set();
    this.channelPins.set(channelId, held);
    try {
      const resp = await api.pins(channelId);
      for (const m of resp?.pins || resp?.messages || []) held.add(m.id);
      this.emit('pins', channelId);
    } catch {
      this.channelPins.delete(channelId);
    }
  },

  /// The channel frame carries no author, so `by` is only set where the conversation fold knows it.
  notePinNotice(roomId, messageId, by = null) {
    if (!roomId || !messageId) return;
    const held = this.pinNotices.get(roomId) || [];
    if (held.some((n) => n.messageId === messageId)) return;
    const entry = {
      id: `pin:${messageId}`, kind: 'pin', messageId, by, created_at: Date.now(),
    };
    this.pinNotices.set(roomId, [...held, entry].slice(-PIN_NOTICE_MAX));
    this.emit('pin-notice', roomId);
  },

  pinNoticesIn(roomId) {
    return this.pinNotices.get(roomId) || [];
  },

  /// ULIDs: once the oldest held message is older than the target, it was deleted, not distant.
  async loadUntil(channelId, messageId, { pages = 20 } = {}) {
    const held = () => (this.messages.get(channelId) || []).some((m) => m.id === messageId);
    if (!this.messages.has(channelId)) await this.loadHistory(channelId);
    for (let page = 0; page < pages && !held(); page += 1) {
      const current = this.messages.get(channelId) || [];
      if (!current.length || current[0].id < messageId) break;
      if (!this.hasMore.get(channelId)) break;
      await this.loadHistory(channelId, { before: current[0].id });
    }
    return held();
  },

  jumpTo(surfaceId, messageId) {
    const channel = this.channels.get(surfaceId);
    const convo = channel ? null : this.conversations.find((c) => c.id === surfaceId);
    // A conversation opened from a link can be drawn before the list has arrived.
    const open = channel
      ? this.route.view === 'chat' && this.route.channelId === surfaceId
      : this.route.view === 'dms' && this.route.conversationId === surfaceId;
    if (!channel && !convo && !open) return false;
    this.pendingJump = { channelId: surfaceId, messageId };
    // Navigate unless already there: a stale id on the route must not block the switch.
    if (channel) {
      if (this.route.view !== 'chat' || this.route.channelId !== surfaceId) {
        this.navigate({ view: 'chat', guildId: channel.guild_id, channelId: surfaceId });
      }
    } else if (this.route.view !== 'dms' || this.route.conversationId !== surfaceId) {
      this.navigate({ view: 'dms', conversationId: surfaceId });
    }
    this.emit('jump', { channelId: surfaceId, messageId });
    return true;
  },

  /// The request outlives its event: the component that carries it out is still mounting.
  takeJump(channelId) {
    if (this.pendingJump?.channelId !== channelId) return null;
    const jump = this.pendingJump;
    this.pendingJump = null;
    return jump;
  },

  async hasColdBefore(channelId, id) {
    if (!this.coldSegments.has(channelId)) {
      const api = this.apiForChannel(channelId);
      if (!api) return false;
      try {
        const resp = await api.segments(channelId);
        this.coldSegments.set(channelId, resp.segments || []);
      } catch { this.coldSegments.set(channelId, []); }
    }
    return (this.coldSegments.get(channelId) || []).some((s) => String(s.first_id) < String(id));
  },

  async ack(channelId) {
    const list = this.messages.get(channelId) || [];
    const last = list[list.length - 1];
    if (!last) return;
    const api = this.apiForChannel(channelId);
    if (!api) return;
    try {
      await api.ack(channelId, last.id);
      this.readState.set(channelId, { channel_id: channelId, last_read_id: last.id, unread: 0, mentions: 0 });
      this.emit('unread', this.channels.get(channelId)?.guild_id);
    } catch {}
  },

  openTimeline(channelId) { this.reading = channelId; },

  closeTimeline(channelId) { if (this.reading === channelId) this.reading = null; },

  unreadFor(channelId) { return this.readState.get(channelId) || { unread: 0, mentions: 0 }; },

  dmUnreadFor(conversationId) { return this.dmUnread.get(conversationId) || 0; },

  /// Summed over conversations, not the counter map: orphan counts (no row) have nothing to open.
  dmUnreadTotal() {
    let total = 0;
    for (const convo of this.conversations) total += this.dmUnread.get(convo.id) || 0;
    return total;
  },

  railNodes() {
    return normalizeRail(this.prefs.rail, [...this.guilds.values()]);
  },

  setRail(nodes) {
    this.prefs.rail = nodes;
    this.savePrefs();
  },

  guildUnread(guildId) {
    let unread = 0; let mentions = 0;
    for (const ch of this.channels.values()) {
      if (ch.guild_id !== guildId) continue;
      if (this.isMuted(ch.id)) continue;
      const state = this.unreadFor(ch.id);
      unread += state.unread || 0;
      mentions += state.mentions || 0;
    }
    return { unread, mentions };
  },

  channelsOf(guildId) {
    return [...this.channels.values()]
      .filter((c) => c.guild_id === guildId && c.type !== 'thread')
      .sort((a, b) => (a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name));
  },
};
