// Optimistic writes, latest wins; a refusal restores the last accepted value unless overtaken.

import { PERMISSION_MASKS } from '../perms.js';

const SKIPPED = Symbol('skipped');

export function roleWith(role, body) {
  const next = { ...role, ...body };
  if (body.permissions) {
    next.permission_names = body.permissions;
    next.permissions = String(body.permissions
      .reduce((bits, name) => bits | (PERMISSION_MASKS.get(name) || 0n), 0n));
  }
  return next;
}

export const permissionMethods = {
  async writeNow(key, value, { read, put, send, settle, emit }) {
    let rec = this.permWrites.get(key);
    if (!rec) {
      rec = { seq: 0, base: read(), value, put, tail: Promise.resolve() };
      this.permWrites.set(key, rec);
    }
    const seq = ++rec.seq;
    rec.value = value;
    put(value);
    emit();

    const turn = rec.tail.then(() => (rec.seq === seq ? send(value) : SKIPPED));
    rec.tail = turn.catch(() => {});
    let saved;
    try {
      saved = await turn;
    } catch (e) {
      if (rec.seq !== seq) return null;
      this.permWrites.delete(key);
      put(rec.base);
      emit();
      throw e;
    }
    if (saved === SKIPPED) return null;
    if (rec.seq !== seq) {
      rec.base = value;
      return null;
    }
    this.permWrites.delete(key);
    settle(saved);
    emit();
    return saved;
  },

  reapplyPending(prefix) {
    for (const [key, rec] of this.permWrites) {
      if (key.startsWith(prefix)) rec.put(rec.value);
    }
  },

  setOverwriteNow(channelId, targetType, targetId, allow, deny, api = this.apiForChannel(channelId)) {
    const guildId = this.channels.get(channelId)?.guild_id;
    const find = () => (this.channels.get(channelId)?.permission_overwrites || [])
      .find((o) => o.target_type === targetType && o.target_id === targetId) || null;
    const put = (overwrite) => {
      const channel = this.channels.get(channelId);
      if (!channel) return;
      const rest = (channel.permission_overwrites || [])
        .filter((o) => !(o.target_type === targetType && o.target_id === targetId));
      this.channels.set(channelId, {
        ...channel,
        permission_overwrites: overwrite ? [...rest, overwrite] : rest,
      });
    };
    const value = {
      target_type: targetType, target_id: targetId, allow: String(allow), deny: String(deny),
    };
    return this.writeNow(`ow:${channelId}:${targetType}:${targetId}`, value, {
      read: find,
      put,
      send: () => api.setOverwrite(channelId, targetType, targetId, allow, deny),
      settle: (saved) => {
        const channel = this.channels.get(channelId);
        if (channel && saved?.id === channelId) {
          this.channels.set(channelId, { ...channel, ...saved, guild_id: channel.guild_id, domain: channel.domain });
          this.reapplyPending(`ow:${channelId}:`);
        }
      },
      emit: () => this.emit('channels', guildId),
    });
  },

  patchRoleNow(guildId, roleId, body, api = this.apiForGuild(guildId)) {
    const read = () => this.roles.get(guildId)?.get(roleId) || null;
    const put = (role) => {
      const map = this.roles.get(guildId);
      if (!map || !role) return;
      this.roles.set(guildId, new Map(map).set(roleId, role));
    };
    return this.writeNow(`role:${guildId}:${roleId}`, roleWith(read(), body), {
      read,
      put,
      send: () => api.patchRole(guildId, roleId, body),
      settle: (saved) => { if (saved?.id === roleId) put(saved); },
      emit: () => this.emit('roles', guildId),
    });
  },
  /// The server's member replaces the guess like MEMBER_UPDATE; a card opened from a mention may never hear that event.
  setMemberRoleNow(guildId, userId, roleId, on, api = this.apiForGuild(guildId)) {
    const row = () => this.members.get(guildId)?.get(userId);
    const put = (held) => {
      const member = row();
      if (!member) return;
      const rest = (member.roles || []).filter((id) => id !== roleId);
      this.members.get(guildId).set(userId, { ...member, roles: held ? [...rest, roleId] : rest });
    };
    return this.writeNow(`mr:${guildId}:${userId}:${roleId}`, on, {
      read: () => row()?.roles?.includes(roleId) ?? !on,
      put,
      send: (held) => api.patchMember(guildId, userId, { [held ? 'add_roles' : 'remove_roles']: [roleId] }),
      settle: (saved) => { if (saved) this.onMember({ ...saved, guild_id: guildId, user_id: userId }); },
      emit: () => this.emit('members', guildId),
    });
  },
};
