import { Status } from '../gateway.js';
import * as perms from '../perms.js';
import { colourOf } from '../util.js';

export const MEMBER_WINDOW = 100;

export const guildMethods = {
  onReady({ domain, data }) {
    const d = data.d || {};
    this.cachedAt = null;
    const listed = new Set();
    for (const guild of d.guilds || []) {
      listed.add(guild.id);
      this.guilds.set(guild.id, { ...guild, domain });
      for (const ch of guild.channels || []) {
        this.channels.set(ch.id, { ...ch, guild_id: guild.id, domain });
      }
      // Replace rather than merge: a cached participant must not survive a call that ended while offline.
      for (const [channelId] of [...this.voice]) {
        if (this.channels.get(channelId)?.guild_id === guild.id) this.voice.delete(channelId);
      }
      for (const state of guild.voice_states || []) {
        if (!state.channel_id) continue;
        const list = this.voice.get(state.channel_id) || [];
        list.push(state);
        this.voice.set(state.channel_id, list);
      }
      this.loadReadState(guild.id).catch(() => {});
      if (guild.roles) this.roles.set(guild.id, new Map(guild.roles.map((r) => [r.id, r])));
      else this.loadRoles(guild.id).catch(() => {});
    }
    // A guild READY no longer names was left elsewhere; merging left a dead tile in the rail. Only this domain's guilds.
    for (const [id, guild] of [...this.guilds]) {
      if (guild.domain === domain && !listed.has(id)) this.dropGuild(id);
    }
    if (this.home && domain !== this.home.domain) {
      this.home.reportMemberships(domain, [...listed]).catch(() => {});
    }
    for (const guildId of [...this.memberWindows.keys()]) {
      const held = this.guilds.get(guildId);
      if (!held || held.domain === domain) this.memberWindows.delete(guildId);
    }
    this.ensureGuildMembers(this.route.guildId);
    this.emit('guilds');
    this.emit('roles');
    this.emit('voice');
    // A conversation's call never went through this socket; `voice_reclaimed` names the rooms IDENTIFY re-asserted.
    this.emit('voice-reclaim', { domain, rooms: new Set(d.voice_reclaimed || []) });
    // READY cannot settle a DM: frames are not replayed, and a hole is a hole in the MLS key schedule.
    this.resumeConversation(domain);
  },

  ensureGuildMembers(guildId) {
    return this.requestMemberWindow(guildId, 0);
  },

  requestMemberWindow(guildId, start = 0) {
    if (!guildId) return false;
    const guild = this.guilds.get(guildId);
    if (!guild) return false;
    if (this.gw.statusOf(guild.domain) !== Status.Ready) return false;
    const key = Math.floor(Math.max(0, start) / MEMBER_WINDOW);
    let asked = this.memberWindows.get(guildId);
    if (!asked) this.memberWindows.set(guildId, asked = new Set());
    if (asked.has(key)) return false;
    asked.add(key);
    this.gw.subscribe(guild.domain, guildId, [
      [key * MEMBER_WINDOW, key * MEMBER_WINDOW + MEMBER_WINDOW - 1],
    ]);
    return true;
  },

  async loadRoles(guildId, { force = false } = {}) {
    if (!force && this.roles.has(guildId)) return this.roles.get(guildId);
    const api = this.apiForGuild(guildId);
    if (!api) return new Map();
    const resp = await api.roles(guildId);
    const map = new Map((resp.roles || []).map((r) => [r.id, r]));
    this.roles.set(guildId, map);
    this.reapplyPending(`role:${guildId}:`);
    this.emit('roles', guildId);
    return map;
  },

  roleName(guildId, roleId) {
    return this.roles.get(guildId)?.get(roleId)?.name || roleId;
  },

  roleList(guildId, { includeEveryone = false } = {}) {
    const map = this.roles.get(guildId);
    if (!map) return [];
    const list = [...map.values()].sort((a, b) => (b.position || 0) - (a.position || 0));
    return includeEveryone ? list : list.filter((r) => r.id !== guildId);
  },

  // Affordances only: the server resolves permissions on every request.

  myMember(guildId) {
    return this.guilds.get(guildId)?.me || null;
  },

  guildPermissions(guildId) {
    return perms.toBits(this.myMember(guildId)?.permissions);
  },

  permissionsIn(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return 0n;
    const member = this.myMember(channel.guild_id);
    if (!member) return 0n;
    return perms.channelPermissions(member, channel.guild_id, channel.permission_overwrites || []);
  },

  can(channelId, name) { return perms.has(this.permissionsIn(channelId), name); },

  canInGuild(guildId, name) { return perms.has(this.guildPermissions(guildId), name); },

  colourFor(guildId, userId) {
    const member = this.members.get(guildId)?.get(userId);
    const ids = new Set(member?.roles || (userId === this.me?.user_id ? this.myMember(guildId)?.roles : []) || []);
    for (const role of this.roleList(guildId)) {
      if (ids.has(role.id) && role.color) return colourOf(role.color);
    }
    return null;
  },

  async refreshMe(guildId) {
    const api = this.apiForGuild(guildId);
    const guild = this.guilds.get(guildId);
    if (!api || !guild) return;
    try {
      const resp = await api.guild(guildId);
      const next = resp.guild || resp;
      this.guilds.set(guildId, { ...guild, ...next, domain: guild.domain });
      if (next.roles) this.roles.set(guildId, new Map(next.roles.map((r) => [r.id, r])));
      this.reapplyPending(`role:${guildId}:`);
      this.emit('roles', guildId);
      this.emit('guilds');
    } catch {}
  },

  async loadExpressionData(guildId, { force = false } = {}) {
    if (!force && this.expressionData.has(guildId)) return this.expressionData.get(guildId);
    const running = this.expressionLoads.get(guildId);
    if (running) return running;
    const api = this.apiForGuild(guildId);
    if (!api) return { emojis: [], stickers: [] };
    const load = api.expressions(guildId)
      .then((resp) => ({ emojis: resp.emojis || [], stickers: resp.stickers || [] }))
      .catch(() => ({ emojis: [], stickers: [] }))
      .then((data) => {
        this.expressionData.set(guildId, data);
        this.emojis.set(guildId, data.emojis);
        this.stickers.set(guildId, data.stickers);
        this.emit('expressions', guildId);
        return data;
      })
      .finally(() => {
        if (this.expressionLoads.get(guildId) === load) this.expressionLoads.delete(guildId);
      });
    this.expressionLoads.set(guildId, load);
    return load;
  },

  async loadExpressions(guildId, opts = {}) {
    return (await this.loadExpressionData(guildId, opts)).emojis;
  },

  async loadReadState(guildId) {
    const api = this.apiForGuild(guildId);
    if (!api) return;
    const resp = await api.readState(guildId);
    for (const row of resp.channels || []) {
      this.readState.set(row.channel_id, row);
    }
    this.emit('unread', guildId);
  },
};
