// Resolves which face to draw for a person and where to fetch it from. Builds no URLs; `Avatar` does.

import { remoteMediaOrigin } from './media.js';

function pick(sources, field) {
  for (const source of sources) {
    const value = source?.[field];
    if (value) return value;
  }
  return null;
}

function memberAnywhere(store, userId) {
  for (const roster of store.members?.values() || []) {
    const member = roster.get(userId);
    if (member?.avatar_ref) return member;
  }
  return null;
}

/// `name` is the account's own display name, never a guild nickname. Pass `guildId` to draw someone as a member of that guild.
export function faceOf(store, userId, { guildId = null } = {}) {
  if (!userId) return null;

  const isMe = userId === store.me?.user_id;
  const member = guildId ? store.members?.get(guildId)?.get(userId) : null;
  const friend = store.friends?.get(userId);
  const peer = store.peerProfile?.(userId);
  const identity = store.identityOf?.(userId);
  const profile = identity && typeof identity === 'object' ? identity : null;

  // Inside a guild, that guild's copy leads. Outside one, the home server's answer leads and a cached member row is the fallback.
  const ordered = guildId
    ? [member, friend, peer, profile]
    : [friend, peer, profile, isMe ? null : memberAnywhere(store, userId)];

  const avatarRef = pick(ordered, 'avatar_ref');
  const name = pick([friend, peer, profile, member], 'display_name');

  if (!avatarRef) return { id: userId, name, avatarRef: null, base: null, mediaOrigin: null };

  // The server that handed us the reference is the one asked for it. `remoteMediaOrigin` is already null for your own domain.
  const viaGuild = Boolean(guildId && member?.avatar_ref);
  const api = viaGuild ? store.apiForGuild?.(guildId) : null;
  const base = viaGuild ? (api?.base || store.home?.base) : store.home?.base;
  const localDomain = viaGuild
    ? (store.guilds?.get(guildId)?.domain || api?.domain)
    : store.home?.domain;

  return {
    id: userId,
    name,
    avatarRef,
    base: base || null,
    mediaOrigin: remoteMediaOrigin(userId, localDomain),
  };
}

export function roomFace(store, userId, { guildId, guildBase, guildDomain, state = null }) {
  const face = faceOf(store, userId, { guildId });
  const carried = state?.avatar_ref || null;
  return {
    name: face?.name || null,
    mediaRef: face?.avatarRef || carried,
    base: face?.avatarRef ? face.base : (carried ? guildBase : null),
    mediaOrigin: face?.avatarRef
      ? face.mediaOrigin
      : (carried ? remoteMediaOrigin(userId, guildDomain) : null),
  };
}
