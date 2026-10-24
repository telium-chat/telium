import { useEffect, useState } from 'react';
import { useStore, useStoreEvent, useStoreEventFor } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { faceOf } from '../../lib/faces.js';
import { remoteMediaOrigin } from '../../lib/media.js';
import { isBotAccount } from '../../components/BotBadge.jsx';
import { has } from '../../lib/perms.js';
import { colourOf, domainOf, shortName, themeOf, tint } from '../../lib/util.js';

function readVerification(store, userId, guildId) {
  const trust = store?.trust;
  if (!trust || !userId) return null;
  if (isBotAccount(store, userId, guildId)) return null;
  const peer = trust.peers.get(userId);
  const ids = [...(peer?.devices?.keys() || [])];
  const status = ids.length
    ? trust.statusFor(userId, ids[0], null)
    : (trust.signed.has(userId) ? 'verified' : 'unverified');
  return {
    key: !!peer?.identityKey,
    devices: ids.length,
    signedAt: trust.signed.get(userId)?.signed_at || null,
    status,
    request: status === 'verified' ? null : trust.requestFor(userId),
  };
}

export function useProfileTarget(guildId, userId) {
  const store = useStore();
  useStoreEventFor((e) => e?.user_id === userId, 'identity', 'presence', 'peers');
  useStoreEvent('friends', 'me', 'conversations', 'voice', 'channels', 'roles', 'guilds');

  const member = store.members.get(guildId)?.get(userId);
  const guild = store.guilds.get(guildId);
  const api = store.apiForGuild(guildId);
  const live = store.presence.get(userId) || {};
  const domain = domainOf(userId);
  const isMe = userId === store.me?.user_id;
  const guest = Boolean(domain && store.home?.domain && domain !== store.home.domain);

  const identity = store.identityOf(userId);
  const peer = store.peerProfile(userId);
  const accountName = member?.display_name || identity?.display_name || peer?.display_name || '';
  const displayName = member?.nickname || accountName || shortName(userId);
  const alias = member?.nickname && accountName && member.nickname !== accountName
    ? accountName
    : null;
  const face = faceOf(store, userId, { guildId });
  const avatarRef = face?.avatarRef || null;
  const accent = colourOf(identity?.accent_color) || tint(userId);
  const theme = themeOf(identity?.theme_colors);
  const bannerRef = identity?.banner_ref || null;
  const mediaBase = face?.base || api?.base || store.home?.base;
  const mediaOrigin = face?.avatarRef
    ? face.mediaOrigin
    : remoteMediaOrigin(userId, api?.domain || store.home?.domain);

  const [held, setHeld] = useState(member?.roles || []);
  const roles = held.filter((id) => id !== guildId);
  const [roleBusy, setRoleBusy] = useState(null);
  const [verification, setVerification] = useState(() => readVerification(store, userId, guildId));
  const [shownFor, setShownFor] = useState(userId);
  if (shownFor !== userId) {
    setShownFor(userId);
    setVerification(readVerification(store, userId, guildId));
  }

  useEffect(
    () => store.on('verify', () => setVerification(readVerification(store, userId, guildId))),
    [store, userId, guildId],
  );

  useEffect(() => {
    let alive = true;
    store.ensureFullProfile(userId);
    if (guildId) {
      store.loadRoles(guildId)
        .then(() => { if (alive) setHeld([...(store.members.get(guildId)?.get(userId)?.roles || [])]); })
        .catch(() => {});
    }
    store.trust?.refresh(userId)
      .then(() => { if (alive) setVerification(readVerification(store, userId, guildId)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [store, guildId, userId]);

  const myPerms = store.guildPermissions(guildId);
  const mayManageRoles = has(myPerms, 'MANAGE_ROLES');
  const mayModerate = ['MODERATE_MEMBERS', 'KICK_MEMBERS', 'BAN_MEMBERS']
    .some((p) => has(myPerms, p));

  const setRole = async (roleId, on) => {
    if (!api || roleBusy) return;
    setRoleBusy(roleId);
    try {
      const updated = await api.patchMember(guildId, userId, {
        [on ? 'add_roles' : 'remove_roles']: [roleId],
      });
      setHeld(updated.roles || []);
      store.onMember({ ...updated, guild_id: guildId, user_id: userId });
    } catch (e) {
      reportError(e, on ? 'Could not grant that role' : 'Could not remove that role');
    } finally { setRoleBusy(null); }
  };

  return {
    store,
    member,
    guild,
    live,
    domain,
    isMe,
    guest,
    identity,
    displayName,
    alias,
    avatarRef,
    accent,
    theme,
    bannerRef,
    mediaBase,
    mediaOrigin,
    roles,
    roleBusy,
    setRole,
    verification,
    setVerification,
    mayManageRoles,
    mayModerate,
  };
}
