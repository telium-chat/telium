import { MAX_CUSTOM_STATUS } from '../gateway.js';
import { normalizeLookups } from '../mutual-lookups.js';
import { normalizeNetworkPrefs } from '../net/policy.js';
import { KEYS, draftText } from '../sync.js';
import { storage } from '../util.js';
import { LOCAL_DM_DRAFTS_KEY } from './shared.js';

/// The longest a `setTimeout` can wait before its delay overflows and fires at once.
const MAX_TIMEOUT_MS = 2_147_483_647;

const MAX_RECENT = 50;

export const prefsMethods = {
  savePrefs() { this.sync.set(KEYS.prefs, this.prefs); this.emit('prefs'); },

  /// A mute is a deadline; `true` means forever.
  isMuted(id) {
    const until = this.prefs?.muted?.[id];
    if (!until) return false;
    return until === true || until > Date.now();
  },

  setMuted(id, until) {
    if (until) this.prefs.muted[id] = until;
    else delete this.prefs.muted[id];
    this.savePrefs();
    this.emit('unread');
    this.scheduleMuteSweep();
  },

  scheduleMuteSweep() {
    clearTimeout(this.muteSweep);
    this.muteSweep = null;
    const now = Date.now();
    let soonest = Infinity;
    for (const until of Object.values(this.prefs?.muted || {})) {
      if (typeof until === 'number' && until > now && until < soonest) soonest = until;
    }
    if (soonest === Infinity) return;
    // Waits over ~24.8 days overflow setTimeout, so long waits run in chunks.
    const wait = Math.min(soonest - now, MAX_TIMEOUT_MS);
    this.muteSweep = setTimeout(() => { this.muteSweep = null; this.sweepMutes(); }, wait + 50);
  },

  sweepMutes() {
    const now = Date.now();
    let lifted = false;
    for (const [id, until] of Object.entries(this.prefs?.muted || {})) {
      if (typeof until === 'number' && until <= now) { delete this.prefs.muted[id]; lifted = true; }
    }
    if (lifted) { this.savePrefs(); this.emit('unread'); }
    this.scheduleMuteSweep();
  },

  draftFor(target) {
    return draftText(this.sync.get(KEYS.drafts), target);
  },

  saveDraft(target, text) {
    const drafts = { ...(this.sync.get(KEYS.drafts) || {}) };
    const value = String(text || '');
    if (!value && !drafts[target]?.text) return;
    drafts[target] = { text: value, at: Date.now() };
    this.sync.set(KEYS.drafts, drafts);
    this.emit('drafts', target);
  },

  adoptLocalDmDrafts() {
    const userId = this.session?.home?.user_id;
    if (!userId) return;
    const all = storage.get(LOCAL_DM_DRAFTS_KEY, {});
    const mine = all?.[userId];
    if (!mine || typeof mine !== 'object') return;
    const drafts = { ...(this.sync.get(KEYS.drafts) || {}) };
    for (const [id, text] of Object.entries(mine)) {
      const target = `conversation:${id}`;
      if (typeof text === 'string' && text && !drafts[target]) drafts[target] = { text, at: 0 };
    }
    this.sync.set(KEYS.drafts, drafts);
    delete all[userId];
    storage.set(LOCAL_DM_DRAFTS_KEY, all);
  },

  presenceFor(domain) {
    const detail = this.sharesStatus(domain);
    const custom = this.prefs.status || {};
    return {
      status: this.prefs.presence || 'online',
      custom_status: detail ? (custom.text || null) : null,
      show_custom_status_offline: detail ? !!this.prefs.showCustomStatusOffline : false,
    };
  },

  sharesStatus(domain) {
    // Older key names said `activity`; read both.
    if ((this.prefs.shareStatus ?? this.prefs.shareActivity) === false) return false;
    const hidden = this.prefs.statusHidden || this.prefs.activityHidden || {};
    for (const guild of this.guilds.values()) {
      if (guild.domain === domain && hidden[guild.id]) return false;
    }
    return true;
  },

  /// Normalised: `prefs.network` may come from a newer build with an unknown mode.
  networkPrefs() {
    return normalizeNetworkPrefs(this.prefs.network);
  },

  writeNetworkPrefs(patch) {
    this.prefs.network = normalizeNetworkPrefs({ ...this.networkPrefs(), ...patch });
    this.savePrefs();
    this.emit('network-privacy', this.prefs.network);
    return this.prefs.network;
  },

  setNetworkMode(mode) {
    return this.writeNetworkPrefs({ mode });
  },

  setGuildNetworkMode(guildId, mode) {
    if (!guildId) return this.networkPrefs();
    const guilds = { ...this.networkPrefs().guilds };
    if (mode) guilds[guildId] = mode;
    else delete guilds[guildId];
    return this.writeNetworkPrefs({ guilds });
  },

  setNetworkAutoFallback(on) {
    return this.writeNetworkPrefs({ autoFallback: on === true });
  },

  /// Normalised on the way out so an unreadable value is never read as permission to fan out.
  mutualLookups() {
    return normalizeLookups(this.prefs.lookups);
  },

  /// Answers already held are kept when lookups are turned off: the requests cannot be unsent.
  setMutualLookups(value) {
    this.prefs.lookups = normalizeLookups(value);
    this.savePrefs();
    return this.prefs.lookups;
  },

  setCustomStatus(text) {
    this.setPresence({ text: (text || '').trim().slice(0, MAX_CUSTOM_STATUS) });
  },

  setShowCustomStatusOffline(on) {
    this.setPresence({ showOffline: !!on });
  },

  setPresence(patch = {}) {
    if (patch.status !== undefined) this.prefs.presence = patch.status;
    if (patch.text !== undefined) {
      this.prefs.status = { text: (patch.text ?? this.prefs.status?.text ?? '').slice(0, 128) };
    }
    if (patch.share !== undefined) this.prefs.shareStatus = patch.share;
    if (patch.showOffline !== undefined) this.prefs.showCustomStatusOffline = !!patch.showOffline;
    if (patch.guild) {
      const hidden = { ...(this.prefs.statusHidden || this.prefs.activityHidden || {}) };
      if (patch.hide) hidden[patch.guild] = true;
      else delete hidden[patch.guild];
      this.prefs.statusHidden = hidden;
    }
    this.savePrefs();
    this.gw.setPresence((domain) => this.presenceFor(domain));

    // Drawn here so a do-not-disturb click doesn't read as doing nothing.
    const mine = this.me?.user_id;
    if (mine) {
      // Permissive view merged onto the existing entry so the now-playing card isn't blanked.
      const local = {
        ...(this.presence.get(mine) || {}),
        user_id: mine,
        status: this.prefs.presence || 'online',
        custom_status: this.prefs.status?.text || null,
      };
      this.presence.set(mine, local);
      this.emit('presence', local);
    }
  },

  recentSurfaces() {
    const list = this.prefs.recent;
    return Array.isArray(list) ? list : [];
  },

  /// Writes only when changed: each write re-seals the whole prefs blob.
  noteVisit(id) {
    if (!id || !this.signedIn) return;
    const list = this.recentSurfaces();
    if (list[0] === id) return;
    this.prefs.recent = [id, ...list.filter((seen) => seen !== id)].slice(0, MAX_RECENT);
    this.savePrefs();
  },

  pinnedIds(channelId, conversationId) {
    if (conversationId) {
      return (this.mls?.pinsIn?.(conversationId) || []).map((pin) => pin.id);
    }
    return [...(this.channelPins.get(channelId) || [])];
  },

  unseenPinCount(channelId, conversationId) {
    const roomId = conversationId || channelId;
    if (!roomId) return 0;
    const held = this.pinsSeenIn(roomId);
    return this.pinnedIds(channelId, conversationId).filter((id) => !held.has(id)).length;
  },

  pinsSeenIn(roomId) {
    const seen = this.prefs?.pinsSeen?.[roomId];
    return new Set(Array.isArray(seen) ? seen : []);
  },

  /// Replaced rather than appended: ids of pins taken back while unseen would count forever.
  markPinsSeen(channelId, conversationId) {
    const roomId = conversationId || channelId;
    if (!roomId) return;
    const ids = this.pinnedIds(channelId, conversationId);
    const seen = this.prefs?.pinsSeen?.[roomId];
    const held = Array.isArray(seen) ? seen : [];
    if (held.length === ids.length && ids.every((id) => held.includes(id))) return;
    this.prefs.pinsSeen = { ...(this.prefs.pinsSeen || {}), [roomId]: ids };
    this.savePrefs();
  },
};
